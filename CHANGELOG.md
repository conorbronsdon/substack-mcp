# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before
`0.6.0` are recorded in the [GitHub Releases](https://github.com/conorbronsdon/substack-mcp/releases)
and the git tag history (`v0.1.0`–`v0.5.0`).

## [Unreleased]

### Added
- SSOT CI checks for the documented Node minimum, advisory discovery, and
  mutation controls for registered drift and intentional exclusions.

## [1.0.0] - 2026-09-08

### Added
- Release checklist, named-client compatibility evidence and distribution inventory.
- Versioned container release verification for Linux amd64, with source/version ownership labels, a minimal build context, stdio and authenticated HTTP checks, preserved matching release images on recovery, and explicit anonymous GHCR access verification.
- Claude Code plugin and repository marketplace, sharing the creator workflow skill and exact-version npm launcher with the existing Codex plugin. Manifest versions are synchronized and tested with release metadata. Local plugin support is distinct from hosted ChatGPT or curated-directory admission.
- Opt-in read-only live contract probes with clean source revision, client/transport and credential-safe coverage reports. Doctor includes installed version and runtime; startup authentication reports read access without inferring an account ID from a post byline.
- Typed object results with matching text JSON across all object-returning MCP tools; legacy array outputs remain unchanged. Shared response validation and size limits, schema snapshots, and a documented 1.x compatibility policy. Numeric read IDs and pagination now reject unsafe or invalid values before API requests.
- Explicit named session profiles, exclusive creation and legacy migration with rollback. `substack-mcp login` retains the legacy login binary, captures only publication-scoped cookies and checks authenticated read access before saving. Login requires a supplied account user ID rather than inferring one from a post byline.
- Shared-handler CLI reads: `drafts list/get`, `analytics post` and `subscribers count/get`, with explicit publication selection, versioned JSON envelopes and bounded output. `drafts export` aliases the existing export command. Offline `status` reports installed version, runtime and credential-safe configuration diagnostics.

### Fixed
- Updated the development-only tsx dependency to remove the remaining esbuild advisory; the full dependency audit reports no known vulnerabilities at release preparation.

## [0.9.0] - 2026-09-08

### Changed
- Markdown conversion uses a CommonMark/GFM AST, retaining nested formatting, ordered-list starting numbers, linked images and captions, and explicit draft paywalls. Unsupported constructs produce located diagnostics; draft writes require explicit fallback acknowledgment, and Notes stop before attachment creation or publication. Conversion has documented size and structure limits.
- Authenticated API requests no longer follow redirects. Configure a direct HTTPS API origin; public subscriber-count pages retain up to three cookie-free HTTPS redirect hops.
- Missing or malformed credentials now stop server startup before transport connection. All configured publications must be valid; none are silently dropped. Use `doctor` for diagnostics and `substack-mcp-login` for first-time setup. This replaces the previous missing-credential warning followed by unusable tools.

### Fixed
- Release publication distinguishes failed lookups from absent artifacts, verifies exact identities, and independently recovers missing Registry or GitHub entries using the original npm release commit and manifest. Each publication is followed by verification; existing mismatched tags or incomplete release state require reconciliation.
- HTTP failures retain their actual status and validated Retry-After guidance, including 503 responses with unreadable diagnostic bodies. Error metadata distinguishes upstream status from synthetic client errors and records body-read failures. Cancellation does not replace an already classified failure; requests never retry writes automatically.
- Shared API/doctor/public-count requests now bound streamed response bytes and deadlines through body consumption, reject authenticated redirects, bound cookie-free public-page redirects, classify malformed JSON/HTML, preserve rate-limit guidance and cap/redact error details. Requests never retry automatically; failed write outcomes still require reconciliation.
- The API client and doctor share strict origin, user-ID and cookie-value validation. Invalid configurations fail before requests, with credential-safe errors; valid custom domains and encoded cookie values remain supported.
- Archive search rejects duplicate post IDs, unsafe numeric IDs/totals and nonempty pages that exceed the reported total, while preserving valid final and empty out-of-range pages.

### Added
- `plan_draft_update` and `drafts plan/apply`: bounded review plans, publication/unpublished-state checks, payload and snapshot binding, best-effort stale detection and explicit readback outcomes. **Migration:** `update_draft` now requires the receipt from planning and the same proposed changes. Draft replacement is annotated as destructive. No atomic-write or automatic-retry guarantee.
- `export_draft` and `substack-mcp export`: read-only Markdown/JSON export with original serialized source, explicit conversion losses, source hash, publication identity scope and editor link. CLI files require explicit overwrite and retain a source bundle for Markdown. New output is schema-declared with matching structured/text representations. Preflight also returns an editor link.
- `list_publication_tags` and `get_post_tags`: publication-bound tag reads, hidden-tag handling, unresolved IDs and bounded local snapshot pagination. These tools never assign or remove tags.
- `get_publication`: projected publication metadata with normalized host matching, explicit absent fields, structured MCP output and a text fallback. Does not infer account identity or permissions. Live checks cover one custom-domain publication; malformed responses and publication isolation have fixture coverage.
- A reproducible sample workflow and animated demo covering rich draft creation, search, export, stale-plan rejection and verified readback. Updated setup positioning and social preview artwork.

## [0.8.0] - 2026-09-07

### Added
- `search_posts`: bounded server-side archive queries for published, draft and scheduled posts, projected metadata, explicit continuation and unknown-total handling.
- `preflight_draft`: read-only title, audience, body, image and paywall checks with structure limits and explicit coverage limitations.
- `substack-mcp doctor [--json] [--check-auth]`: offline configuration checks, optional bounded authenticated reads, credential-safe results and stable exit codes. Auth checks disable redirects and do not claim user identity binding.
- Explicit `serve` alias and server `--help`; bare MCP startup and the browser-login binary remain compatible.
- Regression coverage for publication isolation, malformed responses, secret redaction, preflight limits and installed CLI behavior. The MCP catalog now contains 19 tools.

## [0.7.0] - 2026-09-07

### Added
- Three subscriber tools: paginated reads, exact email lookup, and consent-based free additions. Adds default to dry-run, require explicit consent evidence for live writes, and never override suppression or grant paid access. (#44)
- Multiple-publication routing with a required publication selector when two or more publications are configured. (#36)
- Optional stateless Streamable HTTP transport with host/origin checks and optional bearer authentication. (#35)
- Calendar opt-in sync with durable attempt reconciliation, plus an optional Cloudflare deployment with welcome-email requests and weekly health reporting. (#45, #46)
- Clean tarball install test covering both binaries, MCP initialization, version identity, and the complete 17-tool catalog. CI runs it on Node 22 and 24.
- Browser login `--help` without loading Playwright, and a structured, redaction-aware bug report form.

### Changed
- Minimum supported Node.js version is now 22; Node 18 and 20 are end-of-life.
- Updated the MCP SDK lockfile to 1.30.0 and compatible dependency security patches.
- npm package includes runtime output, registry metadata, usage documentation, and changelog; excludes CI, cloud source, tests, and source maps.
- Registry metadata now marks the session token as secret and includes a project URL and configuration placeholders.

### Fixed
- Codex plugin version and pinned launcher now synchronize with releases and are checked for drift.
- CI covers Windows and Linux on Node 22/24 with read-only permissions and bounded jobs; publication runs are serialized.
- MCP initialization reads the version from package.json instead of reporting a stale hard-coded version.
- Release metadata agreement and monotonic release ordering are checked before publication. (#37, #39, #40)

## [0.6.2] - 2026-08-03

### Added
- A 30-second deadline on every request to Substack, overridable with
  `SUBSTACK_REQUEST_TIMEOUT_MS`. Node applies no request timeout by default —
  only undici's 10s *connect* timeout — so a host that accepted the connection
  and then went silent could hang a tool call indefinitely. A request that hits
  the deadline now raises `TimeoutError`, which names the endpoint and the
  limit, instead of surfacing a bare `DOMException`. (#31)
- `SIGTERM`/`SIGINT` handlers that close the transport and exit 0. Node installs
  no handler by default and the kernel ignores default-disposition signals for
  PID 1, so `docker stop` waited out its full 10s grace period and then
  SIGKILLed (exit 137). Measured against the published Dockerfile: 10,334ms and
  exit 137 before, 357ms and exit 0 after. No init process (`tini`) needed. (#31)

### Fixed
- The startup auth check no longer blocks the MCP handshake. It ran *before*
  `server.connect()`, so a host that hangs rather than refuses stalled
  `initialize` for undici's full connect timeout with no output. Measured in a
  container against a blackholed host: `initialize` took 11,182ms before, 822ms
  after; the credential-free path (what the Docker MCP registry check exercises)
  is unchanged at 14 tools and exit 0. The check still runs — it just runs after
  connect, and it only ever warned. (#31)
- `tsconfig.json` now excludes `src/__tests__` from the build. `tsc` was emitting
  the test suite into `dist/`, where its `vitest` imports cannot resolve because
  `npm ci --omit=dev` correctly drops vitest — dead code in the published
  package, and a stale `dist/` also made `vitest run` collect every suite twice.
  The Dockerfile's `RUN rm -rf dist/__tests__` workaround is removed with it.
  Tests are still type-checked: `npm run lint` now uses `tsconfig.lint.json`,
  which covers all of `src/`. (#31)

## [0.6.1] - 2026-08-03

### Fixed
- `get_post_analytics` no longer fails on every call. It paged the published
  feed with a hardcoded `pageSize = 100`, and Substack's `post_management`
  endpoints reject any `limit` above 50 — so the very first page request 400'd
  regardless of which post ID was passed. Page size is now the new exported
  `MAX_PAGE_SIZE` (50) and the page bound rises from 5 to 10, preserving the
  documented 500-post scan depth. Pages are still awaited one at a time, so the
  worst case is 10 sequential requests, and only when the ID is absent from the
  feed entirely. (#28)
- `list_published_posts`, `list_drafts`, and `list_scheduled_posts` clamp
  `limit` to 50 rather than 100. The default of 25 kept this latent, but any
  caller passing a larger value got a 400 from Substack. Over-cap values are
  still clamped rather than rejected, so existing callers passing 100 keep
  working. (#28)

### Changed
- The three `limit` parameters now advertise `1-50` instead of `1-100`. The tool
  description is what tells a model which values are legal, so the wrong number
  there was actively producing the failing calls. (#28)
- `get_post_analytics` derives the "500 most recent posts" figure in its
  description and its not-found note from `MAX_PAGE_SIZE * ANALYTICS_MAX_PAGES`
  instead of restating the literal, so it cannot rot when either changes. (#28)

## [0.6.0] - 2026-07-10

### Added
- `upload_image` accepts a local file path via `image_path` (mutually exclusive
  with `image_base64`). The file is read and encoded to a data URI internally,
  with the MIME type inferred from the extension — the agent no longer has to
  read and pass raw image bytes. (#20, #21)

### Fixed
- Markdown image conversion now nests an `image2` node inside `captionedImage`,
  matching Substack's editor schema, instead of emitting a flat `captionedImage`
  node. The flat node was accepted by the drafts API but crashed Substack's
  editor on render. Applies to `create_draft`, `update_draft`, and
  `create_note`. (#21)
- The image `_WxH_` dimension suffix is now only parsed on Substack CDN URLs, so
  a hand-embedded external image with an aspect-ratio filename (e.g.
  `hero_16x9.jpg`) no longer gets bogus 16×9-pixel dimensions. (#21)
