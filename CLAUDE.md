# substack-mcp

MCP server for Substack — read posts, manage drafts, create notes. Cannot publish or delete posts by design; notes (short-form) publish immediately since Substack has no note-draft state.

## Architecture
- `src/index.ts` — MCP server bootstrap and entry point
- `src/server.ts` — Tool registration, request handlers, Zod schema generation
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

## Development
```bash
npm ci
npm run lint    # tsc --noEmit (type-check)
npm run build   # tsc (outputs to dist/)
npm test        # vitest run
```

## Testing
3 test suites:
- `client.test.ts` — API client auth validation
- `errors.test.ts` — Error handling and wrapping
- `markdown-to-prosemirror.test.ts` — Markdown to ProseMirror AST conversion

## Agent workflow
- Always work on a branch. Never push directly to main.
- Create PRs targeting main. CI must pass (build + test on Node 20 and 22). `npm run build` runs `tsc` and fails on type errors.
- Keep changes focused — one feature or fix per PR.
- Run `npm run lint` (fast no-emit type-check) and `npm test` locally before pushing.
