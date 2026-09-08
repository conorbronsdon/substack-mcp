# Review and apply draft changes

In 0.9, `update_draft` requires a receipt from `plan_draft_update`. The existing
title, subtitle, Markdown body and audience fields remain available. Clients
that previously called `update_draft` directly must adopt the two-step flow.

1. Read the current draft with `get_draft` or `export_draft`.
2. Call `plan_draft_update` with `draft_id` and the proposed fields. Read the
   changed fields, before/after previews, conversion losses and preflight.
3. Call `update_draft` with **the same proposed fields** and the returned `receipt`.
4. Check the returned outcome and review the editor link in Substack.

Both tools require `publication` when multiple publications are configured.
Unknown fields, unsafe IDs, missing identity/state and mismatched publication
IDs are rejected. The draft must explicitly report `is_published: false`.
Known scheduled/sent indicators are rejected. Missing scheduling fields are
listed in the plan; their absence does not prove a draft is unscheduled.

```json
{ "draft_id": 42, "title": "Reviewed title", "body": "Opening **paragraph**." }
```

Pass this object to planning. For applying, add `"receipt": { ... }` using the
complete receipt returned by that plan. A changed title, body or
`allow_unsupported` acknowledgment requires a new plan. Unsupported Markdown
is rejected unless explicitly acknowledged during planning and applying.

## What the receipt guarantees

The versioned receipt hashes the observed body, metadata, publication/state
fields and available revision timestamps. A second hash binds the exact input,
converted payload and conversion contract. Apply reads the draft again and
rejects a changed fingerprint before sending a PUT. A matching no-op sends no PUT.

Receipts are portable, unsigned consistency records. They do not authenticate a
human approval, establish the caller's role, reserve a draft or act as a lock.
They work across separate stdio/HTTP sessions and CLI processes. No private
draft snapshots are stored by the server. Keep saved plans in private storage.

**Stale detection is best-effort.** An editor can still change or publish the
draft between the last GET and PUT. A September 8, 2026 synthetic-draft probe
observed an ETag on GET, but a deliberately nonmatching `If-Match` on PUT returned
200 and changed the test title. The title was restored through the guarded flow.
That endpoint did not enforce the tested precondition; this implementation does
not claim atomic compare-and-swap. Avoid concurrent editing and inspect Substack
after applying. This evidence covers one authenticated publication and endpoint.

## Outcomes

| `status` | Meaning |
| --- | --- |
| `verified` | Requested fields matched one readback, or the reviewed change was already a no-op |
| `unverified` | Readback failed or its identity/state/fields could not be verified |
| `conflict` | Readback differed, or showed a published/scheduled/sent state |

`request_status` separately reports `accepted`, `unknown` or `not_attempted`.
A timeout followed by matching readback proves observed state, not which request
produced it. Each apply attempts at most one PUT and one readback, with no automatic
retry. A conflict can reflect another editor or upstream normalization; it never
triggers a corrective overwrite. Errors before the PUT report `write_attempts: 0`.

New results use version-1 output schemas with equal structured and text JSON.
Plans are bounded to 128 KiB; text previews are explicitly truncated (512 characters
per before/after field, 2,000 for proposed Markdown). The payload is never truncated.
Markdown input is limited to 200,000 characters and native source to two million.
Static preflight findings help review; they do not prove rendering or publication
readiness. Long-form publishing, deletion and scheduling remain in Substack.

## CLI

Save the proposed object above as `changes.json`:

```sh
substack-mcp drafts plan --input changes.json > plan.json
substack-mcp drafts apply --input changes.json --plan plan.json
```

Inspect `plan.json` before applying. Add `--publication key` for multiple
publications. Inputs must be regular UTF-8 JSON files at most 1 MiB. The plan
file contains the full plan output, not just its receipt. The CLI uses the same
core and credential resolution as MCP. It never writes input or plan files;
shell redirection follows your shell's overwrite and access-permission rules.

Exit codes: 0 for a completed plan or verified apply; 1 for configuration or
pre-write failures; 2 for usage/input-file errors; 3 for unverified apply; 4 for
conflicting readback. Operational errors are JSON on stderr; results are JSON
on stdout. `drafts --help` is offline. Inspect ambiguous outcomes before any
further write; do not automatically retry the command.
