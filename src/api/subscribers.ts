import { z } from "zod";
import { SubstackAPIError } from "../utils/errors.js";

const emailSchema = z.string().trim().email().max(254).transform(s => s.toLowerCase());
export const consentEvidenceSchema = z.object({
  source: z.string().trim().min(1).max(500),
  recorded_at: z.string().datetime({ offset: true }),
});
export type ConsentEvidence = z.infer<typeof consentEvidenceSchema>;
const rowSchema = z.object({
  user_email_address: emailSchema,
  subscription_id: z.number().int().positive(),
  subscription_interval: z.string().nullable(),
});
const pageSchema = z.object({
  count: z.number().int().nonnegative(),
  subscribers: z.array(rowSchema),
  lastSync: z.string().optional(),
});

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
export const subscriberSearchInput = z.object({
  subscription_types: z.array(z.enum(["free", "paid", "comp"])).min(1).max(3).refine(values => new Set(values).size === values.length).optional(),
  activity_rating_min: z.number().int().min(0).max(5).optional(),
  activity_rating_max: z.number().int().min(0).max(5).optional(),
  created_before: date.optional().describe("YYYY-MM-DD, exclusive: created before the start of this date; Substack's day boundary timezone is not verified"),
  created_on_or_after: date.optional().describe("YYYY-MM-DD, created on or after this date"),
  search: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(["created_desc", "created_asc", "activity_desc", "activity_asc"]).default("created_desc"),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 50).default(0),
  limit: z.number().int().min(1).max(50).default(10),
  include: z.array(z.enum(["activity_rating", "created_at", "flags", "revenue"])).max(4).refine(values => new Set(values).size === values.length).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.activity_rating_min !== undefined && value.activity_rating_max !== undefined && value.activity_rating_min > value.activity_rating_max) {
    for (const field of ["activity_rating_min", "activity_rating_max"]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Activity rating minimum must not exceed maximum." });
  }
  if (value.created_on_or_after !== undefined && value.created_before !== undefined && value.created_on_or_after >= value.created_before) {
    for (const field of ["created_on_or_after", "created_before"]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "created_on_or_after must be earlier than created_before." });
  }
});
export type SubscriberSearchInput = z.input<typeof subscriberSearchInput>;

const searchRow = rowSchema.extend({
  subscription_interval: z.string().max(40).nullable(),
  activity_rating: z.number().finite().nullable(),
  subscription_created_at: z.string().datetime({ offset: true }).max(40).nullable(),
  total_revenue_generated: z.number().finite().nullable(),
  is_comp: z.boolean().nullable(), is_founding: z.boolean().nullable(), is_gift: z.boolean().nullable(), is_free_trial: z.boolean().nullable(),
});
const searchPage = z.object({ count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), subscribers: z.array(searchRow).max(50) });
export class SubscriberSearchError extends SubstackAPIError {
  constructor(public code: "filter_rejected" | "filter_not_honored" | "invalid_subscriber_response") {
    super(code === "filter_rejected" ? 400 : 502, "Subscriber search could not be verified.", "/api/v1/subscriber-stats", undefined, code === "filter_rejected" ? "http" : "client");
  }
}

export type Subscriber = z.infer<typeof rowSchema>;
export interface SubscriberResult {
  status: "existing" | "verified" | "dry_run" | "blocked" | "unverified" | "busy" | "retryable";
  email: string;
  subscriber?: Subscriber;
  note: string;
}

type Request = (path: string, options?: RequestInit) => Promise<unknown>;

/** Unofficial admin API. Never interpret is_subscribed as free membership:
 * that field indicates paid-content access. Never expose a resubscribe override.
 */
export class SubscriberService {
  // Prevent a second write after an unknown outcome during this client lifetime.
  // Durable callers must also persist their own attempt ledger before calling.
  private attempted = new Set<string>();
  private blocked = new Set<string>();
  private busy = new Set<string>();
  constructor(private request: Request) {}

  async list(offset = 0, limit = 10, email?: string) {
    z.number().int().min(0).parse(offset);
    z.number().int().min(1).max(50).parse(limit);
    const normalized = email === undefined ? undefined : emailSchema.parse(email);
    const filters = normalized
      ? { user_email_address_string_is: normalized }
      : { order_by_desc_nulls_last: "subscription_created_at" };
    const result = pageSchema.parse(await this.request("/api/v1/subscriber-stats", {
      method: "POST", body: JSON.stringify({ filters, limit, offset }),
    }));
    // Fail closed if the upstream stops honoring the exact-email filter.
    if (normalized && (result.count > 1 || result.count !== result.subscribers.length || result.subscribers.some(s => s.user_email_address !== normalized))) {
      throw new Error("Substack returned an unexpected exact-email lookup result; no write is safe.");
    }
    if (result.count > 0 && offset === 0 && result.subscribers.length === 0) {
      throw new Error("Substack returned an incomplete subscriber page.");
    }
    return result;
  }

  async search(input: SubscriberSearchInput = {}) {
    const args = subscriberSearchInput.parse(input);
    const column = args.sort.startsWith("created") ? "subscription_created_at" : "activity_rating";
    const filters: Record<string, string | number | string[]> = {
      [args.sort.endsWith("desc") ? "order_by_desc_nulls_last" : "order_by"]: column,
    };
    if (args.subscription_types) {
      if (args.subscription_types.length === 1 && args.subscription_types[0] === "free") filters.subscription_type = "free";
      else filters.subscription_type_in = args.subscription_types;
    }
    if (args.activity_rating_min !== undefined) filters.activity_rating_gte = args.activity_rating_min;
    if (args.activity_rating_max !== undefined) filters.activity_rating_lte = args.activity_rating_max;
    if (args.created_before) filters.subscription_created_at_is_on_or_before = args.created_before;
    if (args.created_on_or_after) filters.subscription_created_at_gte = args.created_on_or_after;
    if (args.search) filters.search = args.search;
    let raw: unknown;
    try { raw = await this.request("/api/v1/subscriber-stats", { method: "POST", body: JSON.stringify({ filters, limit: args.limit, offset: args.offset }) }); }
    catch (error) {
      if (error instanceof SubstackAPIError && error.statusCode === 400) throw new SubscriberSearchError("filter_rejected");
      throw error;
    }
    const parsed = searchPage.safeParse(raw);
    if (!parsed.success) throw new SubscriberSearchError("invalid_subscriber_response");
    const { count, subscribers } = parsed.data;
    const end = args.offset + subscribers.length;
    if (subscribers.length > args.limit || (subscribers.length > 0 && end > count) || (end < count && subscribers.length === 0)) throw new SubscriberSearchError("invalid_subscriber_response");
    for (const row of subscribers) {
      // Substack's date boundary timezone is unknown. Only contradict timestamps
      // that are at least fourteen hours outside the requested UTC boundary.
      const createdAt = row.subscription_created_at === null ? null : Date.parse(row.subscription_created_at.replace(/(\.\d{3})\d+/, "$1"));
      if ((args.activity_rating_min !== undefined && (row.activity_rating === null || row.activity_rating < args.activity_rating_min))
        || (args.activity_rating_max !== undefined && (row.activity_rating === null || row.activity_rating > args.activity_rating_max))
        || (args.created_on_or_after !== undefined && (createdAt === null || !Number.isFinite(createdAt) || createdAt < Date.parse(`${args.created_on_or_after}T00:00:00Z`) - 14 * 60 * 60 * 1000))
        || (args.created_before !== undefined && (createdAt === null || !Number.isFinite(createdAt) || createdAt >= Date.parse(`${args.created_before}T00:00:00Z`) + 14 * 60 * 60 * 1000))
        || (args.subscription_types?.length === 1 && args.subscription_types[0] === "free" && row.subscription_interval !== "free")
        || (args.subscription_types !== undefined && !args.subscription_types.includes("free") && (row.subscription_interval === null || row.subscription_interval === "free"))
        || (args.subscription_types?.length === 1 && args.subscription_types[0] === "comp" && row.is_comp !== true)
        || (args.subscription_types !== undefined && !args.subscription_types.includes("comp") && row.is_comp !== false)) throw new SubscriberSearchError("filter_not_honored");
    }
    const has_more = end < count;
    return {
      total_matching: count, returned: subscribers.length, offset: args.offset, limit: args.limit,
      has_more, next_offset: has_more ? end : null, applied_filters: filters, sort: args.sort,
      note: "total_matching is Substack's count at read time; dashboard data can lag writes and pagination is not a snapshot.",
      subscribers: subscribers.map(row => ({
        user_email_address: row.user_email_address, subscription_id: row.subscription_id, subscription_interval: row.subscription_interval,
        ...(args.include.includes("activity_rating") ? { activity_rating: row.activity_rating } : {}),
        ...(args.include.includes("created_at") ? { created_at: row.subscription_created_at } : {}),
        ...(args.include.includes("revenue") ? { revenue: row.total_revenue_generated } : {}),
        ...(args.include.includes("flags") ? { is_comp: row.is_comp, is_founding: row.is_founding, is_gift: row.is_gift, is_free_trial: row.is_free_trial } : {}),
      })),
    };
  }

  async get(email: string) {
    const normalized = emailSchema.parse(email);
    const page = await this.list(0, 2, normalized);
    return {
      email: normalized, subscriber: page.subscribers[0] ?? null,
      last_sync: page.lastSync ?? null,
      note: "Absence does not establish eligibility: former subscribers may be suppressed. Dashboard data can lag writes.",
    };
  }

  async add(email: string, consentConfirmed: boolean, dryRun = true, evidence?: ConsentEvidence, sendWelcomeEmail = false): Promise<SubscriberResult> {
    const normalized = emailSchema.parse(email);
    if (consentConfirmed !== true) throw new Error("Explicit newsletter opt-in is required.");
    if (typeof sendWelcomeEmail !== "boolean") throw new Error("sendWelcomeEmail must be a boolean.");
    if (typeof dryRun !== "boolean") throw new Error("dryRun must be a boolean.");
    if (!dryRun) consentEvidenceSchema.parse(evidence);
    if (this.busy.has(normalized)) return { status: "busy", email: normalized, note: "Another operation is in progress for this email. This call performed no write; wait for that operation to finish." };
    this.busy.add(normalized);
    try {
      const before = await this.get(normalized);
      if (before.subscriber) return { status: "existing", email: normalized, subscriber: before.subscriber, note: "Already listed; no write performed." };
      if (this.blocked.has(normalized)) return { status: "blocked", email: normalized, note: "Substack previously rejected this address. No write performed; review without bypassing suppression." };
      if (this.attempted.has(normalized)) return { status: "unverified", email: normalized, note: "A previous write has an unknown outcome. No second write performed. Reconcile through Substack before retrying." };
      if (dryRun) return { status: "dry_run", email: normalized, note: "Not currently listed. A live add may still be blocked by Substack suppression. No write performed." };
      this.attempted.add(normalized);
      try {
        const reply = await this.request("/api/v1/subscriber/add", {
          method: "POST", body: JSON.stringify({ email: normalized, subscription: false, sendEmail: sendWelcomeEmail }),
        });
        // {} is normal. It is an acknowledgement, not proof of membership.
        if (!reply || typeof reply !== "object" || Array.isArray(reply) || "error" in reply || "errors" in reply) {
          return { status: "unverified", email: normalized, note: "Unexpected add response. Reconcile membership; do not automatically retry." };
        }
      } catch (error) {
        if (error instanceof SubstackAPIError && error.statusCode === 400) {
          this.attempted.delete(normalized);
          this.blocked.add(normalized);
          return { status: "blocked", email: normalized, note: "Substack rejected the request (HTTP 400). The address may be invalid or suppressed, or the request format may have changed. Review without bypassing suppression or automatically retrying." };
        }
        if (error instanceof SubstackAPIError && [401, 403, 429].includes(error.statusCode)) {
          this.attempted.delete(normalized);
          return { status: "retryable", email: normalized, note: "Substack refused the request due to authentication or rate limiting. Resolve authentication or back off before an explicit retry; no retry was performed." };
        }
        return { status: "unverified", email: normalized, note: "The add request failed or timed out; its outcome is unknown. Reconcile membership before retrying." };
      }
      try {
        const after = await this.get(normalized);
        if (after.subscriber) return { status: "verified", email: normalized, subscriber: after.subscriber, note: sendWelcomeEmail ? "Membership verified. Welcome email requested; delivery is not independently verified." : "Membership verified after the request. No welcome email requested." };
      } catch { /* The write may have succeeded despite failed verification. */ }
      return { status: "unverified", email: normalized, note: "Request accepted but membership is not yet verified. Dashboard data may lag. Recheck with get_subscriber; do not automatically retry the add." };
    } finally { this.busy.delete(normalized); }
  }
}
