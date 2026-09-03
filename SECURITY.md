# Security

This server holds a live session credential, so it deserves more care than a read-only API client.

`SUBSTACK_SESSION_TOKEN` is your `connect.sid` cookie. Anyone holding it can act as you on Substack for as long as it stays valid, which is roughly 90 days. It is read from the environment and never logged. The browser-login flow stores a session under `~/.substack-mcp/session.json` encrypted with a key derived from your OS account and hostname, so the file does not decrypt on another machine. If you think a token has leaked, log out of Substack to invalidate the session and mint a new one.

The default stdio transport puts the trust boundary at your user account: your MCP client spawns the process and nothing else can speak to it. `MCP_TRANSPORT=http` moves that boundary to the network — anything that can open a socket to the port can drive the server with your cookie. That listener rejects unknown `Host` and `Origin` values by default (loopback only) and caps request bodies, but those are anti-confused-deputy measures, not authentication: set `MCP_HTTP_TOKEN` if any other process on the host is not fully trusted. See "Transports" in the README.

The server talks to Substack's unofficial API. Endpoints can change without notice, and a change can alter what a tool does.

Long-form posts are draft-only by design: there is no publish and no delete tool. Notes are the exception, because Notes have no draft state on Substack. `create_note` and `create_note_with_link` publish immediately, with no preview and no undo. Treat them as public-publish actions when you decide what an agent is allowed to call.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab on this repo and click **Report a vulnerability**. Do not open a public issue for security problems.

I aim to respond within a week. Credit goes to the reporter in the fix notes unless you prefer otherwise.
