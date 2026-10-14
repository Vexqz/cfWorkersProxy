# Cloudflare TCP Tunnel

A lightweight WebSocket-to-TCP tunnel built with Cloudflare Workers. Deploy directly from the Cloudflare Dashboard using a single `index.js` file. No Wrangler, npm, or standalone server required.

## Features

- **HTTP Heartbeat:** Returns the current time as JSON.
- **WebSocket Tunnel:** Forwards data between WebSocket clients and TCP servers.
- **Token Authentication:** Authenticates clients before establishing TCP connections.
- **Dynamic Targets:** Specify the target hostname and port during authentication.
- **Native TCP Forwarding:** Preserves application data without additional protocol headers or payload encoding.
- **Timeout Protection:** Configurable authentication and TCP connection timeouts.
- **Target Allowlist:** Optionally restrict access to approved hostnames and ports.
- **Resource Limits:** Limits authentication message size, individual data frames, and pending data.
- **Single-File Deployment:** Requires only `index.js`.

## Deployment

### 1. Create a Worker

Log in to the Cloudflare Dashboard, navigate to **Workers & Pages**, and create a new Worker.

### 2. Deploy the Code

Open the Worker editor, replace the contents of `index.js` with the complete source code, then save and deploy.

No `package.json`, `wrangler.toml`, or additional project files are required.

### 3. Configure Environment Variables

Navigate to **Settings → Variables and Secrets** and configure the following variables.

| Variable | Type | Description |
|---|---|---|
| `AUTH_TOKEN` | Secret | Authentication token. Use a cryptographically random value of at least 32 bytes. |
| `ALLOWED_TARGETS` | Text, optional | JSON allowlist of permitted target hostnames and TCP ports. |

Generate a random token:

```bash
openssl rand -hex 32
```

Set the generated value as `AUTH_TOKEN`.

Example `ALLOWED_TARGETS` configuration:

```json
{
  "pool.example.com": [7048, 443],
  "another-pool.example.com": [3333]
}
```

When the allowlist is configured, only the specified hostname and port combinations are permitted.

If `ALLOWED_TARGETS` is not configured, the Worker allows targets that pass its built-in hostname and IP validation. For production deployments, enabling the allowlist is strongly recommended.

### 4. Test the Heartbeat Endpoint

Open the following URL in a browser:

```text
https://your-worker-domain/heartbeat
```

Example:

```text
https://example.workers.dev/heartbeat
```

Successful response:

```json
{
  "ok": true,
  "service": "heartbeat",
  "time": "2026-10-14T12:00:00.000Z",
  "timestamp": 1791979200000
}
```

Requests to other paths return HTTP 404.

## WebSocket Protocol

### Connection URL

Connect to the following endpoint using WebSocket:

```text
wss://your-worker-domain/heartbeat
```

### Step 1: Send the Authentication Message

Immediately after establishing the WebSocket connection, send a text message containing a JSON object:

```json
{
  "type": "connect",
  "token": "YOUR_AUTH_TOKEN",
  "host": "pool.example.com",
  "port": 7048
}
```

Field descriptions:

| Field | Description |
|---|---|
| `type` | Must be `connect`. |
| `token` | Must match the configured `AUTH_TOKEN`. |
| `host` | Target hostname or public IPv4 address. |
| `port` | Target TCP port, from 1 to 65535. |

Authentication must complete within 15 seconds.

### Step 2: Wait for Connection Confirmation

After the TCP connection is established successfully, the Worker sends:

```json
{
  "type": "connected"
}
```

If the connection fails, the Worker may return a JSON error or close the WebSocket connection.

### Step 3: Forward Raw Data

After receiving the `connected` response:

- Send application data as WebSocket binary frames.
- The Worker forwards client data to the target TCP connection.
- Data received from the TCP server is forwarded to the client as WebSocket binary frames.
- No JSON wrapping is applied to application data after authentication.
- No SOCKS5 handshake, additional application protocol header, or extra application-layer encryption is added.

**Important:** WebSocket frame boundaries do not correspond to TCP message boundaries. Clients must treat received data as a continuous byte stream and must not assume that one WebSocket frame equals one TCP packet or application message.

## Timeouts and Data Limits

| Parameter | Default |
|---|---:|
| Authentication timeout | 15 seconds |
| TCP connection timeout | 10 seconds |
| Maximum authentication message size | 8 KiB |
| Maximum individual data frame size | 1 MiB |
| Maximum pending data | 4 MiB |

These parameters are defined directly in `index.js`. Modify the constants and redeploy the Worker to change them.

## Security Considerations

### Authentication

- Use a strong, randomly generated token.
- Store `AUTH_TOKEN` as a Cloudflare Secret.
- Never commit real authentication tokens to public repositories.
- Rotate the token periodically when appropriate.

### Target Restrictions

The Worker performs basic hostname validation and rejects several non-public IPv4 address ranges. However, hostname validation alone cannot guarantee that DNS resolution will return a public IP address.

For production use:

- Configure `ALLOWED_TARGETS`.
- Permit only trusted destination hostnames and ports.
- Avoid exposing unrestricted TCP forwarding to untrusted clients.
- Consider DNS resolution changes and the trustworthiness of destination domains.

### Transport Encryption

When clients connect through `wss://`, traffic between the client and Cloudflare is protected by TLS.

The Worker-to-target connection uses ordinary TCP with TLS disabled. If the upstream service requires encryption, use its native TLS protocol or implement a separate secure transport design.

### Resource Management

The Worker limits individual frame sizes and pending data, but these limits do not constitute a complete connection quota, bandwidth quota, or total traffic limit.

Actual connection duration, concurrency, and throughput are subject to Cloudflare Workers platform capabilities and applicable account limits.

## Known Limitations

- TCP only; UDP is not supported.
- No SOCKS5 compatibility.
- No built-in connection pool or automatic target failover.
- Automatic reconnection must be implemented by the client.
- Application-level TCP protocols are forwarded without inspection or modification.
- WebSocket frames are not equivalent to TCP packets or application messages.
- Hostname validation alone does not prevent DNS-based access to private or internal addresses.
- Performance and connection availability depend on Cloudflare platform limits and network conditions.

## Project Structure

```text
Cloudflare TCP Tunnel/
└── index.js
```

The entire application runs from a single JavaScript file. Deployment and configuration are managed through the Cloudflare Dashboard.

## License

Choose and add an appropriate open-source license based on your intended distribution and usage.
