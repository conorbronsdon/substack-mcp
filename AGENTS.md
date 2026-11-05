# substack-mcp

The repository contract for every agent runtime. Codex and other runtimes read this file directly; Claude Code reads it through `CLAUDE.md`, which imports it.

MCP server for Substack — read posts, manage drafts, create notes. Cannot publish or delete posts by design; notes (short-form) publish immediately since Substack has no note-draft state.

## Architecture
- `src/index.ts` — MCP server bootstrap and entry point; picks stdio (default) or HTTP transport via `MCP_TRANSPORT`
- `src/transport/http.ts` — Stateless Streamable HTTP transport (`POST /mcp`, `GET /health`) for persistent/networked deployments
- `src/server.ts` — Tool registration, request handlers, Zod schema generation; `createServer(publications: PublicationConfig[])` takes one client per configured publication
- `src/prompts.ts` — MCP prompts (workflows that chain existing tools) and the `substack://publications` resource; no new endpoints
- `src/annotations.ts` — Tool side-effect classification (read / draft-write / public-upload / publish) → MCP annotations (hints set explicitly; MCP defaults omitted hints to the unsafe direction)
- `src/auth/resolve-credentials.ts` — Single-publication env-var + stored-session credential resolution (the original, still-supported contract)
- `src/auth/resolve-publications.ts` — Multi-publication credential resolution (`SUBSTACK_PUB_<KEY>_*` env vars), falling back to `resolve-credentials.ts` when none are set
- `src/api/client.ts` — HTTP client for Substack API (session cookie auth)
- `src/api/types.ts` — TypeScript interfaces for API responses
- `src/utils/errors.ts` — Error handling utilities
- `src/utils/markdown-to-prosemirror.ts` — Markdown to ProseMirror AST converter (Substack editor format)
- `src/__tests__/` — Vitest tests for client, errors, and markdown conversion

## Key constraints
- Posts are read/draft only — no publish or delete capabilities by design
- Notes publish immediately via `create_note` / `create_note_with_link` — Substack has no note-draft state, so there is no preview step
- Auth sends both `connect.sid` and `substack.sid` cookies set to the same session token (custom domains use their own `connect.sid`; substack.com's `substack.sid` is a different session rejected by a custom domain)
- Markdown must be converted to ProseMirror format for Substack's editor
- Community writes: see `docs/community-writes.md`. Comments use the selected publication; restacks use a separately configured reader session and explicit account ID. Both preview by default, require exact per-call consent, and are disabled for live writes unless explicitly enabled.
- With 2+ publications configured (`SUBSTACK_PUB_<KEY>_*`), every publication tool gains a *required* `publication` enum parameter — no default, no guessing. With exactly one publication configured, no `publication` parameter is added at all (schema-identical to single-publication mode)

## Development
```bash
npm ci
npm run lint    # tsc --noEmit -p tsconfig.lint.json (type-checks all of src/, tests included)
npm run build   # tsc (outputs to dist/; excludes src/__tests__)
npm test        # vitest run
```

## Testing
Tests live in `src/__tests__/`; `npm test` discovers the current suites.
`npm run test:package` verifies the installed npm artifact and sample workflow.
`npm run test:release` exercises release metadata and recovery controls.
Output contract snapshots cover single- and multiple-publication schemas.

## Agent workflow
- Always work on a branch. Never push directly to main.
- Create PRs targeting main. CI must pass (build + test on Node 22 and 24). `npm run build` runs `tsc` and fails on type errors.
- Keep changes focused — one feature or fix per PR.
- Run `npm run lint` (fast no-emit type-check) and `npm test` locally before pushing.

## Additional agent rules

Use a focused branch and PR; CI checks the supported Node/OS combinations.

Preserve the draft-only long-form boundary and explicit immediate-publication
semantics of Notes. The tool catalog and side-effect classifications are checked
by `src/__tests__/annotations.test.ts` and the output-contract snapshots.
Publication selection and private data must not cross accounts; controls live in
`src/__tests__/resolve-publications.test.ts` and `output-contracts.test.ts`.

Use the release scripts to synchronize versions; `npm run check:release` and
`npm run test:release` enforce manifest alignment. Never put real credentials,
private drafts, subscriber data or local account paths in tests, logs or packages.
Credential hygiene requires reviewer inspection as well as automated checks.
Use clearly `example-*`-prefixed synthetic credential fixtures.
