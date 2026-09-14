# Privacy

substack-mcp is software you run yourself. The maintainer operates no hosted
service and receives none of your data. The package contains no telemetry,
analytics or crash reporting.

## What the server and CLI send, and where

| Destination | When | What is sent |
| --- | --- | --- |
| The Substack publication you configure | MCP tool calls, and CLI commands that read or write Substack data (`status`, `--help` and other local commands make no request) | Your Substack session cookie and the request needed for that operation: reading posts, drafts, statistics or subscribers; creating or updating drafts; uploading images; publishing Notes; adding consented free subscribers |
| `substack.com` | `substack-mcp login` only | You sign in through a local browser window; the resulting session cookie for your publication is saved locally |
| The image host you name, and any host it redirects to | `upload_image` with `image_url` only | A plain HTTPS download request, with no Substack cookie or credential. Up to 3 HTTPS redirects are followed, including to other hosts; private and reserved network addresses are refused. The image is then uploaded to Substack's CDN, where anyone with the returned link can fetch it |

With the core server and CLI, those are the only destinations. The optional
components below contact other services when you set them up.

Content you give your AI assistant or client (for example draft text) passes
through that client under its own privacy terms. This server only sends it to
Substack when a tool you invoke requires it. Substack's handling of your data is
governed by Substack's terms and privacy policy.

## What is stored on your machine

- **Sessions and profiles.** `substack-mcp login` saves your publication URL,
  user ID, session cookie and the save time in `~/.substack-mcp`, or in the
  directory named by `SUBSTACK_MCP_HOME`. The file is encrypted with a key derived
  from your OS account and machine; see [SECURITY.md](SECURITY.md) for its limits.
  Credentials supplied through environment variables are read at startup and are
  not written to disk.
- **Files you ask for.** `export` writes the output paths you specify.
- **Logs and errors.** Session tokens and cookies are not printed. Error output
  can include messages returned by Substack or by the network layer (for example
  when authentication fails at startup or an export fails), so review error output
  before sharing it.

## Optional components you deploy yourself

These are off unless you set them up:

- **Local calendar sync** (`calendar-sync`) runs your own `gws` command-line tool
  to read Google Calendar booking emails from Gmail, then adds consenting bookers as
  free Substack subscribers. Gmail is contacted through `gws` under your Google
  authorization. Its state file, which you place, contains those email addresses,
  signup answers and message IDs. See [docs/calendar-sync.md](docs/calendar-sync.md).
- **Cloud calendar sync** runs the same process in a Cloudflare Worker on your
  own Cloudflare account. It sends your Google OAuth client credentials and
  refresh token to Google's token endpoint (`oauth2.googleapis.com`), reads booking
  emails and can send report emails through the Gmail API (`gmail.googleapis.com`),
  and calls your Substack publication. It stores its consent ledger and run history
  in the Worker's Durable Object storage and keeps your credentials as Cloudflare
  secrets. See [docs/cloud-calendar-sync.md](docs/cloud-calendar-sync.md).
- **HTTP transport** (`MCP_TRANSPORT=http`) listens on the address you choose and
  acts with your Substack session for requests it accepts. By default it accepts
  only loopback `Host` and `Origin` values; set `MCP_HTTP_TOKEN` to require a bearer
  token, and do not expose the port to untrusted networks. See
  [docs/http-transport.md](docs/http-transport.md).

## Your control

- Revoke access by signing out of Substack, which invalidates the session cookie,
  and delete the session directory: `~/.substack-mcp`, or your `SUBSTACK_MCP_HOME`
  directory if you set one.
- Uninstall the package to stop all activity. There is no background service
  unless you deployed one of the optional components above; revoke their Google
  authorization and Cloudflare secrets separately.
- Images uploaded to Substack's CDN and Notes you publish are public, and this
  server has no delete tools for them.

## Contact

Report privacy or security concerns through GitHub's private vulnerability
reporting on this repository (Security tab), as described in
[SECURITY.md](SECURITY.md).
