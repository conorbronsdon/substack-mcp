# substack-mcp

MCP server for Substack — read posts, manage drafts, create notes. Cannot publish or delete posts by design; notes (short-form) publish immediately since Substack has no note-draft state.

## Architecture
- `src/index.ts` — MCP server bootstrap and entry point
- `src/server.ts` — Tool registration, request handlers, Zod schema generation; `createServer(publications: PublicationConfig[])` takes one client per configured publication
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
- Auth sends both `connect.sid` and `substack.sid` cookies set to the same session token (custom domains use `connect.sid`, substack.com uses `substack.sid`)
- Markdown must be converted to ProseMirror format for Substack's editor
- With 2+ publications configured (`SUBSTACK_PUB_<KEY>_*`), every tool gains a *required* `publication` enum parameter — no default, no guessing. With exactly one publication configured, no `publication` parameter is added at all (schema-identical to single-publication mode)

## Development
```bash
npm ci
npm run lint    # tsc --noEmit -p tsconfig.lint.json (type-checks all of src/, tests included)
npm run build   # tsc (outputs to dist/; excludes src/__tests__)
npm test        # vitest run
```

## Testing
4 test suites:
- `client.test.ts` — API client auth validation
- `errors.test.ts` — Error handling and wrapping
- `markdown-to-prosemirror.test.ts` — Markdown to ProseMirror AST conversion
- `annotations.test.ts` — Annotation mapping + completeness (every registered tool classified)

## Agent workflow
- Always work on a branch. Never push directly to main.
- Create PRs targeting main. CI must pass (build + test on Node 20 and 22). `npm run build` runs `tsc` and fails on type errors.
- Keep changes focused — one feature or fix per PR.
- Run `npm run lint` (fast no-emit type-check) and `npm test` locally before pushing.
