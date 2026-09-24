# Distribution inventory

Maintainer: Conor Bronsdon. Package artifacts reflect the verified 1.3.0 release
(September 24, 2026 UTC). Directory listings were last fully checked on September 14;
Glama was rechecked on September 24. Other rows retain their September 8 verification. This is a dated
status record, not a promise that third-party indexes have refreshed. npm
remains the canonical package. Release artifacts are verified by the Publish
workflow; directory admission and social publication are tracked separately in
[#56](https://github.com/conorbronsdon/substack-mcp/issues/56) and
[#68](https://github.com/conorbronsdon/substack-mcp/issues/68).

## Package and release artifacts

| Destination / identity | Current status | Update or verification route |
| --- | --- | --- |
| [npm: @conorbronsdon/substack-mcp](https://www.npmjs.com/package/@conorbronsdon/substack-mcp) | Published; canonical install. `latest` is 1.3.0 (verified September 24, 02:50 UTC), with `gitHead` matching release merge commit `767e89e`; a clean install lists 34 tools | Publish workflow; verify version, integrity and installed package |
| MCP Registry: `io.github.conorbronsdon/substack-mcp` | Published; version updates automated. 1.3.0 is the active latest entry (verified September 24 UTC) | Publish workflow; query registry identity/version after release. The search index can lag a few minutes |
| [GitHub releases](https://github.com/conorbronsdon/substack-mcp/releases) | Published; automated version releases. `v1.3.0` targets `767e89e` | Verify tag source and release notes |
| GHCR: `ghcr.io/conorbronsdon/substack-mcp` | `1.3.0` is anonymously readable and was published with attestations by the Publish workflow (September 24). Earlier: 1.2.0 resolves to `sha256:dd413f3390c2…`; 1.1.1 is attested; the 1.1.0 image has no attestations | Publish workflow, package visibility, anonymous digest check and `gh attestation verify`; [guide](containers.md) |
| Docker Hub | No image advertised; follow-up destination | Maintainer must choose namespace and verify publication before listing an image |
| [Product documentation](https://github.com/conorbronsdon/substack-mcp#readme) | Maintained with source | README, [workflow tutorial](workflow.md), demo and compatibility checks |
| Claude Code | Repository marketplace and plugin available. Submitted to Anthropic's community plugin directory on September 23 as "Newsletter Creator Tools" (the form disallows brand names the submitter does not own); pending review | [Plugin installation](plugins.md); synchronized manifest and connection check; approval appears in `anthropics/claude-plugins-community` |
| Codex | Repository plugin manifest and direct MCP configuration available | Validate manifest and direct client tool call; app installation remains a separate check |
| Hosted ChatGPT / OpenAI plugin directory | Not published (checked September 23: no listing in the OpenAI or ChatGPT plugin directories). The public directory requires a hosted HTTPS MCP server; this project ships local stdio only. Deferred | Separate authenticated, per-user hosted service design; tracked as a deferred follow-up to [#69](https://github.com/conorbronsdon/substack-mcp/issues/69) |
| MCPB | Evaluated and deferred | Revisit when desktop installation needs justify a separately tested bundle |
| PyPI | Intentionally excluded | Avoid a redundant language wrapper around the canonical Node package |
| Homebrew / JSR | Deferred | Evaluate maintenance and upgrade needs after 1.0 |

## Directory listings (checked September 14, 2026 UTC)

Checks used unauthenticated HTTPS fetches of each public page. Earlier on
September 14, MCP Market and Smithery were also checked in a browser; the
late recheck after the 1.2.0 release (about 23:15 UTC) used plain fetches only,
so client-rendered pages are marked where their content could not be read.
Observations describe the displayed content only; login-gated content was not
inspected.

| Directory | Listing and identity | Observed version | Transport and authentication wording | Status | Correction route |
| --- | --- | --- | --- | --- | --- |
| [Glama](https://glama.ai/mcp/servers/conorbronsdon/substack-mcp) | Exact repository; links the npm package | Not displayed | Current README text (browser login or `SUBSTACK_*` variables; stdio and self-hosted HTTP). On September 24 it listed 25 tools (the 1.2.x catalog, including `rank_posts`), none of the 1.3.0 tools | Reindex needed for 1.3.0 (34 tools) | Request reindex through listing management (maintainer sign-in) |
| [PulseMCP](https://www.pulsemcp.com/servers/conorbronsdon-substack) | Exact repository and registry name `io.github.conorbronsdon/substack-mcp`; links the registry `server.json` | Not displayed | The late recheck received a client-rendered page with no readable version or setup text; the earlier summary said long-form posts are draft-only and Notes publish immediately | Confirmed listing; identity current, setup wording unverified | Registry ingestion from `server.json`; no correction submitted |
| [LobeHub](https://lobehub.com/mcp/conorbronsdon-substack-mcp) | Exact repository and npm package | 0.1.0, dated August 31, 2026; still marked Unvalidated after the 1.2.0 release | npx stdio setup with three environment variables; no browser login, profiles or multi-publication setup | Update needed | Maintainer claim or resubmission through LobeHub; use the correction text below |
| [MCP Market](https://mcpmarket.com/server/substack-4) | Listed under `conorbronsdon`; confirmed in a browser on September 14 | Not displayed | Browser observation from earlier on September 14: reads publication data, creates and updates drafts, uploads images, publishes Notes immediately; long-form posts cannot be published or deleted. No browser login, consented subscribers, multi-publication support or CLI. The late plain fetch hit a Vercel security checkpoint (HTTP 429) | Confirmed listing; content predates 1.0 | Maintainer correction through MCP Market using the submission text below |
| [Smithery](https://smithery.ai/servers/@conorbronsdon/substack-mcp) | Earlier on September 14 the identity URL rendered "404: Server Not Found or Removed" in a browser. The late plain fetch of `/servers/conorbronsdon/substack-mcp` returned a client-rendered shell with no server details | None | None | Not listed at this URL; other listings not established | Evaluate local configuration and secret handling before any authorized submission |
| MCP.so | Not in the server-rendered search results for "substack" (17 results on the late recheck, none from this repository); the guessed `/server/substack-mcp/conorbronsdon` path returned 404 earlier | None | None | Submission candidate; absence not established | Directory submission form after confirming no existing listing |
| mcpservers.org | Not in the server-rendered search results for "substack" on the late recheck (no `conorbronsdon` entry) | None | None | Submission candidate; absence not established | Directory submission form after confirming no existing listing |
| Curated lists | Coverage reconciliation pending | — | — | Pending | Search exact repository URL, check list contribution rules and existing entries before proposing additions |

Search failures do not establish that a listing is absent. Before marking any
destination current, verify the exact repository/package, supported transport,
credential instructions and accepted public URL. Automated aggregators can lag
several releases. Do not copy unverified capability counts or compatibility
claims from their cached descriptions.

### Correction and submission text

Submissions and corrections are maintainer actions; this text is prepared, not
sent. Replace the version with the current npm release when submitting.

> **substack-mcp** — MCP server and CLI for Substack newsletter creators: rich
> Markdown drafts with footnotes, draft tagging, image upload by file or URL,
> Notes, publication and post analytics with labelled units, growth sources,
> post rankings, archive search, anonymous public reading of profiles, Note
> threads and archives, subscriber segmentation and consented free-subscriber
> management across one or more publications. Long-form posts stay drafts for
> review in Substack; Notes publish immediately.
>
> - Repository: https://github.com/conorbronsdon/substack-mcp
> - Package: `@conorbronsdon/substack-mcp` (npm, version 1.3.0)
> - MCP Registry name: `io.github.conorbronsdon/substack-mcp`
> - Transport: local stdio (`npx -y @conorbronsdon/substack-mcp`); optional
>   self-hosted Streamable HTTP
> - Authentication: `substack-mcp login` browser sign-in (optionally stored in the
>   OS keychain), or `SUBSTACK_PUBLICATION_URL`, `SUBSTACK_SESSION_TOKEN` and
>   `SUBSTACK_USER_ID`
> - Requirements: the Node.js version in the package's `engines` field
> - License: MIT

For LobeHub and MCP Market, send the text above and ask for the listed version
and setup instructions to be refreshed from the current README. For Glama, request
a reindex from listing management so the 1.3.0 tool catalog (34 tools) appears.

## Adoption baseline (September 24, 2026, 04:08 UTC)

| Metric | Value | Comparison |
| --- | --- | --- |
| GitHub stars / forks | 35 / 8 | 26 / 6 at the 1.0 baseline (September 8) |
| npm downloads, September 15–21 | 426 | 85 for August 31 – September 6 (1.0 baseline window) |
| npm downloads, August 23 – September 21 | 1,274 | — |
| GitHub views, trailing 14 days | 150 (91 unique) | Top referrers: Google 52, github.com 5, LinkedIn 5, Brave 3, Ecosia 2, chatgpt.com 1 |
| GitHub clones, trailing 14 days | 1,507 (321 unique) | Includes CI and automation |

Downloads and clones include CI, reinstalls and automation; they are not distinct
active users. Recheck the same windows 7 and 28 days after the 1.3.0 release.

## Launch measurement

For launch measurement, record weekly npm downloads, stars/forks and voluntarily
reported installation outcomes in the release issue. Compare consistent date
windows at 7 and 28 days. Keep user identities and private feedback out of public
records unless the contributor has authorized disclosure.
