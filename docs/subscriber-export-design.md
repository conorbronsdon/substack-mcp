# Design: bulk subscriber export (#148)

Status: **proposal with an experimental prototype**. The prototype is off unless
`SUBSTACK_EXPERIMENTAL_SUBSCRIBER_EXPORT=1` is set, has no MCP tool, and has only
been exercised against synthetic fixtures. Nothing here is a supported 1.x
interface until this design is reviewed and live-verified.

## Purpose

Creators need a full copy of their list for a few concrete jobs: migrating to
another email provider, a local backup, or a one-off reconciliation (for
example against the calendar-sync consent ledger). `search_subscribers` already
answers segmentation questions one bounded page at a time. Export is a different
operation: it moves every matching subscriber's email address onto disk in one
go. The design decisions that #52 deferred are settled below.

## Decisions

| Question (#148) | Decision |
| --- | --- |
| Surface | CLI only: `substack-mcp subscribers export`. No MCP tool, so subscriber rows never enter an assistant's context, transcript or client-side logs. |
| Explicit consent | Three independent gates: the environment flag, `--confirm-subscriber-pii` on every run, and a required `--purpose`. Missing any one stops before a request. |
| Stated purpose | `--purpose` (1–200 printable characters) is echoed in the stdout summary so the operator's own audit log records why the file exists. It is not written into the CSV. |
| Projected fields | Default: `user_email_address`, `subscription_id`, `subscription_interval`, the same as `list_subscribers`. Optional `--include` groups reuse the `search_subscribers` groups: `activity_rating`, `created_at`, `flags`, `revenue`. Names, photos and user IDs are never projected, even though the upstream rows contain them. |
| Output handling | Local file only, never stdout. The CSV is written with mode `0600` on POSIX (on Windows the file inherits the directory's ACLs, as with draft export) through a same-directory temporary file and published atomically, reusing the draft-export writer. An existing file is never replaced without `--force`; the target is checked before any request. |
| PII exposure | stdout and stderr carry counts, codes and static messages only. Upstream error text is discarded because it can echo request data. Tests assert that no fixture address appears in any output on success or failure. |
| Bounds | 50 rows per page (the verified maximum). `--max-rows` defaults to 10,000 with a hard cap of 100,000. If more rows match, the run fails as `row_limit_exceeded`; it never truncates silently. |
| Polling budget | See *Upstream surface* below: the prototype does not poll an async job. Its time budget is `--max-minutes` (default 30, maximum 120), checked before every request and every wait. |
| Filters | `--types free,paid,comp` only. Search, activity and date filters stay in `search_subscribers` until there is a concrete export use for them. |

## Upstream surface

Two upstream paths exist:

1. **Paged `POST /api/v1/subscriber-stats`.** Live-verified for
   `search_subscribers` in 1.3.0 ([subscriber contract](subscribers.md)): filters,
   `order_by` sorting, offset pagination, 50-row pages, HTTP 400 for unknown
   filters, and rows re-checked against the requested filters.
2. **Substack's dashboard export.** #148 records that the upstream export is
   asynchronous. Its endpoints, job states, CSV columns, download host and
   retention are **not verified** by this project, and it returns whatever columns
   Substack chooses, including fields this server never projects.

The prototype uses path 1. It needs no new endpoint, keeps the projection under
this server's control, and inherits the existing response validation
(`invalid_subscriber_response`, `filter_not_honored`). Path 2 stays a follow-up.
It could be better for very large lists, but it should be adopted only after
read-only live verification of the job lifecycle. It would then need its own
polling budget (interval, maximum polls, overall deadline) and a rule for
dropping columns this server does not project.

## Pagination and consistency

Offset pages are not a snapshot. The export sorts `created_asc`
(`order_by: subscription_created_at`), so a new signup lands after the cursor and
existing offsets do not move. A removal or unsubscribe during the read still
shifts later rows back by one, which would silently skip a subscriber.

The prototype detects this and fails closed as `inconsistent_snapshot` when:

- `total_matching` changes on any page compared with the first;
- a `subscription_id` appears on two pages (rows shifted);
- the final row count differs from `total_matching`.

Re-running is the remedy. Dashboard counts can lag writes
([subscriber contract](subscribers.md)). If lag makes consistent reads rare on
busy lists, revisit this with live evidence; do not weaken it on speculation.

## Rate limits

Substack publishes no rate limits for these unofficial endpoints. The prototype
paces one page per second, so 10,000 rows take about 200 requests and three to
four minutes. Retries are bounded:

- HTTP 429: wait for `Retry-After` (seconds or HTTP date) when present, otherwise
  exponential backoff from the page delay. Up to 3 retries per run, and no single
  wait over 120 seconds. Past either limit the run fails as `rate_limited`.
- HTTP 5xx and client timeouts: the same backoff and budget, then
  `upstream_unavailable`.
- HTTP 401/403: fail immediately as `authentication`. No retry.
- Malformed pages, rejected filters and contradicted filters: fail immediately.

Every request is a read. Retrying cannot cause a side effect.

## Failure modes

Every failure prints one JSON envelope on stderr (`ok: false`, `code`,
`pages_read`, optional HTTP `status`, `file_written`). Only `write_failed` can
leave a file: `file_written` is `true` when the CSV was published before the
temporary copy's cleanup failed, `"unknown"` when `--force` was replacing a
file, and `false` otherwise. Rows already read are discarded with the process
memory.

| Code | Cause | Exit |
| --- | --- | --- |
| `export_disabled` | Environment flag not set to exactly `1` | 2 |
| `invalid_arguments` | Missing consent, purpose or output; unknown option or group; `--output -` | 2 |
| `output_unavailable` | Output exists without `--force`, or is a directory or symlink | 2 |
| `publication_required` | Multiple publications and no `--publication` | 2 |
| `configuration` | Credentials could not be loaded | 1 |
| `row_limit_exceeded` | More matches than `--max-rows` | 1 |
| `rate_limited` / `upstream_unavailable` | Retry budget or maximum wait exceeded | 1 |
| `authentication` | Session rejected | 1 |
| `deadline_exceeded` | Time budget reached | 1 |
| `inconsistent_snapshot` | List changed during the read | 1 |
| `filter_rejected` / `filter_not_honored` / `invalid_subscriber_response` | Upstream contract violation | 1 |
| `write_failed` | Writing or cleaning up the CSV failed; see `file_written` | 1 |
| `unknown` | Anything else | 1 |

A temporary file can remain only if the final cleanup itself fails, as with
draft export; the `write_failed` message tells the operator to check the output
directory.

## Privacy

The file contains personal data the publisher is responsible for under
Substack's terms and applicable law. The prototype:

- never sends subscriber data anywhere except the local file;
- on POSIX, writes the file and its temporary copy owner-only (`0600`); on Windows
  both inherit the folder's ACLs, so the operator should choose a private folder;
- keeps the purpose in the operator's stdout, not in the data file;
- has no telemetry, as with the rest of the package ([PRIVACY.md](../PRIVACY.md)).

The CSV guards spreadsheet formula injection: text cells starting with `=`, `+`,
`-`, `@`, tab or carriage return get a leading `'`. Valid email addresses can
start with `+` or `-`.

## Prototype

- Engine: `src/api/subscriber-export.ts` (`collectSubscriberExport`, CSV
  encoding), built on `SubscriberService.search`.
- CLI: `src/subscriber-export-cli.ts`, routed from `substack-mcp subscribers export`.
- Tests: `src/__tests__/subscriber-export.test.ts` replays synthetic pages in the
  live-verified response shape from
  `src/__tests__/fixtures/subscriber-export-pages.json`. No live account was
  contacted.

```bash
SUBSTACK_EXPERIMENTAL_SUBSCRIBER_EXPORT=1 substack-mcp subscribers export \
  --output ./free-list.csv --purpose "Migrate free list to new provider" \
  --confirm-subscriber-pii --types free
```

## Before this leaves experimental

1. Maintainer-approved, read-only live run against a test publication. Record only
   counts, page timings and any 429s, never subscriber values. Confirm that
   `order_by: subscription_created_at` is stable for rows with equal timestamps.
2. Decide whether to verify and adopt the async dashboard export for large lists.
3. Add the command to `--help`, the operator CLI docs and the package docs list.
4. Revisit the 10,000 default and 100,000 cap with real list sizes.
