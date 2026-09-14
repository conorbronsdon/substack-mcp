# TypeScript API evaluation

**Decision: defer.** The 1.x contract already covers two maintained surfaces:
MCP tools and the operator CLI. A documented JavaScript API would add a third,
with its own type snapshots, semantic-versioning reviews and support questions.
No issue, discussion or support request currently asks for programmatic reuse.
The design below is the one to adopt when that demand appears.

## Current state

`package.json` declares `bin` only: no `main`, `exports` or `types`. The build
emits declaration files into `dist/`, but nothing presents them as a contract.
A consumer can only deep-import internal `dist/...` paths, which may change in
any release. The repository's own scripts use relative `../dist/...` imports;
those are development tooling, not a supported interface.

Several modules are unsafe as library entry points:

- `dist/index.js` calls `run()` when loaded. It reads `process.argv` and starts
  the stdio MCP server or a CLI command.
- `resolvePublications()` reads environment variables and stored session files.
- `SubstackClient` performs no network I/O until a method is called. Its methods
  mix raw upstream shapes (for example drafts with `draft_title` and
  `draft_body`) with partially projected results (subscriber counts, publication
  metadata). The complete documented output contract, including bounds and
  failure codes, is enforced only at the MCP tool boundary.

`createServer(publications)` builds an MCP server without connecting a transport.
The operator CLI already calls tools through an in-memory client/server pair to
reuse those projections.

## Proposed surface

Add one subpath, `@conorbronsdon/substack-mcp/api`, backed by a new entry file
with no import-time side effects:

- `convertMarkdown(markdown, "draft" | "note")`: pure; returns the ProseMirror
  document and `unsupported_nodes` diagnostics, so callers can preview
  conversion losses before any write.
- `createToolClient({ publicationUrl, sessionToken, userId, userAgent?, timeoutMs? })`:
  a thin façade over `createServer` and the in-memory transport. `callTool(name,
  args)` returns the tool's parsed JSON result, or throws a typed failure
  carrying the same `code`, `status`, `status_source` and `retry_after`
  projection the MCP boundary already emits.

Draft checks go through `callTool("preflight_draft", { draft_id })`. The internal
`preflightDraft` helper is not exported: it reads the raw draft fields, not the
projected `get_draft` result, so exposing it would need its own public input
shape.

`SubstackClient` should not be exported either. Its mixed raw and projected
return values would become a compatibility promise, or need a second projection
layer that duplicates the tool handlers.

Adding any `exports` map also blocks deep imports of unlisted paths for package
consumers. That is intended, but it is a visible change for anyone relying on
`dist/...` today and must be called out in the changelog. The `bin` entries are
unaffected.

## Example (proposed, not shipped)

Read one page of drafts:

```ts
import { createToolClient } from "@conorbronsdon/substack-mcp/api";

const substack = createToolClient({
  publicationUrl: "https://example.substack.com",
  sessionToken: mySecretStore.get("substack-session"),
  userId: "12345",
});

const drafts = await substack.callTool("list_drafts", { offset: 0, limit: 10 });
```

Prepare a private draft after inspecting conversion losses, then check it:

```ts
import { convertMarkdown, createToolClient } from "@conorbronsdon/substack-mcp/api";

const markdown = await readFile("post.md", "utf8");
const { unsupported_nodes } = convertMarkdown(markdown, "draft");
if (unsupported_nodes.length > 0) throw new Error("Review unsupported Markdown first");

const substack = createToolClient({ publicationUrl, sessionToken, userId });
const draft = await substack.callTool("create_draft", { title: "Post title", body: markdown });
const review = await substack.callTool("preflight_draft", { draft_id: draft.id });
// Review the draft in Substack's editor. Long-form posts are never published here.
```

`create_draft` converts the Markdown itself; the local conversion call is only a
preview of its diagnostics.

## Semantics to settle before exposure

| Concern | Rule |
| --- | --- |
| Credentials | Explicit arguments only. The API never reads environment variables or stored sessions. |
| Import | No transport, credential loading, network request or console output on import. |
| Output | The documented MCP tool result for each tool; no new shapes. |
| Errors | Typed failure with the existing static projection. No upstream bodies, cookies or arbitrary exception text. |
| Retries | None. A failed write may have succeeded; the caller reconciles before any explicit retry. |
| Side effects | Unchanged per tool: reads, private draft writes, public image upload, immediate public Notes and consented subscriber writes. |
| Versioning | Exported names and types join the 1.x interface in [the tool contract](tool-contract.md), with type snapshots reviewed like the output-contract snapshots. |

## Exclusions

No Python wrapper, alternative registry or package split. Long-form publishing,
deletion and scheduling remain out of scope for every surface. Notes keep their
immediate-publication semantics.

## Implementation checklist, if approved

1. Add `exports` (`./api` and `./package.json`) and `types` to `package.json`,
   keeping `bin`.
2. Add a side-effect-free `src/api.ts` that exports only `convertMarkdown` and
   `createToolClient`.
3. Extend `npm run test:package`: install the packed tarball in a clean
   temporary directory, import the subpath with no credentials or network
   access, assert no output on import, and type-check a small consumer file.
4. Add type snapshots and document the surface in the tool contract.
5. Record the deep-import change in the changelog under a minor release.

## Revisit when

- An issue or discussion describes a concrete scripted workflow that the MCP
  tools and CLI cannot serve.
- A bug report shows people depending on deep `dist/...` imports.
- A maintained downstream project needs the in-memory tool pattern and would
  otherwise copy it.
