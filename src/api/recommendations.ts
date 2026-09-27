import { z } from "zod";
import { ResponseError } from "../utils/errors.js";

/**
 * Recommendation reads. Direction matters: Substack exposes separate surfaces for
 * who recommends a publication (incoming, dashboard-only) and whom the publication
 * recommends (outgoing). Reading the outgoing list as if it were incoming reports
 * real incoming recommendations as missing, so every result names its direction
 * and source endpoint.
 *
 * Shapes were confirmed against a redacted owner-dashboard capture (September 2026):
 * - `GET /api/v1/recommendations/stats/to` → `{ rows, total }`; each row has
 *   `publication_id` (recommender), `target_publication_id` (this publication),
 *   `xp_signups`, `xp_paid_subs`, `is_active`, `is_mutual`, `created_at`,
 *   `first_activity_at`, `data_updated_at`, `blurb`, and `source_pub` (a full
 *   publication record, including private settings, which is never returned).
 * - `GET /api/v1/recommendations/stats/from` → the same row shape with `target_pub`
 *   (the recommended publication) instead of `source_pub`.
 * - Both stats endpoints reject `limit` above 20 or below 1 with HTTP 400.
 * - `GET /api/v1/recommendations/from/{pubId}` → `{ rows, total }`; each row has
 *   `recommending_publication_id`, `recommended_publication_id`, `created_at`, and
 *   `recommendedPublication`, plus fields (such as a subscribe token) that are never returned.
 *   Its `total` counted 6 recommendations while every page together returned 2, so this
 *   list is not a complete outgoing ledger either; `/stats/from` returned all 6.
 */

type Read = (path: string) => Promise<unknown>;
export const STATS_MAX_LIMIT = 20;
export const OUTGOING_MAX_LIMIT = 50;

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const short = z.string().max(1000);
const offset = z.number().int().min(0).max(100_000).default(0);

export const incomingRecommendationsInput = z.object({ offset, limit: z.number().int().min(1).max(STATS_MAX_LIMIT).default(STATS_MAX_LIMIT) }).strict();
export const outgoingStatsInput = incomingRecommendationsInput;
export const outgoingRecommendationsInput = z.object({ offset, limit: z.number().int().min(1).max(OUTGOING_MAX_LIMIT).default(OUTGOING_MAX_LIMIT) }).strict();

const rawPub = z.object({ id, name: short, subdomain: short.nullish(), custom_domain: short.nullish() });
const rawStatsRow = z.object({
  publication_id: id, target_publication_id: id,
  xp_signups: count.nullish(), xp_paid_subs: count.nullish(),
  is_active: z.boolean().nullish(), is_mutual: z.boolean().nullish(),
  created_at: short.nullish(),
  source_pub: rawPub.nullish(), target_pub: rawPub.nullish(),
});
const rawOutgoingRow = z.object({ recommending_publication_id: id, recommended_publication_id: id, created_at: short.nullish(), recommendedPublication: rawPub.nullish() });
const page = <T extends z.ZodTypeAny>(row: T) => z.object({ rows: z.array(row).max(OUTGOING_MAX_LIMIT), total: count.nullish() });

const pubOut = z.object({ id, name: short.nullable(), subdomain: short.nullable(), custom_domain: short.nullable() });
const pagination = {
  publication: z.string(),
  offset: count, limit: count, returned: count,
  total: count.nullable(), has_more: z.boolean(), next_offset: count.nullable(), ended_before_total: z.boolean(),
};
export const incomingRecommendationsOutput = z.object({
  ...pagination,
  direction: z.literal("incoming"),
  source: z.literal("recommendations/stats/to"),
  recommendations: z.array(z.object({
    recommender: pubOut,
    started_at: short.nullable(),
    active: z.boolean().nullable(),
    mutual: z.boolean().nullable(),
    subscribers_attributed: count.nullable(),
    paid_subscribers_attributed: count.nullable(),
  })).max(STATS_MAX_LIMIT),
});
export const outgoingStatsOutput = z.object({
  ...pagination,
  direction: z.literal("outgoing"),
  source: z.literal("recommendations/stats/from"),
  recommendations: z.array(z.object({
    recommended: pubOut,
    started_at: short.nullable(),
    active: z.boolean().nullable(),
    mutual: z.boolean().nullable(),
    subscribers_sent: count.nullable(),
    paid_subscribers_sent: count.nullable(),
  })).max(STATS_MAX_LIMIT),
});
export const outgoingRecommendationsOutput = z.object({
  ...pagination,
  direction: z.literal("outgoing"),
  source: z.literal("recommendations/from"),
  recommendations: z.array(z.object({ recommended: pubOut, started_at: short.nullable() })).max(OUTGOING_MAX_LIMIT),
});

/** The publication identity read failed with 403/404, so no recommendation request was made. */
export class PublicationIdentityUnavailableError extends Error {
  constructor(public readonly statusCode: number) { super("Publication identity unavailable."); this.name = "PublicationIdentityUnavailableError"; }
}

/** A row claimed a different publication than the one selected; nothing from the page is returned. */
export class RecommendationScopeError extends Error {
  constructor() { super("Recommendation response does not belong to the selected publication."); this.name = "RecommendationScopeError"; }
}

function project(pub: z.infer<typeof rawPub> | null | undefined, fallbackId: number) {
  if (pub && pub.id !== fallbackId) throw new RecommendationScopeError();
  return { id: fallbackId, name: pub?.name ?? null, subdomain: pub?.subdomain ?? null, custom_domain: pub?.custom_domain ?? null };
}

function paginate(offsetValue: number, limit: number, returned: number, total: number | null | undefined) {
  // Only an empty page, or reaching Substack's total, ends the list. Some endpoints return short
  // pages while more rows exist, so a short nonempty page continues when total says so.
  const has_more = returned > 0 && (typeof total === "number" ? offsetValue + returned < total : returned === limit);
  // Substack's total can count rows an endpoint never returns (observed on /recommendations/from).
  const ended_before_total = !has_more && typeof total === "number" && offsetValue + returned < total;
  return { offset: offsetValue, limit, returned, total: total ?? null, has_more, next_offset: has_more ? offsetValue + returned : null, ended_before_total };
}

async function readPage<T extends z.ZodTypeAny>(path: string, row: T, read: Read, limit: number) {
  const parsed = page(row).safeParse(await read(path));
  if (!parsed.success || parsed.data.rows.length > limit) throw new ResponseError(path, "malformed_json");
  return parsed.data as { rows: z.infer<T>[]; total?: number | null };
}

function statsQuery(offsetValue: number, limit: number) {
  return new URLSearchParams({ offset: String(offsetValue), limit: String(limit), order_by: "xp_signups", order_direction: "desc" });
}

/** Who recommends the selected publication, with dashboard-attributed subscribers. */
export async function listIncomingRecommendations(input: z.input<typeof incomingRecommendationsInput>, publicationId: number, read: Read) {
  const v = incomingRecommendationsInput.parse(input);
  const path = `/api/v1/recommendations/stats/to?${statsQuery(v.offset, v.limit)}`;
  const data = await readPage(path, rawStatsRow, read, v.limit);
  const recommendations = data.rows.map(r => {
    if (r.target_publication_id !== publicationId) throw new RecommendationScopeError();
    return { recommender: project(r.source_pub, r.publication_id), started_at: r.created_at ?? null, active: r.is_active ?? null, mutual: r.is_mutual ?? null,
      subscribers_attributed: r.xp_signups ?? null, paid_subscribers_attributed: r.xp_paid_subs ?? null };
  });
  return { direction: "incoming" as const, source: "recommendations/stats/to" as const, ...paginate(v.offset, v.limit, recommendations.length, data.total), recommendations };
}

/** Subscribers the selected publication sent to the publications it recommends. */
export async function listOutgoingRecommendationStats(input: z.input<typeof outgoingStatsInput>, publicationId: number, read: Read) {
  const v = outgoingStatsInput.parse(input);
  const path = `/api/v1/recommendations/stats/from?${statsQuery(v.offset, v.limit)}`;
  const data = await readPage(path, rawStatsRow, read, v.limit);
  const recommendations = data.rows.map(r => {
    if (r.publication_id !== publicationId) throw new RecommendationScopeError();
    return { recommended: project(r.target_pub, r.target_publication_id), started_at: r.created_at ?? null, active: r.is_active ?? null, mutual: r.is_mutual ?? null,
      subscribers_sent: r.xp_signups ?? null, paid_subscribers_sent: r.xp_paid_subs ?? null };
  });
  return { direction: "outgoing" as const, source: "recommendations/stats/from" as const, ...paginate(v.offset, v.limit, recommendations.length, data.total), recommendations };
}

/** Whom the selected publication recommends. Not who recommends it. */
export async function listOutgoingRecommendations(input: z.input<typeof outgoingRecommendationsInput>, publicationId: number, read: Read) {
  const v = outgoingRecommendationsInput.parse(input);
  const query = new URLSearchParams({ offset: String(v.offset), limit: String(v.limit), paginate: "true" });
  const path = `/api/v1/recommendations/from/${publicationId}?${query}`;
  const data = await readPage(path, rawOutgoingRow, read, v.limit);
  const recommendations = data.rows.map(r => {
    if (r.recommending_publication_id !== publicationId) throw new RecommendationScopeError();
    return { recommended: project(r.recommendedPublication, r.recommended_publication_id), started_at: r.created_at ?? null };
  });
  return { direction: "outgoing" as const, source: "recommendations/from" as const, ...paginate(v.offset, v.limit, recommendations.length, data.total), recommendations };
}
