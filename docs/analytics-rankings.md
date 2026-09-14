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
anything else is rejected before a request is made. Substack rejects page sizes
above 20.

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

## Metric meanings

Values are passed through as Substack reports them. Substack does not document
the denominators or units of `open_rate` and `click_through_rate`, so this server
does not describe them as percentages of any particular count. `opened` and
`sent` are Substack's own counts; they are not unique-reader counts unless
Substack says so. `estimated_value` is Substack's estimate.

For a single post's statistics by ID, use `get_post_analytics`.

## Errors

Rate limiting and other upstream failures return the standard read error with
`status` and a validated `retry_after` when Substack provides one; there is no
automatic retry. A response that does not match the expected shape (including
more rows than requested, duplicate posts or non-numeric metrics) is rejected
without returning partial results.
