# Cloudflare TCP Tunnel

基于 Cloudflare Workers 的轻量级 WebSocket → TCP 通用隧道，单文件部署，无需 Wrangler、npm 或独立服务器。

## 功能特性

- HTTP 心跳：返回 JSON 时间信息。
- WebSocket 隧道：转发客户端与目标服务器之间的 TCP 数据。
- Token 认证：连接前验证身份。
- 动态目标：认证时指定目标主机和端口。
- 原生 TCP：不修改上游协议，不额外封装业务数据。
- 超时控制：支持认证超时和 TCP 连接超时。
- 目标白名单：可限制允许访问的主机和端口。
- 资源控制：限制消息大小和待处理数据量。
- 纯 JavaScript：仅需 `index.js`。

## 部署方式

### 1. 创建 Worker

登录 Cloudflare Dashboard，进入 **Workers & Pages**，创建一个 Worker。

### 2. 粘贴代码

打开 Worker 在线代码编辑器，将完整程序粘贴到 `index.js`，保存并部署。

无需创建 `package.json`、`wrangler.toml` 或其他文件。

### 3. 配置环境变量

进入 Worker 的 **Settings → Variables and Secrets**，添加以下变量：

| 变量名 | 类型 | 说明 |
|---|---|---|
| `AUTH_TOKEN` | Secret | 客户端认证密钥，建议使用 32 字节以上的随机密钥 |
| `ALLOWED_TARGETS` | Text，可选 | 目标主机与端口白名单 |

生成随机密钥：

```bash
openssl rand -hex 32
```

将生成的密钥设置为 `AUTH_TOKEN`。

白名单示例：

```json
{
  "pool.example.com": [7048, 443],
  "another-pool.example.com": [3333]
}
```

启用白名单后，仅允许配置中列出的主机和端口组合。未设置 `ALLOWED_TARGETS` 时，程序会允许通过基本校验的公网目标。

### 4. 访问心跳接口

部署完成后，访问：

```text
https://你的-worker 域名/heartbeat
```

例如：

```text
https://example.workers.dev/heartbeat
```

正常响应：

```json
{
  "ok": true,
  "service": "heartbeat",
  "time": "2026-10-14T12:00:00.000Z",
  "timestamp": 1791979200000
}
```

其他路径返回 HTTP 404。

## WebSocket 通信协议

### 连接地址

```text
wss://你的-worker域名/heartbeat
```

### 第一步：发送认证消息

连接成功后，第一条消息必须是文本 JSON：

```json
{
  "type": "connect",
  "token": "你的AUTH_TOKEN",
  "host": "pool.example.com",
  "port": 7048
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `type` | 固定为 `connect` |
| `token` | 与 Worker 配置的 `AUTH_TOKEN` 一致 |
| `host` | 目标服务器域名或公网 IPv4 地址 |
| `port` | 目标 TCP 端口，范围为 1–65535 |

认证必须在 15 秒内完成。

### 第二步：等待连接成功

TCP 连接成功后，服务端返回：

```json
{
  "type": "connected"
}
```

连接失败时，服务端会返回错误 JSON 或关闭 WebSocket。

### 第三步：转发原始数据

连接成功后：

- 客户端发送 WebSocket 二进制帧，Worker 将数据写入目标 TCP 连接。
- Worker 收到目标 TCP 数据后，通过 WebSocket 二进制帧返回客户端。
- 不再使用 JSON 封装业务数据。
- 不添加 SOCKS5 握手、额外协议头或应用层加密。

客户端应将数据视为连续字节流，不能假设一个 WebSocket 帧对应一个 TCP 数据包。

## 超时与数据限制

| 参数 | 默认值 |
|---|---:|
| 认证超时 | 15 秒 |
| TCP 连接超时 | 10 秒 |
| 认证消息上限 | 8 KiB |
| 单个数据帧上限 | 1 MiB |
| 待处理数据上限 | 4 MiB |

这些参数直接在 `index.js` 顶部修改，修改后重新部署即可。

## 安全说明

1. `AUTH_TOKEN` 应使用高强度随机值，并通过 Secret 保存。
2. 生产环境建议配置 `ALLOWED_TARGETS`，避免向不可信客户端开放任意 TCP 转发。
3. 域名格式校验不能保证 DNS 解析结果一定是公网 IP。
4. 客户端与 Worker 之间使用 `wss://` 时，传输由 HTTPS/TLS 保护；Worker 到目标服务器之间仍是普通 TCP。
5. 本程序只支持 TCP，不支持 UDP。
6. 实际连接时长、并发量和吞吐量受 Cloudflare Workers 平台限制影响。

## 项目结构

```text
Cloudflare TCP Tunnel
└── index.js
```

部署只需要一个 `index.js` 文件和 Cloudflare 控制台中的环境变量，无需其他项目文件。
