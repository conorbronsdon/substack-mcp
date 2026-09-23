import { z } from "zod";
import { AuthenticationError, ResponseError, SubstackAPIError, TimeoutError } from "../utils/errors.js";

type Read = (path: string) => Promise<unknown>;
const finite = z.number().finite();
const reason = z.enum(["http_401", "http_403", "http_404", "http_429", "http_5xx", "http_other", "malformed", "timeout"]);
const unavailable = z.object({ status: z.literal("unavailable"), reason });
const metric = z.object({ value: finite.nullable(), status: z.enum(["reported", "absent", "null"]), unit: z.enum(["count", "percent_0_100", "currency_amount", "views"]), window: z.string().max(120), source: z.string().max(80), captured_at: z.string().datetime(), currency: z.string().max(32).optional() });

const summaryFields = ["appSubscribers", "appSubscribersLast30Days", "subscribers", "subscribersLast30Days", "totalEmail", "totalEmailLast30Days", "views", "viewsDelta", "openRate", "openRateDiff", "pledgesAmount", "numPledges"] as const;
const rangeFields = ["totalSubscribersStart", "totalSubscribersEnd", "paidSubscribersStart", "paidSubscribersEnd", "arrStart", "arrEnd", "totalViewsStart", "totalViewsEnd", "pledgedArrStart", "pledgedArrEnd"] as const;
const summaryRaw = z.object(Object.fromEntries(summaryFields.map(k => [k, finite.nullable().optional()])) as Record<(typeof summaryFields)[number], z.ZodOptional<z.ZodNullable<typeof finite>>>).extend({ pledgeCurrency: z.string().max(32).optional(), isBestseller: z.boolean().optional() });
const rangeRaw = z.object(Object.fromEntries(rangeFields.map(k => [k, finite.nullable().optional()])) as Record<(typeof rangeFields)[number], z.ZodOptional<z.ZodNullable<typeof finite>>>);
const group = z.object({ status: z.literal("available"), source: z.string(), captured_at: z.string(), metrics: z.record(metric), is_bestseller: z.boolean().optional() });
export const publicationStatsInput = z.object({ range_days: z.number().int().min(1).max(365).default(30) }).strict();
export const publicationStatsOutput = z.object({ publication: z.string(), range_days: z.number().int().min(1).max(365), summary: z.union([group, unavailable]), range: z.union([group, unavailable]) });

function malformed(endpoint: string): never { throw new ResponseError(endpoint, "malformed_json"); }
function reasonFor(error: unknown): z.infer<typeof reason> {
  if (error instanceof TimeoutError) return "timeout";
  if (error instanceof ResponseError) return "malformed";
  if (error instanceof SubstackAPIError) {
    if (error.statusCode === 401) return "http_401";
    if (error.statusCode === 403) return "http_403";
    if (error.statusCode === 404) return "http_404";
    if (error.statusCode === 429) return "http_429";
    if (error.statusCode >= 500) return "http_5xx";
    return "http_other";
  }
  return "malformed";
}
function field(value: number | null | undefined, present: boolean, unit: z.infer<typeof metric>["unit"], window: string, source: string, captured_at: string, currency?: string) {
  return { value: value ?? null, status: !present ? "absent" as const : value === null ? "null" as const : "reported" as const, unit, window, source, captured_at, ...(currency ? { currency } : {}) };
}
async function readGroup<T>(path: string, schema: z.ZodType<T>, project: (raw: T) => z.infer<typeof group>, read: Read) {
  try {
    const raw = await read(path);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) malformed(path);
    return { value: project(parsed.data), error: null };
  } catch (error) {
    if (error instanceof SubstackAPIError && error.statusCode === 401) throw error;
    return { value: { status: "unavailable" as const, reason: reasonFor(error) }, error };
  }
}

/** Two independent reads; a failed group never supplies invented values to the other. */
export async function getPublicationStats(input: z.input<typeof publicationStatsInput>, read: Read) {
  const { range_days } = publicationStatsInput.parse(input);
  const summaryPath = "/api/v1/publish-dashboard/summary";
  const rangePath = `/api/v1/publish-dashboard/summary-v2?range=${range_days}`;
  const summary = await readGroup(summaryPath, summaryRaw, raw => {
    const metrics: Record<string, z.infer<typeof metric>> = {};
    const captured_at = new Date().toISOString(), source = "publish-dashboard/summary";
    for (const key of summaryFields) {
      const unit = key.startsWith("openRate") ? "percent_0_100" : key === "pledgesAmount" ? "currency_amount" : key.startsWith("views") ? "views" : "count";
      const window = key.endsWith("Last30Days") ? "last 30 days" : "as reported by Substack's dashboard summary; window not documented";
      metrics[key] = field(raw[key], Object.hasOwn(raw, key), unit, window, source, captured_at, key === "pledgesAmount" ? raw.pledgeCurrency ?? "not_reported" : undefined);
    }
    return { status: "available", source, captured_at, metrics, ...(raw.isBestseller === undefined ? {} : { is_bestseller: raw.isBestseller }) };
  }, read);
  const range = await readGroup(rangePath, rangeRaw, raw => {
    const metrics: Record<string, z.infer<typeof metric>> = {};
    const captured_at = new Date().toISOString(), source = "publish-dashboard/summary-v2";
    for (const key of rangeFields) {
      const unit = key.includes("Views") ? "views" : key.startsWith("arr") || key.startsWith("pledgedArr") ? "currency_amount" : "count";
      metrics[key] = field(raw[key], Object.hasOwn(raw, key), unit, `trailing ${range_days} days ending now (${key.endsWith("Start") ? "start" : "end"})`, source, captured_at, unit === "currency_amount" ? "not_reported" : undefined);
    }
    return { status: "available", source, captured_at, metrics };
  }, read);
  if (summary.value.status === "unavailable" && range.value.status === "unavailable" && [403, 404].includes((summary.error as SubstackAPIError)?.statusCode) && [403, 404].includes((range.error as SubstackAPIError)?.statusCode)) {
    throw new AnalyticsUnavailableError((summary.error as SubstackAPIError).statusCode);
  }
  return { range_days, summary: summary.value, range: range.value };
}

export class AnalyticsUnavailableError extends SubstackAPIError {
  constructor(status: number) { super(status, "Statistics unavailable for this publication or account.", "analytics", undefined, "http"); }
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v);
export const growthSourcesInput = z.object({ from_date: day, to_date: day, limit: z.number().int().min(1).max(50).default(20), include_timeseries: z.boolean().default(false), include_events: z.boolean().default(false) }).strict().superRefine((v, ctx) => {
  const from = Date.parse(`${v.from_date}T00:00:00Z`), to = Date.parse(`${v.to_date}T00:00:00Z`);
  if (from > to || to - from > 366 * 86_400_000 || to > Date.now() + 86_400_000) ctx.addIssue({ code: "custom", message: "Date range must be ordered, at most 366 days, and end by tomorrow UTC." });
});
const short = z.string().max(500);
const point = z.object({ date: short, value: finite });
const growthMetric = z.object({ name: short, total: finite, timeseries: z.array(point).max(5000) });
const node = z.object({ source: short, sourceName: short, originalSourceName: short, category: short, logoUrl: short.nullish(), href: short.nullish(), pubId: z.union([z.number().int(), short]).nullish(), metrics: z.array(growthMetric).max(100), children: z.array(z.unknown()).max(5000) });
const growthRaw = z.object({ sourceMetrics: z.array(z.unknown()).max(5000), totals: z.array(z.object({ name: short, total: finite })).max(500) });
const event = z.object({ id: z.number().int().positive(), date: short, title: short, slug: short, type: short, url: short });
const eventsRaw = z.object({ pubEvents: z.array(event).max(500) });
const projectedMetric = z.object({ name: short, total: finite, timeseries: z.array(point).max(400).optional(), timeseries_truncated: z.boolean() });
const projectedNode: z.ZodType<any> = z.lazy(() => z.object({ source: short, source_name: short, original_source_name: short, category: short, metrics: z.array(projectedMetric).max(100), children: z.array(projectedNode).max(500) }));
export const growthSourcesOutput = z.object({ publication: z.string(), from_date: day, to_date: day, sources: z.array(projectedNode).max(50), totals: z.array(z.object({ name: short, total: finite })).max(500), returned: z.number().int().nonnegative(), total_sources: z.number().int().nonnegative(), has_more: z.boolean(), truncated: z.object({ nodes: z.boolean(), depth: z.boolean(), timeseries: z.boolean() }), events: z.array(event).max(500).optional() });

export async function getGrowthSources(input: z.input<typeof growthSourcesInput>, read: Read) {
  const v = growthSourcesInput.parse(input);
  const query = new URLSearchParams({ from_date: v.from_date, to_date: v.to_date, order_by: "users", order_direction: "desc" });
  const path = `/api/v1/publication/stats/growth/sources?${query}`;
  const root = growthRaw.safeParse(await read(path));
  if (!root.success) malformed(path);
  const truncated = { nodes: false, depth: false, timeseries: false };
  let processed = 0;
  function visit(raw: unknown, depth: number): z.infer<typeof projectedNode> | null {
    if (processed >= 500) { truncated.nodes = true; return null; }
    const parsed = node.safeParse(raw);
    if (!parsed.success) malformed(path);
    processed++;
    const n = parsed.data;
    const children = [];
    if (depth >= 3) { if (n.children.length) truncated.depth = true; }
    else for (const child of n.children) { const projected = visit(child, depth + 1); if (projected) children.push(projected); else break; }
    return { source: n.source, source_name: n.sourceName, original_source_name: n.originalSourceName, category: n.category,
      metrics: n.metrics.map(m => { const cut = m.timeseries.length > 400; if (cut && v.include_timeseries) truncated.timeseries = true; return { name: m.name, total: m.total, ...(v.include_timeseries ? { timeseries: m.timeseries.slice(0, 400) } : {}), timeseries_truncated: v.include_timeseries && cut }; }), children };
  }
  const sources = [];
  for (const raw of root.data.sourceMetrics.slice(0, v.limit)) { const projected = visit(raw, 1); if (projected) sources.push(projected); else break; }
  const events = v.include_events ? eventsRaw.safeParse(await read(`/api/v1/publication/stats/growth/events?from_date=${v.from_date}&to_date=${v.to_date}`)) : null;
  if (events && !events.success) malformed("growth/events");
  return { from_date: v.from_date, to_date: v.to_date, sources, totals: root.data.totals, returned: sources.length, total_sources: root.data.sourceMetrics.length, has_more: sources.length < root.data.sourceMetrics.length, truncated, ...(events ? { events: events.data.pubEvents } : {}) };
}
