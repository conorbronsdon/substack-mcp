# Agent instructions

Read `CLAUDE.md` for repository architecture and development commands. Use a
focused branch and PR; CI checks the supported Node/OS combinations.

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
