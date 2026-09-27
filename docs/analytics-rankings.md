# Post rankings

`rank_posts` ranks posts by one metric from Substack's dashboard email
statistics. It is a single read and never changes anything.

```json
{ "metric": "subscribes", "direction": "desc", "limit": 10, "offset": 0 }
```

| Input | Values | Default |
| --- | --- | --- |
| `metric` | `views`, `opened`, `sent`, `open_rate`, `click_through_rate`, `signups`, `subscribes`, `estimated_value`, `post_date` | `views` |
| `direction` | `desc`, `asc` | `desc` |
| `limit` | 1–20 | 10 |
| `offset` | 0 or more | 0 |

Only metrics whose sorting was checked against the live endpoint are accepted.
The endpoint silently accepts unknown sort fields and misspelled parameters, so
anything else is rejected before a request is made. No filters are supported:
an extra argument such as `section_id` is rejected rather than ignored, so a
result is never presented as filtered when it is not. Substack rejects page
sizes above 20.

## Result

Each row has its `rank` (position from `offset + 1`), `post_id`, `title`,
`post_date`, `type`, the ranked `value`, a `value_state`, a fixed set of
`metrics`, and `absent_metrics`. The page also reports `total`, `returned`,
`has_more`, `next_offset` and `unreported_in_page`.

| `value_state` | Meaning |
| --- | --- |
| `reported` | Substack returned a number (or date) |
| `null` | Substack returned `null` |
| `absent` | The row omitted the field |

`null` and `absent` are not zero, and this server never fills them in. In
`metrics`, both appear as `null`; `absent_metrics` names the omitted fields.

## Ordering and coverage

Rows keep Substack's order; nothing is re-sorted. Checked on September 14, 2026:

- Numeric values are correctly ordered in both directions for every accepted metric.
- Rows missing a count field come last in descending order and first in ascending order.
- For `open_rate` and `click_through_rate`, rows with a `null` rate are placed
  among the numeric rows, not at one end. Treat those positions as unranked.

`total` is Substack's count for its email statistics list. It may exclude posts
without email statistics, such as posts that were never emailed. Each page is a
separate read, so rankings can shift between calls if statistics change.

A page must agree with `total`. The page at `offset == total` is empty, which
ends continuation. An empty or short page before that point, or rows past
`total`, is rejected instead of being reported as the end of the list.

## Metric meanings

Values are passed through as Substack reports them. Substack does not document
the denominators or units of `open_rate` and `click_through_rate`, so this server
does not describe them as percentages of any particular count. `opened` and
`sent` are Substack's own counts; they are not unique-reader counts unless
Substack says so. `estimated_value` is Substack's estimate.

`post_date` is Substack's timestamp string, returned unchanged. It must parse as
a date; its timezone is whatever the string states.

## One post by ID

`get_post_analytics` first reads the exact post detail by ID and accepts it only
when `is_published` is true and `post_date` is non-null. Draft detail returns
`detail_fallback_reason: "not_published"`. A 403/404, malformed body, ID mismatch,
or other detail error triggers the bounded published-feed scan, searching the 500
most recent posts. `source` identifies the path; `detail_fallback_reason`
explains a fallback (`upstream_error` for other detail failures). Detail 401 and
429 errors propagate. When the post is not found,
`search_result` says why. `archive_exhausted` is only reported when the pages agree: a short final
page with no contradicting total, or full pages that exactly reach a total reported identically on
every page. Every page is still a separate offset read, not an atomic snapshot. If one post is
published and another deleted between reads, the total can stay the same while a post shifts past a
page boundary unseen, so `archive_exhausted` means the search reached the end of the feed as paged,
not proof that the post never existed. Retry when the feed may be changing.

| `search_result` | Meaning |
| --- | --- |
| `archive_exhausted` | The search reached the end of the feed as paged, with consistent pages |
| `scan_bound_reached` | The 500-post bound was reached first. An older post may exist; its statistics are unknown here, not absent |
| `feed_incomplete` | The feed's pages were incomplete or inconsistent: fewer posts than the reported total, a total that changed between pages or appeared on only some pages, more posts than the total, or a post repeated across pages. The search cannot rule the post out; its statistics are unknown here |

`scanned` is the number of posts examined. `feed_capped` passes through the
feed's `isCapped` flag, uninterpreted, or `null` when Substack omits it. A found
post has `stats_available: false` when Substack returned no statistics for it;
its metric fields are then `null`, not zero.

## Publication dashboard metrics

`get_publication_stats` makes two reads: `publish-dashboard/summary` and
`publish-dashboard/summary-v2?range=<range_days>`. The range is 1–365 days,
default 30. Each field has a `value`, `status` (`reported`, `null`, `absent`),
`unit`, `window`, source endpoint, capture time, and currency where applicable. A failed group has
`status: "unavailable"` and a typed reason. Neither missing nor unavailable
means zero. The two endpoints use different definitions and are not reconciled.
When `pledgeCurrency` is null or absent, the pledge metric reports currency
`not_reported`; a null `isBestseller` is returned as `is_bestseller: null`.

| Field | Unit | Window | Source | Missing data |
| --- | --- | --- | --- | --- |
| `appSubscribers`, `subscribers`, `totalEmail`, `numPledges` | count | Dashboard summary window undocumented | `summary` | `null` or `absent` |
| `appSubscribersLast30Days`, `subscribersLast30Days`, `totalEmailLast30Days` | count | Last 30 days | `summary` | `null` or `absent` |
| `views`, `viewsDelta` | views | Dashboard summary window undocumented | `summary` | `null` or `absent` |
| `openRate`, `openRateDiff` | percent on 0–100 scale | Dashboard summary window undocumented | `summary` | `null` or `absent` |
| `pledgesAmount` | currency amount, `pledgeCurrency` | Dashboard summary window undocumented | `summary` | `null` or `absent` |
| `totalSubscribersStart/End`, `paidSubscribersStart/End` | count | Trailing `range_days`, start/end | `summary-v2` | `null` or `absent` |
| `totalViewsStart/End` | views | Trailing `range_days`, start/end | `summary-v2` | `null` or `absent` |
| `arrStart/End`, `pledgedArrStart/End` | currency amount; currency `not_reported` | Trailing `range_days`, start/end | `summary-v2` | `null` or `absent` |

Dashboard `openRate` and `openRateDiff` use a 0–100 scale. Per-post
`open_rate` and `click_through_rate` use 0–1 fractions. Rate denominators are
not documented.

## Growth sources

`get_growth_sources` reads an ordered inclusive date span of at most 366 days,
ending no later than tomorrow UTC. It returns up to 20 top-level sources by
default, at most 50, in Substack's `users` descending order. `total_sources`
is the top-level array length in this unpaginated response; `has_more` means
the local limit or processing bound cut that array. `truncated.nodes`,
`truncated.depth`, and `truncated.timeseries` report processing caps of 500
nodes, depth 3, and 400 points per metric. Upstream metric names pass through.
`include_timeseries` defaults to false. `include_events` defaults to false and
adds one events read when true. The `events` result is `{ "status": "available",
"items": [...] }` on success or `{ "status": "unavailable", "reason": "..." }`
when that read fails, while the successfully read sources remain available.
An events 401 or caller cancellation stops the call. Failure reasons distinguish
HTTP status, timeout, oversized response, rejected redirect, unexpected HTML,
and malformed data. These results do not prove complete upstream
attribution or a stable snapshot. Referral URLs, logo URLs and upstream
publication IDs are omitted from the default source projection.

## Recommendations

Substack recommendations have a direction, and the two directions live on
different surfaces. Pick the tool by the question being asked.

| Question | Tool | Upstream | Access |
| --- | --- | --- | --- |
| Who recommends this publication, and how many subscribers did each send? | `list_incoming_recommendations` | `/api/v1/recommendations/stats/to` | Owner dashboard (authenticated) |
| Whom does this publication recommend? | `list_outgoing_recommendations` | `/api/v1/recommendations/from/{id}` | Authenticated here; public visibility not relied on |
| How many subscribers has this publication sent to the publications it recommends? | `list_outgoing_recommendation_stats` | `/api/v1/recommendations/stats/from` | Owner dashboard (authenticated) |

> **Warning: an outgoing list cannot answer an incoming question.** The
> `/recommendations/from/{id}` list, and the recommendations shown on a
> publication's public pages, name only the publications *it* recommends. A
> publication absent from that list may still recommend it. A check that read the
> outgoing list reported a missing incoming recommendation that was in fact
> active and credited with subscribers on the dashboard. Use
> `list_incoming_recommendations` for incoming recommendations.

Every result carries `direction` (`incoming` or `outgoing`) and `source` (the
upstream endpoint). Rows are projected to a small allowlist: the other
publication's `id`, `name`, `subdomain` and `custom_domain`, plus `started_at`
(the recommendation's creation time), and for the stats tools `active`,
`mutual`, and free and paid subscriber counts
(`subscribers_attributed`/`paid_subscribers_attributed` incoming,
`subscribers_sent`/`paid_subscribers_sent` outgoing). Counts are all-time as the
dashboard reports them. `null` means Substack did not report a value; it never
means zero, inactive or not mutual. Inactive rows are returned with their
historical counts. The embedded upstream publication records carry private
settings and tokens, which are never returned.

Pagination is one bounded page per call. The stats endpoints accept `limit` 1–20
(Substack returns HTTP 400 above 20), default 20, requested by subscribers
descending; Substack may still list inactive rows after active ones. The
outgoing list accepts 1–50, default 50. An empty page, or reaching Substack's
`total`, ends the list; a short page continues while `total` says more rows
exist. Without a `total`, a page shorter than `limit` ends the list. `total` is
Substack's count when reported, and `null` otherwise.

`ended_before_total` is `true` when the list ended with fewer rows than
Substack's `total`. The `/recommendations/from/{id}` endpoint has been observed
doing exactly this: it reported a total of 6 and returned 2 rows across all
pages, while `/recommendations/stats/from` returned all 6. Treat
`list_outgoing_recommendations` as a partial view and use
`list_outgoing_recommendation_stats` for the fuller outgoing list.

Each call first reads the publication record for the configured host to learn
its ID. Any row naming a different publication rejects the whole page with
`code: "publication_mismatch"`; nothing from it is returned. HTTP 403 or 404 on
that publication read returns `code: "publication_unavailable"`, and no
recommendation request is made. HTTP 403 or 404 from a recommendation endpoint
returns `code: "recommendations_unavailable"`: Substack did not provide the data,
commonly because the account lacks dashboard access. Neither is an empty list.
401 and 429 return the standard read
error with `status` and, when provided, `retry_after`.

## Errors

HTTP 403 or 404 from the statistics endpoint returns `code:
"analytics_unavailable"` with its `status`. It means Substack did not provide
statistics to this account or publication, not that the ranking is empty. This
server does not check publication tier or eligibility in advance; it reports what
Substack returns.

Rate limiting and other upstream failures return the standard read error with
`status` and a validated `retry_after` when Substack provides one; there is no
automatic retry. A response that does not match the expected shape (including
more rows than requested, duplicate posts or non-numeric metrics) is rejected
without returning partial results.
