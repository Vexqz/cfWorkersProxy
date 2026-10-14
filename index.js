
import { connect } from "cloudflare:sockets";

const PATH = "/heartbeat";

const AUTH_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;

const MAX_AUTH_SIZE = 8 * 1024;
const MAX_FRAME_SIZE = 1024 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

const encoder = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isPublicIPv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map(Number);

  if (
    octets.some(
      (n, i) =>
        !Number.isInteger(n) ||
        n < 0 ||
        n > 255 ||
        String(n) !== parts[i]
    )
  ) {
    return false;
  }

  const [a, b, c] = octets;

  // 拒绝非公网、保留和特殊用途 IPv4 地址。
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return false;
  }

  return true;
}

function validHost(host) {
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    host.length > 253 ||
    host !== host.trim() ||
    host.endsWith(".") ||
    host.includes("://") ||
    host.includes("/") ||
    host.includes("\\") ||
    host.includes(":") ||
    host.includes("@")
  ) {
    return false;
  }

  const lower = host.toLowerCase();

  // 拒绝常见本机和内部域名。
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower === "metadata.google.internal" ||
    lower === "metadata.google"
  ) {
    return false;
  }

  // 数字和点组成的主机名必须是合法公网 IPv4。
  if (/^[0-9.]+$/.test(host)) {
    return isPublicIPv4(host);
  }

  // 仅允许 ASCII DNS 域名，不接受 IP 的其他写法。
  const labels = lower.split(".");

  if (labels.length < 2) return false;

  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

// 固定长度比较，减少 Token 比较过程中的长度和逐字符时序差异。
// JavaScript 无法保证真正的恒定时间执行。
function safeTokenEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const aa = encoder.encode(a);
  const bb = encoder.encode(b);

  let diff = aa.length ^ bb.length;
  const len = Math.max(aa.length, bb.length);

  for (let i = 0; i < len; i++) {
    diff |= (aa[i] || 0) ^ (bb[i] || 0);
  }

  return diff === 0;
}

function targetAllowed(host, port, env) {
  // 未设置白名单时保留原有行为：允许访问通过校验的公网目标。
  // 生产环境建议设置 ALLOWED_TARGETS。
  if (env.ALLOWED_TARGETS === undefined) {
    return true;
  }

  let targets;

  try {
    targets = JSON.parse(env.ALLOWED_TARGETS);
  } catch {
    return false;
  }

  if (
    !targets ||
    typeof targets !== "object" ||
    Array.isArray(targets)
  ) {
    return false;
  }

  const ports = targets[host];

  return (
    Array.isArray(ports) &&
    ports.some((p) => Number.isInteger(p) && p === port)
  );
}

function safeSend(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  } catch {
    // WebSocket 可能已断开。
  }
}

function safeClose(ws, code = 1000, reason = "closed") {
  try {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close(code, reason.slice(0, 100));
    }
  } catch {
    // 忽略重复关闭。
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== PATH) {
      return json(
        {
          ok: false,
          error: "NOT_FOUND",
          time: new Date().toISOString(),
          timestamp: Date.now(),
        },
        404
      );
    }

    // 普通 HTTP 请求只返回时间 JSON。
    if (
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return json({
        ok: true,
        service: "heartbeat",
        time: new Date().toISOString(),
        timestamp: Date.now(),
      });
    }

    if (
      typeof env.AUTH_TOKEN !== "string" ||
      env.AUTH_TOKEN.length < 16
    ) {
      return json(
        {
          ok: false,
          error: "SERVER_AUTH_NOT_CONFIGURED",
        },
        500
      );
    }

    // 拒绝明显不合法的 WebSocket 握手。
    if (request.method !== "GET") {
      return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const ws = pair[1];

    ws.accept();
    ws.binaryType = "arraybuffer";

    let phase = "auth";
    let closed = false;

    let socket = null;
    let reader = null;
    let writer = null;

    let authTimer = null;
    let connectTimer = null;

    // 串行处理消息，避免 TCP 写入并发。
    let writeChain = Promise.resolve();

    // 限制等待处理的数据量，避免消息无限积压。
    let pendingBytes = 0;

    function clearTimers() {
      if (authTimer !== null) {
        clearTimeout(authTimer);
        authTimer = null;
      }

      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    }

    function cleanup(code = 1000, reason = "closed") {
      if (closed) return;

      closed = true;
      phase = "closed";

      clearTimers();

      // 先关闭底层 TCP，尽快中断正在进行的读写。
      const currentSocket = socket;
      socket = null;

      if (currentSocket) {
        try {
          void currentSocket.close().catch(() => {});
        } catch {
          // 忽略关闭异常。
        }
      }

      if (reader) {
        const currentReader = reader;
        reader = null;

        try {
          void currentReader.cancel().catch(() => {});
        } catch {
          // 忽略取消异常。
        }
      }

      if (writer) {
        const currentWriter = writer;
        writer = null;

        try {
          void currentWriter.abort().catch(() => {});
        } catch {
          // 忽略取消异常。
        }
      }

      safeClose(ws, code, reason);
    }

    function fail(error, reason = error) {
      safeSend(ws, { type: "error", code: error });
      cleanup(1008, reason);
    }

    async function connectTarget(host, port) {
      phase = "connecting";

      let timedOut = false;

      try {
        // 纯 TCP，不启用 TLS。
        socket = connect(
          { hostname: host, port },
          { secureTransport: "off" }
        );

        const currentSocket = socket;

        await Promise.race([
          currentSocket.opened,
          new Promise((_, reject) => {
            connectTimer = setTimeout(() => {
              timedOut = true;
              reject(new Error("CONNECT_TIMEOUT"));
            }, CONNECT_TIMEOUT_MS);
          }),
        ]);

        if (connectTimer !== null) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }

        if (closed || socket !== currentSocket) {
          try {
            void currentSocket.close().catch(() => {});
          } catch {}

          return;
        }

        reader = currentSocket.readable.getReader();
        writer = currentSocket.writable.getWriter();

        phase = "connected";

        safeSend(ws, { type: "connected" });

        // 上游 TCP -> WebSocket 二进制帧。
        // 大块数据拆分，避免单个 WebSocket 消息过大。
        void (async () => {
          try {
            while (!closed) {
              const { value, done } = await reader.read();

              if (done) break;
              if (!value || value.byteLength === 0) continue;

              for (
                let offset = 0;
                offset < value.byteLength;
                offset += MAX_FRAME_SIZE
              ) {
                if (
                  closed ||
                  ws.readyState !== WebSocket.OPEN
                ) {
                  break;
                }

                const end = Math.min(
                  offset + MAX_FRAME_SIZE,
                  value.byteLength
                );

                ws.send(value.slice(offset, end));
              }
            }
          } catch {
            // TCP 读取或 WebSocket 发送失败。
          } finally {
            cleanup(1000, "upstream closed");
          }
        })();
      } catch {
        if (connectTimer !== null) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }

        if (closed) return;

        safeSend(ws, {
          type: "error",
          code: timedOut ? "CONNECT_TIMEOUT" : "CONNECT_FAILED",
        });

        cleanup(1011, "tcp connection failed");
      }
    }

    async function handleMessage(data) {
      if (closed) return;

      if (phase === "auth") {
        if (typeof data !== "string") {
          fail("AUTH_REQUIRED");
          return;
        }

        if (encoder.encode(data).byteLength > MAX_AUTH_SIZE) {
          fail("AUTH_MESSAGE_TOO_LARGE");
          return;
        }

        let msg;

        try {
          msg = JSON.parse(data);
        } catch {
          fail("INVALID_JSON");
          return;
        }

        if (
          !msg ||
          typeof msg !== "object" ||
          msg.type !== "connect" ||
          typeof msg.token !== "string" ||
          typeof msg.host !== "string" ||
          !Number.isInteger(msg.port) ||
          msg.port < 1 ||
          msg.port > 65535
        ) {
          fail("INVALID_AUTH_MESSAGE");
          return;
        }

        if (!safeTokenEqual(msg.token, env.AUTH_TOKEN)) {
          fail("AUTH_FAILED");
          return;
        }

        const host = msg.host.toLowerCase();
        const port = msg.port;

        if (!validHost(host)) {
          fail("INVALID_TARGET");
          return;
        }

        if (!targetAllowed(host, port, env)) {
          fail("TARGET_NOT_ALLOWED");
          return;
        }

        if (authTimer !== null) {
          clearTimeout(authTimer);
          authTimer = null;
        }

        await connectTarget(host, port);
        return;
      }

      if (phase !== "connected") {
        cleanup(1008, "connection not ready");
        return;
      }

      // 认证后只接受二进制帧。
      if (!(data instanceof ArrayBuffer)) {
        cleanup(1003, "binary frames only");
        return;
      }

      if (data.byteLength > MAX_FRAME_SIZE) {
        cleanup(1009, "frame too large");
        return;
      }

      if (data.byteLength === 0) return;

      if (!writer) {
        cleanup(1011, "tcp writer unavailable");
        return;
      }

      // 复制当前帧，确保排队写入期间数据不被外部修改。
      const chunk = new Uint8Array(data.slice(0));

      try {
        await writer.write(chunk);
      } catch {
        cleanup(1011, "tcp write failed");
      }
    }

    // 首帧必须在规定时间内完成认证。
    authTimer = setTimeout(() => {
      if (phase === "auth" && !closed) {
        safeSend(ws, {
          type: "error",
          code: "AUTH_TIMEOUT",
        });

        cleanup(1008, "authentication timeout");
      }
    }, AUTH_TIMEOUT_MS);

    ws.addEventListener("message", (event) => {
      if (closed) return;

      const data = event.data;

      // 对已收到但尚未处理的消息实施背压限制。
      const size =
        data instanceof ArrayBuffer
          ? data.byteLength
          : typeof data === "string"
            ? encoder.encode(data).byteLength
            : 0;

      pendingBytes += size;

      if (pendingBytes > MAX_PENDING_BYTES) {
        cleanup(1008, "pending data limit exceeded");
        return;
      }

      writeChain = writeChain
        .then(() => handleMessage(data))
        .catch(() => {
          cleanup(1011, "proxy error");
        })
        .finally(() => {
          pendingBytes = Math.max(0, pendingBytes - size);
        });
    });

    ws.addEventListener("close", () => {
      cleanup(1000, "client closed");
    });

    ws.addEventListener("error", () => {
      cleanup(1011, "websocket error");
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  },
};
