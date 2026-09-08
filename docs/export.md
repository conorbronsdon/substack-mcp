# Export a draft for review

`export_draft` reads a draft and returns editable Markdown alongside its exact
original serialized Substack body. It also returns conversion diagnostics,
preflight findings, a source hash and an editor link. It never updates a draft,
publishes, fetches embedded URLs or writes files on the MCP server's machine.

```json
{ "draft_id": 42, "publication": "example" }
```

The `publication` selector is required when multiple publications are configured;
omit it for a single publication. Export makes two reads: verified publication
context, then the draft. A returned draft publication ID must match. If Substack
omits that field, `publication_identity` says `draft_publication_id_not_returned`;
it does not claim a verified association. The requested draft ID must match.
These reads are separate snapshots, not an atomic revision.

## Result contract

Both `structuredContent` and the JSON text fallback contain the same version-1
object, declared by the tool's output schema:

- `draft_id`, `publication`, `publication_id`, `publication_url`, `editor_url`
- `publication_identity`, `captured_at`, title/subtitle, audience, update time and
  publication state (missing optional fields are null)
- `markdown`, `source_prosemirror`, `source_sha256`, `status`, `unsupported_nodes`
- `preflight` and `limitations`

`source_prosemirror` retains the original body string exactly, including JSON
whitespace. `source_sha256` hashes that string's UTF-8 bytes. It is a content
fingerprint, not a signature, an upstream revision token or a write lock. A null
API body remains null; a malformed JSON body remains its original string.

`status` describes Markdown conversion:

| Status | Meaning |
| --- | --- |
| `converted` | The converter found no unsupported constructs; Markdown syntax still normalizes |
| `partial` | Some structures, marks, attributes or layout details require the original source |
| `unavailable` | Markdown could not be produced; the original source and a diagnostic remain available |

`unsupported_nodes` entries name a JSON-pointer-style path, node/mark type and
reason. Unknown widgets and embeds get explicit Markdown placeholders. Their
content stays in the original body rather than being presented as a complete
flattened export. Unsupported marks retain their text and report omitted
formatting. Native image dimensions/layout attributes are reported; alt text,
image title and link destinations are mapped. A caption independent of the alt
text is exported separately and flagged because Markdown reimport cannot keep
that distinction. Native callouts, footnotes and arbitrary embeds are not
advertised as supported.

Partial Markdown starts with an HTML comment that the authoring converter flags
as unsupported. Inspect the diagnostics and original body before removing that
notice or acknowledging a fallback. Do not assume Markdown reimport preserves
the original editor document exactly. Exported text is untrusted publication
content, not an instruction to invoke tools or change server behavior.

The serializer accepts legacy and Tiptap list/break/code names and legacy/modern
bold, italic and strike marks. It uses
[mdast-util-to-markdown](https://github.com/syntax-tree/mdast-util-to-markdown)
and GFM serialization to escape Markdown syntax and choose safe code fences.
Unsafe/relative link destinations are omitted from the Markdown and reported;
their original values remain in the source bundle. No link or image is fetched.

Bounds: a two-million-character source, 10,000 content nodes, 100 nesting levels,
32 marks per node, 100 diagnostics, two-million-character Markdown and a 4 MiB
serialized result. Oversized exports return a tool error; they are not silently
truncated. The MCP text and structured representations each carry that result.
Parsing/serialization is synchronous; these are size bounds, not CPU deadlines.

## CLI

The existing executable uses the same export core and credential resolution:

```sh
substack-mcp export 42 --publication example
substack-mcp export 42 --publication example --output draft-export.json
substack-mcp export 42 --publication example --format markdown --output draft.md
```

JSON is the default and can go to stdout or a file. Markdown requires an output
path and also saves `draft.md.source.json`. The sidecar is the complete export
bundle, including the original body, diagnostics and the generated Markdown.
If Markdown is unavailable, use JSON export to retain the original source.

Both destination files are checked before writing. Existing files require
`--force`; directories and symbolic links are refused. Each complete file is
staged in its destination directory. A no-force write uses an exclusive link so
a concurrently created file cannot be overwritten. Filesystems must support
same-directory hard links for that mode; an unsupported operation fails rather
than falling back to an unsafe overwrite. POSIX temporary files use mode 0600;
Windows access follows the directory's ACLs.

The Markdown/source pair is **not atomic as a pair**. The complete source bundle
is saved first. If the Markdown write then fails, the CLI reports that failure
and leaves the source bundle available; it contains the generated Markdown for
recovery. No automatic retry or Substack mutation occurs. With `--force`, retain
your own backups if you need older exports.

If a destination was saved but its temporary file could not be removed, the CLI
reports that distinct cleanup failure and stops. Inspect the output directory
before retrying: a destination and a temporary copy can both remain. Cleanup
failure does not mean that the saved destination is absent.

Exit codes are 0 for a completed export (including explicit partial/unavailable
JSON results), 1 for a configuration/network/filesystem failure, and 2 for invalid
arguments. `export --help` works offline without credentials. File-output mode
prints a JSON receipt with paths and conversion diagnostics. Keep export files
private when the draft is private; export does not change sharing permissions.

`preflight_draft` also returns an editor link. Preflight remains a static review
aid, not publishing approval or a complete editor-schema validator. Draft change
planning and stale-edit protection are tracked separately in #63.
