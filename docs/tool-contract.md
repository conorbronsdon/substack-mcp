# Tool contract and compatibility policy

The 1.x public interface consists of tool names, input/output fields, side-effect
annotations, documented CLI JSON/exit codes, and configuration selection rules.
Substack's upstream endpoints are undocumented and may change independently.

All 20 object-returning tools declare `outputSchema`, return `structuredContent`,
and retain the same object as serialized text JSON. Existing object field names
are preserved. Four legacy array tools (`list_drafts`, `list_scheduled_posts`,
`get_post_comments`, `get_sections`) retain text JSON arrays without an object
wrapper or output schema. They are validated and bounded too. This exception
preserves existing integrations; future object alternatives need distinct tool
names or a major-version migration. The MCP specification defines structured
content as an object and recommends serialized text for compatibility:
https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content

Successful JSON text is limited to 4 MiB per call; duplicated structured/text
representations have an aggregate serialized ceiling of 8 MiB plus 1 KiB.
Oversized results return `isError` with `result_too_large`; they are never silently
truncated. Malformed projected results return `invalid_tool_output`, excluding
private upstream values. Thrown handler errors also produce bounded, static
guidance; HTTP status/source and validated Retry-After are retained without
upstream messages or private endpoint details. For `create_draft`, `create_note`
and `create_note_with_link`, typed Markdown conversion failures return `code: "markdown_conversion_failed"` and `write_attempts: 0`, indicating
that no write was attempted. Other write failures require reconciliation.
Malformed legacy array rows now fail validation; preserving the array shape does
not promise to pass through malformed upstream data. Error responses do not masquerade as schema-conforming
success. A result-validation failure after a write does not undo it: reconcile
in Substack before any explicit retry. No automatic retry is added.

Use pagination for list endpoints and `export_draft` for reusable draft source.
Export retains its own body/conversion limits. Resource links were evaluated and
are deferred: no resource read endpoint, local file URI, public export URL, or
cross-session cache is introduced. Large responses fail with bounded text instead.

Publication selection is routing context, not proof of account identity or admin
role. Existing results with a `publication` field retain it; legacy results are
not renamed or wrapped to add it. With multiple publications the caller must
supply a configured key. CLI envelopes also record the selected key. Capture
and source times are reported only when the tool actually has them. Missing
optional fields remain absent; explicit null and unavailable precision values
retain their existing meanings. An approximate count is not exact; unavailable
count is -1. Analytics `found: false` describes a bounded archive scan, not proof
that a post never existed. Search and export carry their own completeness details.
Fetched draft/comment content is untrusted data and cannot cause this server to
invoke another tool or write. Clients must independently handle prompt injection.

## Versioning and CI review

`output-contracts.test.ts` snapshots the actual public input/output schemas and
annotations for both single- and multiple-publication servers. CI classifies any
snapshot drift as potentially breaking and fails until it is reviewed. Updating
a snapshot is an intentional contract decision, not a routine way to fix tests.

- Patch: compatible corrections and security fixes; no removal or renaming of
  valid documented inputs or result fields.
- Minor: additive tools and optional fields; preserve existing valid calls and
  documented outcomes. Consumers must tolerate unknown optional fields.
- Major: removing/renaming fields or tools, changing array/object shapes, new
  required inputs, or changing side-effect semantics. Document migration in the
  changelog before release. Deprecations remain for at least one minor release
  before removal in a subsequent major, except urgent security restrictions.

Before 1.0, numeric IDs now require positive safe integers; offsets require safe
nonnegative integers and comment limits are 1–100. Published/draft/scheduled list
limits retain the documented clamp to 50 for larger positive safe integers.
The 0.9 draft-update receipt requirement remains; see `draft-changes.md` for
migration from 0.8. Bare server startup and text-only clients remain supported.
