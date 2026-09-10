# Contributing

Thanks for helping improve substack-mcp. Issues and pull requests are welcome.

## Before you open a PR

- `npm run lint` passes (this runs `tsc --noEmit -p tsconfig.lint.json` — the type
  checker is the linter). It covers `src/__tests__` too, which the build config
  excludes so `tsc` doesn't emit tests into `dist/`; nothing else type-checks
  them, since vitest strips types rather than checking them.
- `npm test` passes (`vitest run`). Add or update tests for any behavior you change.
- The safe-by-design boundary stays: no publish, no delete, no schedule for
  long-form posts. Notes publish immediately by design and their descriptions
  must keep saying so loudly.

## Documentation drift

The `SSOT / ssot` CI job checks the Node minimum in `.ssot.yaml` on every PR.
`package.json` owns the requirement; the README is a hand-maintained copy.
Release-version synchronization remains owned by `npm run check:release`.

A mismatched or missing registered copy fails the job. Correct the underlying
claim, then its copies; do not delete a locator just to make CI pass. Explain
changes to canonical ownership, locators, or discovery exclusions in the PR.

Discovery scans prose and emits advisory warnings for possible unregistered
copies. It does not detect every value: the Node floor needs its explicit
locator. Review each warning before adding a copy or an exclusion. Changelog
history and synthetic tests are excluded; explicit locators remain checked.
The initial discovery baseline contains loopback addresses in README/container
examples, which are intentional and are not release-version drift.

To reproduce CI, check out the checker revision pinned in
`.github/workflows/ssot.yml` into a sibling `ssot-check` directory, then run:

```bash
python3 ../ssot-check/ssot_check.py check --manifest .ssot.yaml
python3 ../ssot-check/ssot_check.py discover --manifest .ssot.yaml --untracked-only --github-annotations
python3 scripts/check-ssot-controls.py ../ssot-check/ssot_check.py
```

Controls mutate disposable copies, verify drift and missing-copy failures,
restore a passing baseline, and prove exclusions do not hide registered drift.
A synthetic unregistered price must warn while `check` stays green. During the
pilot, record useful findings, repeated warnings, and maintenance effort in the
PR or a follow-up issue before expanding the manifest.

## Working against the unofficial API

This server talks to Substack's unofficial API, so the highest-value
contributions are fixes when an endpoint changes. If a tool stops working, open
an issue with the tool name and the exact error.

## Verifying rendering changes

If you touch the markdown → ProseMirror converter or image handling, the drafts
API accepting your payload is **not** enough — Substack stores structures that
its editor then fails to render. Verify the change against a live publication by
opening the resulting draft in Substack's editor, and note that you did so in
the PR. Cover the cases your change can hit (e.g. images with and without a
caption, and non-CDN image URLs where dimensions are unknown).

## Local setup

See [Development](README.md#development) in the README for clone/build/run steps
and the `SUBSTACK_*` environment variables.

## Commits & PRs

- Conventional-commit-style titles are appreciated (`feat:`, `fix:`, `ci:` …).
- Describe what changed and how you verified it.
