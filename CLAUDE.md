# substack-mcp

MCP server for Substack — read posts, manage drafts, create notes. No publish or delete by design.

## Architecture
- `src/index.ts` — MCP server bootstrap and entry point
- `src/server.ts` — Tool registration, request handlers, Zod schema generation
- `src/api/client.ts` — HTTP client for Substack API (session cookie auth)
- `src/api/types.ts` — TypeScript interfaces for API responses
- `src/utils/errors.ts` — Error handling utilities
- `src/utils/markdown-to-prosemirror.ts` — Markdown to ProseMirror AST converter (Substack editor format)
- `src/__tests__/` — Vitest tests for client, errors, and markdown conversion

## Key constraints
- Read and draft operations only — no publish or delete capabilities by design
- Uses `connect.sid` session cookie for auth (not `substack.sid` on custom domains)
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
- Create PRs targeting main. CI must pass (lint + build + test on Node 20 and 22).
- Keep changes focused — one feature or fix per PR.
- Run `npm test` locally before pushing.
