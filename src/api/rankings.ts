import { z } from "zod";

/**
 * Post rankings from Substack's dashboard email statistics (#101).
 *
 * Evidence (read-only probes, September 14, 2026): the endpoint returns
 * `{ rows, total }`; `limit` above 20 is rejected with HTTP 400; a page past the
 * end is empty; and it sorts correctly in both directions for exactly the fields
 * in RANK_METRICS. It silently accepts unknown `order_by` values, so only those
 * fields are allowed here. Rows can omit metric fields entirely, and rate fields
 * can be null; null rates are interleaved with numbers in sorted results.
 */
export const RANK_METRICS = ["views", "opened", "sent", "open_rate", "click_through_rate", "signups", "subscribes", "estimated_value", "post_date"] as const;
export const RANK_MAX_LIMIT = 20;
export const RANK_ROW_METRICS = ["views", "sent", "delivered", "opened", "open_rate", "clicked", "click_through_rate", "signups", "subscribes", "unsubscribes", "estimated_value", "likes", "comments", "restacks"] as const;
const RATE_METRICS = new Set(["open_rate", "click_through_rate"]);

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const rankPostsInput = z.object({
  metric: z.enum(RANK_METRICS).default("views"),
  direction: z.enum(["desc", "asc"]).default("desc"),
  limit: z.number().int().min(1).max(RANK_MAX_LIMIT).default(10),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - RANK_MAX_LIMIT).default(0),
}).strict(); // No filters are supported; reject them instead of returning an unfiltered ranking.

const metricValue = z.number().finite().nullable();
const valueState = z.enum(["reported", "null", "absent"]);
export const rankPostsOutput = z.object({
  publication: z.string(),
  source: z.literal("publication_email_stats"),
  metric: z.enum(RANK_METRICS),
  direction: z.enum(["desc", "asc"]),
  offset: count, limit: z.number().int().min(1).max(RANK_MAX_LIMIT),
  total: count, returned: count, has_more: z.boolean(), next_offset: count.nullable(),
  ordering: z.literal("server"),
  unreported_in_page: count,
  rows: z.array(z.object({
    rank: positiveId,
    post_id: positiveId,
    title: z.string().nullable(),
    post_date: z.string().nullable(),
    type: z.string().nullable(),
    value: z.union([z.number().finite(), z.string()]).nullable(),
    value_state: valueState,
    metrics: z.object(Object.fromEntries(RANK_ROW_METRICS.map(name => [name, metricValue])) as Record<(typeof RANK_ROW_METRICS)[number], typeof metricValue>),
    absent_metrics: z.array(z.enum(RANK_ROW_METRICS)),
  })).max(RANK_MAX_LIMIT),
  semantics: z.string(),
});
export type RankPostsResult = Omit<z.output<typeof rankPostsOutput>, "publication">;

const text = z.string().max(10_000).nullish();
const upstream = z.object({
  rows: z.array(z.record(z.unknown())).max(RANK_MAX_LIMIT),
  total: count,
});
// post_date is Substack's own timestamp string, returned unchanged; it must at least parse as a date.
const postDate = z.string().max(64).refine(value => Number.isFinite(Date.parse(value))).nullish();
const rowIdentity = z.object({ post_id: positiveId, title: text, post_date: postDate, type: text });

type Read = (path: string) => Promise<unknown>;
const invalid = () => new Error("Unexpected email statistics response; no ranking can be verified.");

/** One bounded read. Server order is preserved; nothing is re-sorted, filled in or estimated. */
export async function rankPosts(rawInput: z.input<typeof rankPostsInput>, read: Read): Promise<RankPostsResult> {
  const input = rankPostsInput.parse(rawInput);
  const query = new URLSearchParams({ order_by: input.metric, order_direction: input.direction, limit: String(input.limit), offset: String(input.offset) });
  const parsed = upstream.safeParse(await read(`/api/v1/publication/stats/email_stats?${query}`));
  if (!parsed.success || parsed.data.rows.length > input.limit) throw invalid();
  // A page must agree with total: a short or empty page before the end, or rows past it, cannot be ranked honestly.
  const { rows: rawRows, total } = parsed.data;
  if (rawRows.length && input.offset + rawRows.length > total) throw invalid();
  if (rawRows.length < input.limit && input.offset + rawRows.length < total) throw invalid();
  const seen = new Set<number>();
  const rows = parsed.data.rows.map((row, index) => {
    const identity = rowIdentity.safeParse(row);
    if (!identity.success || seen.has(identity.data.post_id)) throw invalid();
    seen.add(identity.data.post_id);
    const metrics = {} as Record<(typeof RANK_ROW_METRICS)[number], number | null>;
    const absent_metrics: (typeof RANK_ROW_METRICS)[number][] = [];
    for (const name of RANK_ROW_METRICS) {
      if (!Object.hasOwn(row, name)) { metrics[name] = null; absent_metrics.push(name); continue; }
      const value = row[name];
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw invalid();
      metrics[name] = value as number | null;
    }
    let value: number | string | null;
    let value_state: z.output<typeof valueState>;
    if (input.metric === "post_date") {
      value = identity.data.post_date ?? null;
      value_state = !Object.hasOwn(row, "post_date") ? "absent" : value === null ? "null" : "reported";
    } else {
      value = metrics[input.metric];
      value_state = absent_metrics.includes(input.metric) ? "absent" : value === null ? "null" : "reported";
    }
    return {
      rank: input.offset + index + 1,
      post_id: identity.data.post_id,
      title: identity.data.title ?? null,
      post_date: identity.data.post_date ?? null,
      type: identity.data.type ?? null,
      value, value_state, metrics, absent_metrics,
    };
  });
  const returned = rows.length;
  const has_more = returned > 0 && input.offset + returned < total;
  const rate = RATE_METRICS.has(input.metric);
  return {
    source: "publication_email_stats",
    metric: input.metric, direction: input.direction, offset: input.offset, limit: input.limit,
    total, returned, has_more, next_offset: has_more ? input.offset + returned : null,
    ordering: "server",
    unreported_in_page: rows.filter(row => row.value_state !== "reported").length,
    rows,
    semantics: [
      "Values are as reported by Substack's dashboard email statistics; this server does not recompute, fill in or estimate them.",
      "Substack does not document rate denominators or units, so open_rate and click_through_rate are passed through unchanged.",
      "value_state 'absent' means the row omitted the field; 'null' means Substack returned null. Neither is zero.",
      rate ? "When ranking by a rate, Substack places null rates among numeric rows rather than at one end; treat their positions as unranked." : "Rows without the metric appear at the end of descending pages and the start of ascending pages.",
      "total is Substack's row count for this statistics list and may exclude posts without email statistics. Pages are separate reads and can shift between calls; a page that contradicts total is rejected.",
      "post_date is Substack's timestamp string, returned unchanged.",
    ].join(" "),
  };
}
