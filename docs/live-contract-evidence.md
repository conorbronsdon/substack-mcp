# Read-only live contract evidence

From a clean committed repository checkout, install dependencies and configure
your own publication credentials or selected profiles. Ordinary CI never runs
live probes. Set `SUBSTACK_CONTRACT_PROBE=1`, then run `npm run probe:contract`.
The entrypoint itself builds the current source before loading it, including
direct script invocation, and makes authenticated reads. With multiple
configured publications also set `SUBSTACK_PROBE_PUBLICATION` to one configured
key. Missing/unknown selection stops without falling back to another account.

The probe verifies the authenticated draft-list response, publication context,
one draft-list page and subscriber-count result through the MCP TypeScript SDK.
A process-wide fetch guard blocks non-GET requests before transport and records
blocked attempts separately. It writes no draft, image, subscriber or Note and
has no cleanup step. Automated release controls verify opt-in, account selection
and the GET-only request gate. It uses
in-memory MCP transport; this is real endpoint evidence, not Claude Desktop,
Codex or HTTP-client onboarding evidence. Network calls retain shared deadlines
and response limits. No response body, publication origin, email, token, account
ID or private title is printed. The report records time, package version, exact
clean source revision, runtime, probe client/transport and per-check success.
Account identity and eligibility remain explicitly unverified.

Disabled probes exit 2. Activated probes exit 0 only when all checks succeed;
setup/read failures exit 1. Use `doctor --check-auth --json` separately for
credential-safe diagnostics. A passing probe does not prove write permission,
Bestseller status or support for every account tier. Preserve versioned reports
privately and publish only reviewed non-sensitive coverage summaries.

Live draft-write evidence requires a separately authorized isolated unpublished
sample and restoration procedure; it is not enabled by this runner. Never add
live Notes or image publishing to ordinary CI. Earlier 0.9 guarded-write evidence
and its residual non-atomic race limitations are documented in `draft-changes.md`.
