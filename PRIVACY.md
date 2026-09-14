# Privacy

substack-mcp is software you run yourself. The maintainer operates no hosted
service and receives none of your data. The package contains no telemetry,
analytics or crash reporting.

## What the server and CLI send, and where

| Destination | When | What is sent |
| --- | --- | --- |
| The Substack publication you configure | MCP tool calls, and CLI commands that read or write Substack data (`status`, `--help` and other local commands make no request) | Your Substack session cookie and the request needed for that operation: reading posts, drafts, statistics or subscribers; creating or updating drafts; uploading images; publishing Notes; adding consented free subscribers |
| The public page of your publication, and any host it redirects to | The subscriber-count read, when Substack's API does not return a count | A plain HTTPS request with no cookie or credential. Up to 3 HTTPS redirects are followed, including to other hosts |
| `substack.com`, your publication, and whatever those pages load | `substack-mcp login` only | You sign in through a local browser window, which behaves like any browser: it follows the pages' redirects and loads the resources they request, including third-party hosts. The resulting session cookie for your publication is saved locally |
| The image host you name, and any host it redirects to | `upload_image` with `image_url` only | A plain HTTPS download request, with no Substack cookie or credential. Up to 3 HTTPS redirects are followed, including to other hosts; private and reserved network addresses are refused. The image is then uploaded to Substack's CDN, where anyone with the returned link can fetch it |

With the core server and CLI, those are the only destinations. The optional
components below contact other services when you set them up.

Your MCP client or AI assistant is a separate party. Content you give it (for
example draft text) and every tool result the server returns to it (including
private drafts, posts, statistics, subscriber records and error messages) are
handled under that client's privacy terms. The CLI prints results to your terminal
or to files you redirect it to. This server only sends your content to Substack
when a tool you invoke requires it. Substack's handling of your data is
governed by Substack's terms and privacy policy.

## What is stored on your machine

- **Sessions and profiles.** `substack-mcp login` saves your publication URL,
  user ID, session cookie and the save time in `~/.substack-mcp`, or in the
  directory named by `SUBSTACK_MCP_HOME`. The file is encrypted with a key derived
  from your OS account and machine; see [SECURITY.md](SECURITY.md) for its limits.
  Saving a named profile first writes the encrypted file to a temporary
  `.profile-<id>.tmp` in the same directory and then removes it; if that cleanup
  fails (the CLI reports it), the encrypted temporary copy can remain. Credentials supplied through
  environment variables are read at startup and are not written to disk.
- **Files you ask for.** `export` writes the output path you specify. Markdown
  export also writes `<path>.source.json` beside it, containing the complete
  export bundle including the original draft body. Each file is written through a
  temporary file in the same directory; if cleanup fails, the CLI reports it and
  the temporary copy can remain.
- **Logs and errors.** Session tokens and cookies are not printed. Error output
  can include messages returned by Substack or by the network layer (for example
  when authentication fails at startup or an export fails), so review error output
  before sharing it.

## Optional components you deploy yourself

These are off unless you set them up:

- **Local calendar sync** (`calendar-sync`) runs your own `gws` command-line tool
  to read Google Calendar booking emails from Gmail, then adds consenting bookers as
  free Substack subscribers. Gmail is contacted through `gws` under your Google
  authorization. Its state file, which you place, contains the publication and
  organizer, bookers' email addresses, signup answers, source message IDs, and a
  record of each subscriber attempt with its status and time. Each save is written
  first to `<state_path>.new`; if writing or renaming fails, that copy can remain. See [docs/calendar-sync.md](docs/calendar-sync.md).
- **Cloud calendar sync** runs the same process in a Cloudflare Worker on your
  own Cloudflare account. It sends your Google OAuth client credentials and
  refresh token to Google's token endpoint (`oauth2.googleapis.com`), reads booking
  emails and can send report emails through the Gmail API (`gmail.googleapis.com`),
  and calls your Substack publication. Its Durable Object storage holds the consent
  ledger, run history, enabled and initialization state, and report delivery
  records (attempt times, status and the Gmail message ID of sent reports). Your
  credentials are kept as Cloudflare secrets. See [docs/cloud-calendar-sync.md](docs/cloud-calendar-sync.md).
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
