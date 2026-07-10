# Contributing

Thanks for helping improve substack-mcp. Issues and pull requests are welcome.

## Before you open a PR

- `npm run lint` passes (this runs `tsc --noEmit` — the type checker is the linter).
- `npm test` passes (`vitest run`). Add or update tests for any behavior you change.
- The safe-by-design boundary stays: no publish, no delete, no schedule for
  long-form posts. Notes publish immediately by design and their descriptions
  must keep saying so loudly.

## Working against the unofficial API

This server talks to Substack's unofficial API, so the highest-value
contributions are fixes when an endpoint changes. If a tool stops working, open
an issue with the tool name and the exact error.

## Verifying rendering changes

If you touch the markdown → ProseMirror converter or image handling, the drafts
API accepting your payload is **not** enough — Substack stores structures its
editor then fails to render. Verify the change against a live publication by
opening the resulting draft in Substack's editor, and note that you did so in
the PR. Cover the cases your change can hit (e.g. images with and without a
caption, and non-CDN image URLs where dimensions are unknown).

## Local setup

See [Development](README.md#development) in the README for clone/build/run steps
and the `SUBSTACK_*` environment variables.

## Commits & PRs

- Conventional-commit-style titles are appreciated (`feat:`, `fix:`, `ci:` …).
- Describe what changed and how you verified it.
