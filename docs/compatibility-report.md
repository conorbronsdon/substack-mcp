# Contributor compatibility reports

Use this kit for [#151](https://github.com/conorbronsdon/substack-mcp/issues/151).
Report only workflows you tried. A fixture pass proves the synthetic path, not
an account tier, a client UI, or browser login. Missing reports mean unknown.

## Clean setup and version capture

Start from a fresh source checkout with Node satisfying `package.json`'s
`engines.node`. Install the lockfile dependencies, then build:

```sh
npm ci
npm run build
node --version
npm --version
git rev-parse HEAD
git status --short
node -p "JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version"
npm ls @modelcontextprotocol/sdk --depth=0
```

Record the installation method (source checkout or installed npm package), OS
and architecture, and the MCP client's own About/version output. For an npm
installation, record the installed package version instead of inventing a source
SHA. Record local edits as present/absent; do not attach paths from status output.
These commands do not read credentials. Do not capture environment dumps or
client configuration files.

## Offline controls

From the built checkout, run these without configuring an account:

```sh
npm run test:compatibility
npm run lint
npm test
```

Where sandbox policy blocks child-process spawning, the controls also support:

```sh
node --test --experimental-test-isolation=none scripts/compatibility-smoke.controls.mjs scripts/probe-contract.controls.mjs
```

The smoke controls connect the actual MCP server and SDK client through an
in-memory transport, replace fetch with synthetic responses, and permit only
GET requests to the example publication endpoint. Unexpected requests fail;
there is no network fallback. They cover a healthy catalog/read, HTTP 401,
HTTP 403 and a rejected client transport send. The existing probe controls
exercise the GET-only gate and explicit publication selection. No stored
session is loaded. The transport failure is injected; it does not test stdio
framing, HTTP deployment, or a particular client.

## Optional read-only observation

Only use an already configured, authorized session. Account creation and login
are outside this kit. Run diagnostics locally, inspect them, then transcribe
only the allowlisted report fields below:

```sh
node dist/index.js doctor --json
node dist/index.js doctor --check-auth --json
```

The first command checks configuration without network. The second performs a
bounded authenticated read per configured publication. With multiple accounts,
check which publications are configured locally before running it; do not share
its full output. To check one explicit publication through the existing guarded
MCP probe, follow [live contract evidence](live-contract-evidence.md), including
its opt-in and publication selector. It uses in-memory transport, not your GUI
client. Do not mistake it for evidence about that GUI.

For a client observation, use the [existing setup](../README.md#setup) and
[plugin instructions](plugins.md), then try `initialize`, `tools/list`, and
`get_publication({})`. With multiple publications, include the exact configured
`publication` selector locally. Record only success/error, not returned account
metadata. Stop on failure; do not try writes to diagnose read access. Do not run
Notes, uploads, draft changes, subscriber additions, restacks or comments.

The separate [#150](https://github.com/conorbronsdon/substack-mcp/issues/150)
manual browser-login check still needs a real UI run, browser/profile and
credential-store method, followed by authenticated doctor. Mock login tests and
this kit do not satisfy it. Do not attach screenshots of account data or infer
the configured user ID from a post byline.

## Coverage ledger

This ledger distinguishes historical reports from new observations. The #151
issue/comment snapshot supplied on October 27, 2026 is the source for its
Hermes row; this kit has not re-run or independently verified that report.
See [compatibility](compatibility.md) for the repository's release evidence.

| Client / transport | Evidence | Account tier / plan | Remaining unknowns |
| --- | --- | --- | --- |
| MCP SDK / in-memory | Reproducible synthetic controls above | Synthetic; no tier | Real endpoints and client onboarding |
| Claude Code / stdio | Repository records synthetic model-driven draft-list call; client version not recorded there | Synthetic; no tier | Real tier coverage; current client version |
| Codex CLI 0.153.4 / stdio | Repository records synthetic model-driven draft-list call | Synthetic; no tier | Real tier coverage; other versions |
| Hermes custom Python / stdio, protocol `2024-11-05` | Voluntary live report, September 28, 2026; server 1.3.0, Node 22.22.1, WSL2 Debian 13; client version unreported | Reporter states free, payments disabled, community enabled, non-Bestseller | Independent confirmation; other tiers; current versions. Historical catalog count is 34, not a current assertion |
| Claude Desktop | Untested in this kit | Unknown | GUI setup and read workflow |
| Cursor | Untested in this kit | Unknown | Setup and read workflow |
| ChatGPT developer mode | Untested in this kit; local stdio plugins are not hosted connectors | Unknown | Client-specific transport/auth requirements; no hosted service is supplied |
| Any client, paid / Bestseller / other roles | No new live observation in this kit | Unknown | Each plan, publication role and workflow needs its own report |

The supplied #151 snapshot also records one non-Bestseller publication read
observation and a draft-tag write, without enough client/version detail to add
a reproducible row here. That write is outside this read-only kit.

## Failure classification

| Observation | Record as | What it does not prove |
| --- | --- | --- |
| Install, Node or configuration failure before handshake | Setup | Tier or endpoint incompatibility |
| Initialize/catalog fails, process exits, framing or connection error | Client/transport; note phase | That Substack rejected the account |
| Read returns 401 | Authentication candidate; record status | Account identity or a tier restriction |
| Read returns 403 | Permission/authentication/blocking ambiguity | A paid-plan requirement. The generic API maps both 401 and 403 to `AuthenticationError` |
| Analytics-specific unavailable code | Endpoint/permission candidate; record code and status | That all reads or all accounts of that tier fail |
| 429, timeout, 5xx, unexpected HTML or malformed response | Rate limit / availability / response contract | Permanent client or tier incompatibility |
| Read succeeds | Observed workflow only | Writes, identity, role, other tiers or browser login |

Do not paste raw errors, headers or payloads. If the phase is unclear, record
`unclassified` and the last completed step. Do not automatically retry writes.

## Sanitized evidence template

Copy this text into a voluntary report. Fill unknowns with `unknown`, and steps
you did not run with `untested`. Manually inspect before sharing; this is an
allowlist, not an automated redactor.

```text
Date (UTC):
Evidence: synthetic / observed live / reporter-supplied historical
Server version and installation method:
Source SHA (source installs only); local edits present/absent:
Node / npm / OS / architecture:
Client name / exact version / MCP protocol if known:
Transport and connection method (no URLs or config dumps):
Self-reported publication plan / payments enabled / Bestseller: unknown
Self-reported publication role: unknown
Workflow | phase reached | pass/fail/untested | safe code / HTTP status
initialize:
tools/list:
get_publication:
doctor configuration:
doctor authenticated read:
Optional guarded probe (separate SDK client):
Setup friction (paraphrase without identifiers):
Failure classification / uncertainty:
Manual browser-login verification (#150): pending / separately documented
```

Never request or attach cookies, tokens, credential files, private draft bodies,
subscriber data, full browser histories, account identifiers, local account
paths, raw tool output or screenshots. Sharing is manual and optional; these
commands do not submit a report.

## Task-sized next contributions

- One client row: record the exact client/server versions, transport, handshake,
  catalog and publication-read outcome using this template; leave tier unknown
  unless voluntarily self-reported. No writes or hosted setup.
- One tier/role row: repeat the same bounded read workflow with an existing
  authorized account; report only that configuration. A 403 remains ambiguous.
- Browser-login evidence for #150: separately authorized manual UI run with
  date, OS, browser, named-profile use, file/keychain method and authenticated
  doctor outcome. Keep identity verification unresolved unless its authenticated
  source was actually checked; submit no account screenshots.
