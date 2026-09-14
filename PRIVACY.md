# Privacy

substack-mcp is software you run yourself. The maintainer operates no hosted
service, receives none of your data, and the package contains no telemetry,
analytics or crash reporting.

## What the server sends, and where

| Destination | When | What is sent |
| --- | --- | --- |
| The Substack publication you configure | Every tool call and CLI command | Your Substack session cookie and the request needed for that operation: reading posts, drafts, statistics or subscribers; creating or updating drafts; uploading images; publishing Notes; adding consented free subscribers |
| `substack.com` | `substack-mcp login` only | You sign in through a local browser window; the resulting session cookie for your publication is saved locally |
| An image host you name | `upload_image` with `image_url` only | A plain HTTPS download request, without any Substack cookie or credential. The image is then uploaded to Substack's CDN, where anyone with the returned link can fetch it |

Content you give your AI assistant or client (for example draft text) passes
through that client under its own privacy terms. This server only sends it to
Substack when a tool you invoke requires it.

Nothing else is contacted. Substack's own handling of your data is governed by
Substack's terms and privacy policy.

## What is stored on your machine

- **Sessions and profiles.** `substack-mcp login` saves your publication URL,
  user ID and session cookie in `~/.substack-mcp` (or `SUBSTACK_MCP_HOME`),
  encrypted with a key derived from your OS account and machine. See
  [SECURITY.md](SECURITY.md) for its limits. Environment-variable credentials are
  read at startup and not written anywhere.
- **Files you ask for.** `export` writes the output paths you specify. Nothing
  else is written by the server or CLI.
- **Logs.** Credentials, cookies and private bodies are not logged; CLI errors
  omit upstream messages and response bodies.

## Optional components you deploy yourself

These are off unless you set them up:

- **Local calendar sync** (`calendar-sync`) reads Google Calendar booking emails
  through your own `gws` Gmail CLI, then adds consenting bookers as free
  subscribers. Its state file, which you place, contains those email addresses,
  signup answers and message IDs. See [docs/calendar-sync.md](docs/calendar-sync.md).
- **Cloud calendar sync** runs the same process in a Cloudflare Worker on your
  own Cloudflare account. It uses your Google authorization for Gmail, stores its
  consent ledger and run history in that Worker's Durable Object storage, and
  holds your credentials as your Cloudflare secrets. See
  [docs/cloud-calendar-sync.md](docs/cloud-calendar-sync.md).
- **HTTP transport** (`MCP_TRANSPORT=http`) listens on the address you choose.
  Anyone who can reach it can act with your session; see
  [docs/http-transport.md](docs/http-transport.md).

## Your control

- Revoke access by signing out of Substack, which invalidates the session cookie,
  and delete `~/.substack-mcp`.
- Uninstall the package to stop all activity; there is no background service
  unless you deployed one of the optional components above.
- Images uploaded to Substack's CDN and Notes you publish are public, and this
  server has no delete tools for them.

## Contact

Report privacy or security concerns through GitHub's private vulnerability
reporting on this repository (Security tab), as described in
[SECURITY.md](SECURITY.md).
