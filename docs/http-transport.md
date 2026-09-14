# HTTP transport

By default the server speaks MCP over **stdio** — the client spawns it as a subprocess per session, which is what the Claude Desktop and Claude Code configurations in the [README](../README.md#2-configure-your-mcp-client) assume.

For a persistent, network-reachable deployment (e.g. one server shared by multiple machines, connected to via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)), set `MCP_TRANSPORT=http`. This starts a stateless Streamable HTTP server instead:

- `POST /mcp` — the MCP endpoint
- `GET /health` — returns `{"status":"ok"}` for container healthchecks

```bash
docker run -d --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_ALLOWED_HOSTS=localhost:8080,127.0.0.1:8080 \
  -e MCP_HTTP_TOKEN="$(openssl rand -hex 32)" \
  -e SUBSTACK_PUBLICATION_URL=https://yourblog.substack.com \
  -e SUBSTACK_SESSION_TOKEN=your-session-token \
  -e SUBSTACK_USER_ID=your-user-id \
  substack-mcp
```

`MCP_HTTP_PORT` (default `8080`) and `MCP_HTTP_HOST` (default `0.0.0.0`, which is what makes a container reachable through `-p`) configure the listener. Each request gets its own server instance — there's no session state kept between requests, so nothing to lose if the container restarts.

## What this listener will accept

Over stdio the trust boundary is your user account. Over HTTP it is whatever can open a socket to the port — and every request that gets through carries your Substack session cookie, including `create_note`, which publishes immediately with no undo. The listener therefore starts closed and is opened deliberately:

| Variable | Default | Effect |
|---|---|---|
| `MCP_HTTP_ALLOWED_HOSTS` | loopback names for the bound port | Comma-separated `Host` allowlist. A request whose `Host` is not listed gets `403`. `*` disables the check. |
| `MCP_HTTP_ALLOWED_ORIGINS` | loopback origins for the bound port | Comma-separated `Origin` allowlist; `403` otherwise. A request with **no** `Origin` is always allowed — non-browser MCP clients don't send one. `*` disables the check. |
| `MCP_HTTP_TOKEN` | unset | When set, requires `Authorization: Bearer <token>`; `401` otherwise. |
| `MCP_HTTP_MAX_BODY_BYTES` | `10485760` (10 MiB) | Hard cap enforced while the body streams. Over-limit requests get `413`. |

Every one of these is checked before the request is handed to an MCP server, so a rejected request never reaches the Substack API.

Only origin-form request targets are served (`POST /mcp`, `GET /health`). An absolute-form target (`POST http://elsewhere/mcp`), a scheme-relative one (`POST //elsewhere/mcp`), or a malformed one all get `400` — none of them are routed, and none can take the process down.

**Reaching the server under any name other than loopback requires setting `MCP_HTTP_ALLOWED_HOSTS` yourself.** That is the DNS-rebinding defence: without it a page in your browser can resolve an attacker-controlled name to `127.0.0.1` and drive this server as you.

**Host and Origin checks are not authentication.** They stop a browser being used as a confused deputy; they do nothing about a process running on the same host, which can set any `Host` it likes and send no `Origin` at all. On a machine where anything else runs — another MCP server, a dev container, a shared box — set `MCP_HTTP_TOKEN`. Publish the port to `127.0.0.1` rather than every interface (`-p 127.0.0.1:8080:8080`), and put the service behind a VPN or private network as you would any other credentialed internal service.

Versioned GHCR images and transport verification: [container distribution](containers.md).
