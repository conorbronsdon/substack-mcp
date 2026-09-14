<div align="center">

# substack-mcp

Create and manage your Substack newsletter from your AI assistant or terminal. Prepare rich drafts, search your archive, publish Notes, inspect analytics, and manage explicitly consented free subscribers across publications. Review and publish long-form posts in Substack.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Language: TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/@conorbronsdon/substack-mcp?style=flat-square)](https://www.npmjs.com/package/@conorbronsdon/substack-mcp)
[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-1f6feb?style=flat-square)](https://modelcontextprotocol.io/)
[![HOL Plugin Security Scan](https://github.com/conorbronsdon/substack-mcp/actions/workflows/hol-plugin-scanner.yml/badge.svg)](https://github.com/conorbronsdon/substack-mcp/actions/workflows/hol-plugin-scanner.yml)
[![Podcast](https://img.shields.io/badge/Podcast-Chain_of_Thought-purple?style=flat-square)](https://chainofthought.show/?utm_source=github&utm_medium=referral&utm_campaign=repo-readme&utm_content=substack-mcp)
[![X](https://img.shields.io/badge/X-@ConorBronsdon-black?style=flat-square&logo=x)](https://x.com/ConorBronsdon)

</div>

---

![Create, search, export, plan and review a draft with substack-mcp](https://raw.githubusercontent.com/conorbronsdon/substack-mcp/4091ae0f64a5db7e9670aa9bdbe4693a32fadb23/docs/workflow-demo.gif)

The demo runs actual MCP handlers against offline sample data. No live API calls or publication occur. Follow the [draft workflow](docs/workflow.md) to create, find, export and review a post.

**Safe by design — with one loud exception:** This server cannot publish or delete long-form posts. Post tools create and edit drafts only; you review and publish manually through Substack's editor. The exception is Substack **Notes**: `create_note` and `create_note_with_link` publish short-form Notes immediately, because Notes have no draft state on Substack. Treat the Note tools as public-publish actions — there is no preview step and no undo from this server. The split is proportionate review, the piece of trust infrastructure for agents this server cares most about: the high-stakes surface gets a human gate, and the exception is stated loudly.

This server imposes no Bestseller-status check. Use an authenticated account with permission to manage the publication; individual operations depend on your Substack access. Connect through local stdio or self-hosted HTTP.

<a href="https://glama.ai/mcp/servers/conorbronsdon/substack-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/conorbronsdon/substack-mcp/badge" alt="substack-mcp MCP server" />
</a>

For 1.0 setup coverage and account eligibility, see [compatibility](docs/compatibility.md). Maintainers can use the [release checklist](docs/release-checklist.md) and [distribution inventory](docs/distribution.md).

**Contents:** [Quick start](#quick-start) · [Setup](#setup) · [Tools](#tools) · [Operator CLI](docs/operator-cli.md) · [Draft workflow](docs/workflow.md) · [Export](docs/export.md) · [Markdown](docs/authoring.md) · [Multiple publications](#multiple-publications) · [Transports](docs/http-transport.md) · [Compatibility](docs/compatibility.md)

## Quick start

1. **Install and sign in.** Browser login needs the optional Playwright dependency:

   ```bash
   npm install @conorbronsdon/substack-mcp playwright
   npx playwright install chromium
   npx substack-mcp login https://yourblog.substack.com --user-id 12345
   ```

   Use your own account's user ID. The session is saved only after a bounded
   authenticated read succeeds. To paste credentials instead, see
   [Option B](#option-b--get-your-credentials-manually).
2. **Verify a read.** `npx substack-mcp doctor --json --check-auth` makes one
   bounded read per publication. It confirms read access, not your user ID or
   write permission.
3. **Connect your MCP client.** Add the server to
   [Claude Desktop or Claude Code](#2-configure-your-mcp-client), or use the
   [Codex plugin](#codex-plugin). Environment variables take precedence; omit
   them to use the stored browser-login session. Then ask your assistant:
   "How many Substack subscribers do I have?"
4. **Prepare a draft for review.** Follow the [draft workflow](docs/workflow.md):
   `create_draft`, `search_posts`, `export_draft`, `preflight_draft`, then
   `plan_draft_update` and `update_draft`. Long-form posts stay unpublished
   drafts until you publish them in Substack's editor. `create_note` and
   `create_note_with_link` publish immediately.

## Setup

Requires **Node.js 22 or newer** (CI covers Node 22 and 24). Browser login additionally requires Playwright.

You can supply credentials two ways: paste them as env vars (below), or run the
optional **browser login** which captures and stores them for you.

### Option A — Browser login (optional, no manual cookie copying)

Install the server and optional Playwright dependency together in a local tools
directory, then sign in:

```bash
npm install @conorbronsdon/substack-mcp playwright
npx playwright install chromium
npx substack-mcp login https://yourblog.substack.com --user-id 12345
```

`substack-mcp-login` remains a supported alias. Missing publication URL and user
ID are prompted. Supply your own account's user ID; a post author's byline does
not verify your identity. The browser opens for sign-in, including any CAPTCHA.
Only a cookie applicable to the publication API is captured, and a bounded
authenticated read must succeed before saving. This verifies read access, not
the configured user ID or permission to write.

Without `--profile`, login saves `~/.substack-mcp/session.json` (directory override:
`SUBSTACK_MCP_HOME`). The server uses this legacy session when publication
credential environment variables and `SUBSTACK_PROFILES` are unset.

**Storage:** sessions use AES-256-GCM with a key derived from the OS account and
machine. File permissions request `0600`; Windows access also depends on directory
ACLs. This is a machine-bound file, not an OS keychain or secret vault. Code
running as your OS user can derive the key. Use environment credentials if your
MCP client manages secrets for you.

#### Named profiles and migration

```bash
npx substack-mcp login https://yourblog.substack.com --user-id 12345 --profile work
npx substack-mcp profiles list
# Copy an existing legacy session without changing its file:
npx substack-mcp profiles migrate --name personal
```

Keys start with a lowercase ASCII letter and contain only lowercase letters,
digits and hyphens, up to 64 characters. Existing profiles require explicit
`--force` to replace. List output contains keys, readability status, publication origins and file save
times; it excludes cookies and user IDs. Unreadable profiles remain visible but
cannot be selected. Save time records local persistence, including migration; it
is not token issuance or expiration time. Listing is bounded to 32 profiles.

Profile storage requires a local filesystem supporting hard links (such as NTFS
or a typical Linux filesystem), so creation can install a complete encrypted file
without overwriting an existing name. FAT/exFAT and some network mounts are not
supported: set `SUBSTACK_MCP_HOME` to a suitable local directory. Do not use
`--force` to work around an unsupported filesystem.

Set `SUBSTACK_PROFILES=work,personal` in your MCP client's environment to select
up to 32 distinct profiles. Remove all publication credential variables first:
combining profile selection with legacy or named credential variables is an
error, including empty variables. Missing, corrupt or invalid selected profiles
stop startup; they never fall back to another account. Profiles on disk are
never activated by discovery. With multiple profiles, tools require an explicit
publication key and CLI reads require `--publication`.

To roll back, unset `SUBSTACK_PROFILES` and restore your previous environment
configuration. Migration preserves the legacy session byte-for-byte. These files
use the existing encryption format; an OS keychain is not currently supported.
Run `substack-mcp status --json` for offline configuration diagnostics or
`substack-mcp doctor --check-auth --json` for a bounded read per selected account.

### Option B — Get your credentials manually

Open your Substack in a browser, then:

1. **Session token:** Navigate to your publication, open DevTools → Application → Cookies → copy the value of `connect.sid` (URL-encoded string starting with `s%3A`)
2. **User ID:** Use the numeric ID of your signed-in Substack account from your authenticated account data. Do not use a publication post's byline ID: publications can have multiple authors. This server does not independently verify the supplied ID.
3. **Publication URL:** Your Substack URL, including custom domain if you have one (e.g., `https://newsletter.yourdomain.com` or `https://yourblog.substack.com`)

### 2. Configure your MCP client

#### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "substack": {
      "command": "npx",
      "args": ["-y", "@conorbronsdon/substack-mcp"],
      "env": {
        "SUBSTACK_PUBLICATION_URL": "https://yourblog.substack.com",
        "SUBSTACK_SESSION_TOKEN": "your-session-token",
        "SUBSTACK_USER_ID": "your-user-id"
      }
    }
  }
}
```

[Claude Code and Codex plugin setup](docs/plugins.md) is available alongside
manual MCP configuration. The repository marketplace and local plugin are
separate from curated-directory acceptance or hosted ChatGPT support.

#### Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "substack": {
      "command": "npx",
      "args": ["-y", "@conorbronsdon/substack-mcp"],
      "env": {
        "SUBSTACK_PUBLICATION_URL": "https://yourblog.substack.com",
        "SUBSTACK_SESSION_TOKEN": "your-session-token",
        "SUBSTACK_USER_ID": "your-user-id"
      }
    }
  }
}
```

### 3. Verify

Ask your AI assistant: "How many Substack subscribers do I have?"

Tool output compatibility, response limits and versioning are documented in
[the tool contract](docs/tool-contract.md).

### Operator diagnostics

The CLI exposes read commands and configuration checks through the same MCP
handlers and credential resolution as the server:

```sh
substack-mcp status --json
substack-mcp doctor --json --check-auth
substack-mcp drafts list --limit 10
```

Commands, the JSON envelope, exit codes, request deadlines and response limits
are documented in [operator CLI and diagnostics](docs/operator-cli.md).

## Tools

Every tool declares explicit MCP side-effect annotations; see
[tool annotations](docs/tool-contract.md#tool-annotations). Tool descriptions carry the
authoritative wording.

### Read

| Tool | Description |
|------|-------------|
| `get_subscriber_count` | Get your publication's current subscriber count |
| `list_subscribers` | Read a bounded page of private subscriber records |
| `get_subscriber` | Look up membership by exact email; reconcile pending additions |
| `list_published_posts` | List published posts with pagination |
| `get_publication` | Read projected publication identity/settings, verify the configured host, and report missing fields; does not verify account identity or role |
| `list_publication_tags` | Read tag definitions, including hidden tags by default, with bounded local pagination |
| `get_post_tags` | Resolve post tag associations; preserves unresolved IDs and reports empty-result identity uncertainty. Draft coverage is currently live-verified only for empty responses |
| `search_posts` | Search a publication archive by query and status; bounded pages with continuation metadata |
| `plan_draft_update` | Review proposed changes, preflight and a receipt for best-effort stale detection; no writes |
| `export_draft` | Editable Markdown, exact original body, conversion diagnostics, preflight and editor link |
| `preflight_draft` | Read-only checks for title, audience, body structure, images, and paywalls, with an editor link |
| `list_drafts` | List draft posts |
| `get_post` | Get full content of a published post by ID |
| `get_draft` | Get full content of a draft by ID |
| `get_post_comments` | Get comments on a published post |
| `get_sections` | List your publication's sections (categories) with their IDs |
| `get_post_analytics` | Get a published post's stats (views, opens, signups, subscribes, reactions) by ID |
| `list_scheduled_posts` | List posts scheduled for future publication (read-only; scheduling stays in Substack's editor) |

### Archive search and draft review

`search_posts` accepts `query` (1–500 characters), `status` (`published`, `drafts`,
or `scheduled`, default `published`), `offset` (default 0), and `limit` (1–50,
default 25). It makes one authenticated archive request and returns projected
metadata, `returned`, `total`, `has_more`, and `next_offset`. Continue with
`next_offset` and the same query/status. When Substack omits the total and a
page is full, `has_more` is null (unknown); another page may be empty. Substack
controls matching and indexing: this is not a guaranteed full-text scan. Use
`get_post` or `get_draft` to retrieve full content. Pagination is not a snapshot;
concurrent edits can move results between pages.

`preflight_draft` accepts `draft_id`, reads it once, and returns `checks_passed`,
findings with severity/code/message, content counts and an editor link. It checks title,
audience, JSON/body shape, image wrappers and HTTPS sources, and paywall count
and edge placement. Unknown nodes and external images produce review warnings.
Bodies over two million characters, 10,000 nodes, or depth 100 are not fully
checked; `counts.complete` is false and aggregate checks are skipped after a
scan limit. Unknown-node warnings name up to five types for editor review.
This is a focused static check, not full ProseMirror validation or
publish approval. It does not fetch links/images, verify access settings, or
prove final rendering. Review the draft in Substack; no content is modified.

Both tools require `publication` when multiple publications are configured.

### Write (private drafts; image upload returns a public URL)

| Tool | Description |
|------|-------------|
| `create_draft` | Create a new draft from markdown (private) |
| `update_draft` | Apply a reviewed change receipt; recheck unpublished state and report readback outcomes |
| `upload_image` | Upload an image to Substack's CDN — returns a publicly-fetchable (unlisted) URL |

### Review before changing a draft

In 0.9, call `plan_draft_update`, review its output, then call `update_draft` with
the same fields and returned receipt. Published or known stale drafts are
rejected. The read/write race remains; check readback outcomes and review in
Substack. The CLI shares this flow through `drafts plan` and `drafts apply`.
See [draft changes and migration](docs/draft-changes.md) for examples and limits.

### Publish (Notes — public immediately)

| Tool | Description |
|------|-------------|
| `create_note` | Publish a Substack Note (short-form, **publishes immediately**) |
| `create_note_with_link` | Publish a Note with a link card attachment (**publishes immediately**) |

Notes have no draft state on Substack, so there is no draft-first option for these two tools.

### Subscriber management

`add_free_subscriber` adds one consenting reader to the free newsletter. It is
a distribution change: that reader may receive future newsletter emails. It
can request a welcome email with `send_welcome_email: true` (off by default).
It never grants paid access or overrides Substack's
suppression of previously unsubscribed addresses. Its MCP annotations identify
it as an external write (`readOnlyHint: false`, `openWorldHint: true`).

```json
{"email":"reader@example.org","consent_confirmed":true,"consent_evidence":{"source":"booking:message-id","recorded_at":"2026-09-01T00:00:00Z"},"dry_run":true}
```

Dry-run is the default. After checking actual newsletter consent, set
`dry_run: false` to execute. Live adds require the source reference and timestamp
in `consent_evidence`; this attestation is echoed with the publication key for
auditing and does not replace checking the underlying consent record.
Multi-publication configurations also require the
`publication` selector, just like every other tool.

Results distinguish `existing`, `dry_run`, `verified`, `blocked`, and
`unverified`, `busy`, and `retryable`. `busy` performs no write; wait for the
other operation. `retryable` means authentication or rate limiting refused the
request; resolve that condition before explicitly retrying. An empty API acknowledgement is **not** proof of addition.
`verified` means an exact membership lookup succeeded after the request; it
does not prove that this request originally created the membership. Dashboard
data can lag. A missing reader may also have previously unsubscribed.

For `unverified`, recheck with `get_subscriber`; never automatically repeat the
add. For `blocked`, review in Substack without bypassing suppression. Automated
callers must persist an attempt ledger **before** sending each live request.
The client's in-memory duplicate guard does not survive restarts or separate
HTTP sessions. Keep subscriber identities and consent evidence out of shared
repositories, prompts to unapproved public services, and routine logs.

Implementation and live verification notes: [subscriber API](docs/subscribers.md).

For Google Calendar booking opt-ins, the [calendar sync helper](docs/calendar-sync.md)
provides a bounded Gmail scan, latest-answer selection, a private durable attempt
ledger, and read-only reconciliation after uncertain writes. Scheduling is an
explicit local setup step; installing the MCP does not start a background job.

### Intentionally excluded

- **Publish posts** — Publishing long-form posts should be a deliberate human action (Notes are the documented exception above)
- **Delete** — Too destructive for an AI tool
- **Schedule** — Use Substack's editor for scheduling. (`list_scheduled_posts` *reads* what you've queued there, but this server never creates, edits, or cancels a schedule.)

For an always-on scheduler with durable cloud state and weekly email reports, see [Cloud Calendar sync](docs/cloud-calendar-sync.md).

## Multiple publications

Running more than one publication behind a single server? Set a `SUBSTACK_PUB_<KEY>_*` triplet per publication instead of the plain `SUBSTACK_*` vars. `<KEY>` is any name you choose (letters, digits, underscores) — it becomes the publication's lowercase, hyphenated key, e.g. `KEVIN_MULDOON` → `kevin-muldoon`.

```json
"env": {
  "SUBSTACK_PUB_KEVIN_MULDOON_PUBLICATION_URL": "https://kevinmuldoon.substack.com",
  "SUBSTACK_PUB_KEVIN_MULDOON_SESSION_TOKEN": "token-1",
  "SUBSTACK_PUB_KEVIN_MULDOON_USER_ID": "111",
  "SUBSTACK_PUB_SAPERE_PUBLICATION_URL": "https://sapere.substack.com",
  "SUBSTACK_PUB_SAPERE_SESSION_TOKEN": "token-2",
  "SUBSTACK_PUB_SAPERE_USER_ID": "222"
}
```

Each triplet is independent, and setting *any* `SUBSTACK_PUB_<KEY>_*` variable declares that publication. An incomplete triplet — a missing variable, an empty value, or a whitespace-only value — fails startup with an error naming the key, rather than silently dropping that publication. That matters because a dropped publication is not "one fewer publication": drop the only one and the server falls back to your stored browser-login session; drop one of two and every tool loses its `publication` parameter, so a call meant for the dropped publication routes silently to the surviving one.

Keys are compared case-insensitively, with `_` folded to `-`. Two names that resolve to the same key (`SUBSTACK_PUB_ALPHA_*` and `SUBSTACK_PUB_Alpha_*`) are a startup error too — merging them silently would let one publication's URL pair with another's session token.

`<KEY>` accepts ASCII letters, digits, and underscores; the three suffixes must be uppercase and the whole name must have no stray whitespace. Anything that begins with `SUBSTACK_PUB_` but does not fit that shape — a hyphen in the key, a lowercase suffix, an accented character, a trailing space — is a startup error naming the variable, not a variable that gets quietly ignored. For the same reason as above: an ignored publication is not one fewer publication, it is a silent reroute to a different one.

With two or more publications configured, every tool gains a **required** `publication` parameter — one of your configured keys (e.g. `kevin-muldoon`, `sapere` above). The calling model must specify one on every call; an unrecognized value is rejected before any Substack API call is made, so a stray write can't land on the wrong publication. **With exactly one publication configured** — the common case, whether via plain `SUBSTACK_*` vars or a single `SUBSTACK_PUB_<KEY>_*` triplet — **no `publication` parameter is added at all**; every tool's schema is unchanged from single-publication mode.

Don't mix the two styles: if any `SUBSTACK_PUB_<KEY>_*` var is set, the plain `SUBSTACK_*` vars are ignored (with a startup warning) rather than treated as an unnamed extra publication.

`SUBSTACK_USER_AGENT` and `SUBSTACK_REQUEST_TIMEOUT_MS` apply to every configured publication — they are not per-publication. Browser login also supports explicit named profiles; see [Named profiles and migration](#named-profiles-and-migration).

## Token expiration

Substack session tokens expire periodically (typically ~90 days). If you get authentication errors, grab a fresh `connect.sid` cookie from your browser and update the env var (make sure ad blockers are disabled when copying the cookie) — or, if you used the browser login, just re-run `substack-mcp-login` to refresh the stored session.

## Custom domains & Cloudflare

Substack publications served on a custom domain (e.g. `blog.example.com`) sit behind Cloudflare, which can reject non-browser requests with `403 error code: 1010`. To avoid this, the server sends a browser `User-Agent` and a `Referer` by default, and addresses the publication by its canonical `*.substack.com` host.

- **Use the canonical host.** Set `SUBSTACK_PUBLICATION_URL` to the publication's `*.substack.com` address rather than the custom domain. Calls to the canonical host are served directly; custom-domain calls may 301-redirect and then 401.
- **Override the User-Agent** (optional) via `SUBSTACK_USER_AGENT` if you need a different browser signature:

```json
"env": {
  "SUBSTACK_PUBLICATION_URL": "https://yourblog.substack.com",
  "SUBSTACK_SESSION_TOKEN": "your-session-token",
  "SUBSTACK_USER_ID": "your-user-id",
  "SUBSTACK_USER_AGENT": "Mozilla/5.0 ..."
}
```

## Request timeout

Every request to Substack is bounded by a 30-second deadline. Node applies no request timeout of its own — only a 10-second *connect* timeout — so a host that accepts the connection and then goes silent (a proxy that drops packets rather than refusing them) would otherwise hang a tool call indefinitely. A request that hits the deadline fails with a `TimeoutError` naming the endpoint and the limit.

Raise or lower it with `SUBSTACK_REQUEST_TIMEOUT_MS` (milliseconds; a non-numeric or non-positive value is ignored with a warning and the default is used):

```json
"env": {
  "SUBSTACK_REQUEST_TIMEOUT_MS": "60000"
}
```

## Transports

By default the server speaks MCP over **stdio**, which the client configurations
above assume. Set `MCP_TRANSPORT=http` for a stateless Streamable HTTP server
(`POST /mcp`, `GET /health`) in a persistent, self-hosted deployment. Setup,
listener variables and the security model are in [HTTP transport](docs/http-transport.md).

### What this listener will accept

The HTTP listener starts closed: loopback `Host` and `Origin` allowlists by
default, an optional bearer token (`MCP_HTTP_TOKEN`) and a 10 MiB body cap. Host
and Origin checks are not authentication; set a token wherever other processes
can reach the port. See the [listener policy](docs/http-transport.md#what-this-listener-will-accept).


Versioned GHCR images and transport verification: [container distribution](docs/containers.md).

## Typed errors

API failures map to typed errors (`AuthenticationError`, `RateLimitError`,
`ValidationError`, `NotFoundError`, `ServerError`, `TimeoutError`, and the base
`SubstackAPIError`). The status mapping and error-body parsing are documented in
[typed errors](docs/errors.md).

## Draft export

Use `export_draft` for a read-only Markdown/JSON bundle, or run:

```sh
substack-mcp export 42 --output draft-export.json
substack-mcp export 42 --format markdown --output draft.md
```

Markdown exports retain the exact original body in a `.source.json` sidecar.
Inspect `unsupported_nodes` before reuse. Existing files require `--force`.
See [export and CLI behavior](docs/export.md) for publication selection, limits,
partial exports and file recovery.

## Markdown support

Drafts accept CommonMark/GFM Markdown: headings, nested bold/italic/strikethrough,
links and reference links, images with captions and linked destinations, nested
lists with starting numbers, code, blockquotes, rules and hard breaks. A standalone
`<!-- paywall -->` block adds one paywall to a long-form draft.

Unsupported content returns `unsupported_nodes` before a write. After reviewing
those diagnostics, draft callers can explicitly set `allow_unsupported: true`
to retain literal fallbacks. Tables remain Markdown inside code blocks; native
tables, footnotes, callouts and arbitrary embeds are not advertised as supported.
Notes reject unsupported conversion before either publication or attachment
creation and have no fallback override.

See [Markdown authoring](docs/authoring.md) for mappings, limits, compatibility
changes and the distinction between offline fixtures and live editor checks.

## Important notes

- This server uses Substack's **unofficial API**. It may break if Substack changes their endpoints.
- Session tokens are sent as cookies. Keep your `SUBSTACK_SESSION_TOKEN` secure.
- The server checks your credentials on startup, *after* the MCP handshake completes, and only warns — it never blocks startup on a network call. Tools still error individually if the token is expired, which is where the failure is actionable.
- `SIGTERM` and `SIGINT` are handled: the server closes its transport and exits 0, so `docker stop` returns promptly instead of waiting out the grace period.

## Development

For opt-in live read checks, see [live contract evidence](docs/live-contract-evidence.md).
The probe is disabled in ordinary CI and never publishes or writes.

Before releasing, run `npm run test:package`. It installs the built tarball with production dependencies in a clean temporary directory, checks both executable entrypoints, and verifies the MCP version and the complete registered tool catalog without real credentials.

```bash
git clone https://github.com/conorbronsdon/substack-mcp.git
cd substack-mcp
npm install
npm run build
```

Run locally:
```bash
SUBSTACK_PUBLICATION_URL=https://yourblog.substack.com \
SUBSTACK_SESSION_TOKEN=your-token \
SUBSTACK_USER_ID=your-id \
npm start
```

## Contributing

Issues and pull requests are welcome. Because this server uses Substack's unofficial API, the most useful contributions are fixes when an endpoint changes. If a tool stops working, open an issue with the tool name and the error. The safe-by-design boundary stays: no publish, no delete, no schedule for long-form posts. Notes publish immediately by design and must keep saying so loudly in their descriptions.

## About

Built and maintained by [Conor Bronsdon](https://github.com/conorbronsdon) for the [Chain of Thought](https://chainofthought.show/?utm_source=github&utm_medium=referral&utm_campaign=repo-readme&utm_content=substack-mcp) podcast production workflow, where it drafts and reviews newsletter posts before a human hits publish. Conor hosts Chain of Thought, a show about AI infrastructure and how practitioners actually build with it. More tools for creators live in [ai-tools-for-creators](https://github.com/conorbronsdon/ai-tools-for-creators). Find Conor on X at [@ConorBronsdon](https://x.com/ConorBronsdon).

**Companion tools:**
- [Transistor-MCP](https://github.com/conorbronsdon/Transistor-MCP): manage podcast episodes, analytics, and transcripts on Transistor.fm
- [podcastindex-mcp](https://github.com/conorbronsdon/podcastindex-mcp): search the Podcast Index and track guest appearances
- [op3-mcp](https://github.com/conorbronsdon/op3-mcp): report downloads, listener geography, and apps from OP3
- [apple-podcasts-mcp](https://github.com/conorbronsdon/apple-podcasts-mcp): pull plays, followers, and per-episode listening from Apple Podcasts Connect
- [gsc-mcp](https://github.com/conorbronsdon/gsc-mcp): query search performance, keywords, and sitemaps in Google Search Console
- [podcast-benchmark](https://github.com/conorbronsdon/podcast-benchmark): benchmark a show against its peers using only public data

---

## Disclaimer

*This is an independent personal project, not affiliated with, sponsored by, or endorsed by any company. All views expressed are my own.*

## Codex plugin

The repository includes a Codex manifest at `.codex-plugin/plugin.json` and an
MCP configuration at `.mcp.json`. It runs the published npm package over stdio
using `npx`; Node.js and npm must be available. The package version is pinned
in `.mcp.json`, so upgrading the plugin's server is an explicit change.

Configure your Substack credentials outside the plugin using the environment
variables or browser-login session described above. Never commit a session
token. Installation does not authenticate an account or grant approval to post.
Long-form posts remain drafts; Notes publish immediately.

## License

MIT
