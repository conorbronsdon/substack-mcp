# Operator CLI and diagnostics

Configuration, credentials and client setup are in the [README](../README.md#setup).

The CLI also exposes workflows through the same MCP handlers. Every command
below is read-only except `drafts create`, which writes one private draft:

```sh
substack-mcp status --json
substack-mcp drafts list --limit 10 --offset 0
substack-mcp drafts get 42
substack-mcp drafts create post.md --title "Post title"
substack-mcp posts search "Post title" --status drafts --limit 10
substack-mcp drafts preflight 42
substack-mcp drafts export 42 --format json
substack-mcp analytics post 42
substack-mcp analytics rank --metric subscribes --limit 10
substack-mcp subscribers count
substack-mcp subscribers get reader@example.com
```

Add `--publication key` when multiple publications are configured. Read commands
return `{format_version: 1, ok, command, publication, data}` as JSON; `--json` is
accepted explicitly. Exit 0 means a completed read or draft creation, 1 means a configuration,
upstream or output failure, and 2 means invalid arguments or selection. A missing
analytics result or subscriber is still a completed read; inspect `data`. `analytics rank`
uses the same `rank_posts` handler: one page of at most 20 rows, Substack's order, and
`reported`/`null`/`absent` value states (see [post rankings](analytics-rankings.md)). Statistics
Substack does not provide fail with `upstream_code: "analytics_unavailable"`. Counts
retain their exact/approximate/unavailable precision. Output is capped at 4 MiB
without partial printing. Draft and subscriber output is private.

Failed reads still print `code: "read_failed"` to stderr with exit 1, and add a
`category`: `authentication`, `rate_limited`, `timeout`, `not_found`,
`invalid_request`, `upstream_unavailable`, `response_invalid`,
`response_too_large`, `cancelled`, `output_limit`, `configuration`,
`statistics_unavailable` (for `analytics_unavailable`; a new login will not help) or `unknown`.
When the MCP boundary reported them, `upstream_code`, `status`, `status_source`
and a validated `retry_after` are included. Upstream messages, response bodies
and exception text are never printed, and nothing is retried automatically.

`drafts create` reads a UTF-8 Markdown file of at most 1 MiB, converts it with
the same rules as `create_draft` and writes one unpublished draft; it never
publishes, schedules or deletes. The path must name the file itself: symbolic
links and directories are refused with `invalid_input_file` before credentials
load. Unsupported Markdown stops before any request
with `unsupported_markdown` and `unsupported_nodes`; add `--allow-unsupported`
only after reviewing them. Success data includes the draft `id` and
`editor_url`. A configuration failure reports `write_not_attempted`. Any later
failure reports `write_unverified` with a category, because the draft may
exist: check `drafts list` or `posts search <title> --status drafts` before an
explicit retry. `posts search` returns one bounded page with the continuation
fields of `search_posts`, and `drafts preflight` runs the static checks of
`preflight_draft`; neither approves publication.

`status` reports installed version, Node/platform and the same offline
configuration diagnostics as doctor. It never opens a browser or claims a
verified user identity. `drafts export` is an alias of the existing `export`
command and retains its bundle/overwrite contract. Draft plan/apply also retain
their existing output and exit codes; these aliases do not rewrap saved plans.

```sh
substack-mcp doctor --json
substack-mcp doctor --json --check-auth
```

`doctor` uses the same environment/stored-session resolution as the server.
Both validate an HTTPS publication origin, a positive safe-integer user ID
containing only digits, and an unquoted cookie value without whitespace or
cookie separators. Invalid configuration stops server startup before requests.
Percent-encoded cookie values are preserved exactly. Configuration checks do
not prove that the supplied host belongs to Substack or that credentials work.

Upgrading: missing or malformed credentials now stop startup instead of
starting tools that fail later. Correct all configured publications; invalid
entries are never silently dropped. `doctor` and `--help` still run without a
working session. Use `substack-mcp-login` to set up a first session.

By default, `doctor` checks configuration without network requests. `--check-auth`
adds one draft-list GET per valid publication, with a five-second request
deadline and redirects disabled. Use an HTTPS publication origin (no path,
query, credentials, or custom port); a redirect or custom-domain block may
require switching to the publication's canonical `name.substack.com` origin.
All API requests reject redirects, including same-origin redirects, without
following the destination or replaying a write. The publish-page Referer is
retained for direct custom-domain requests. Configure the origin that serves
the API directly; a redirect response is reported as `redirect_rejected`.

Each request has one deadline through headers and body consumption (30 seconds
by default, five seconds for `doctor --check-auth`). Streamed response limits
are 10 MiB for API JSON, 1 MiB for doctor, 2 MiB for the public-page count
fallback, and 64 KiB for error bodies. Limits apply to bytes delivered by fetch,
including decompressed bytes. Oversized responses fail without partial results.
For an oversized HTTP error body, the HTTP error classification is preserved
and diagnostic details are discarded.
JSON parsing is synchronous and bounded by input bytes, so it cannot be
interrupted mid-parse; a complete parsed result is retained if parsing finishes
after the I/O deadline.
The public count fallback permits at most three HTTPS redirects within the same
deadline. It sends no cookies or authorization and rejects destinations with
URL credentials or custom ports. It returns unavailable when its read fails.

Doctor distinguishes `unexpected_html`, `malformed_json`, `response_too_large`,
`redirect_rejected`, `timeout`, `rate_limited`, and `unauthorized_or_blocked`.
HTTP 401/403/429 bodies are discarded without waiting; rate-limit errors retain
valid delta-seconds or standard HTTP-date `Retry-After` guidance. Error details
are capped at 500 characters (plus an ellipsis) and matching cookie values are
redacted before truncation. Requests are never automatically retried. A failed
or timed-out write may have succeeded upstream; reconcile its state before
trying again.

Output includes publication key, origin, credential source, configuration and
authentication status. It omits session tokens, user IDs and upstream error
bodies. A successful read does not establish user-ID binding or write access.

Exit codes: 0 = requested checks passed; 1 = configuration/authentication check
failed; 2 = invalid command arguments. Without `--check-auth`, a 0 exit code
does not mean the session is unexpired. Bare `substack-mcp` still starts the
MCP server; `substack-mcp serve` is an explicit alias. `--help` does not connect
to Substack. Browser login is `substack-mcp login`; `substack-mcp-login` remains an alias.
