import { z } from "zod";
import { SubstackAPIError } from "../utils/errors.js";

const emailSchema = z.string().trim().email().max(254).transform(s => s.toLowerCase());
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

  async get(email: string) {
    const normalized = emailSchema.parse(email);
    const page = await this.list(0, 2, normalized);
    return {
      email: normalized, subscriber: page.subscribers[0] ?? null,
      last_sync: page.lastSync ?? null,
      note: "Absence does not establish eligibility: former subscribers may be suppressed. Dashboard data can lag writes.",
    };
  }

  async add(email: string, consentConfirmed: boolean, dryRun = true): Promise<SubscriberResult> {
    const normalized = emailSchema.parse(email);
    if (consentConfirmed !== true) throw new Error("Explicit newsletter opt-in is required.");
    if (typeof dryRun !== "boolean") throw new Error("dryRun must be a boolean.");
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
          method: "POST", body: JSON.stringify({ email: normalized, subscription: false, sendEmail: false }),
        });
        // {} is normal. It is an acknowledgement, not proof of membership.
        if (!reply || typeof reply !== "object" || Array.isArray(reply) || "error" in reply || "errors" in reply) {
          return { status: "unverified", email: normalized, note: "Unexpected add response. Reconcile membership; do not automatically retry." };
        }
      } catch (error) {
        if (error instanceof SubstackAPIError && error.statusCode === 400) {
          this.attempted.delete(normalized);
          this.blocked.add(normalized);
          return { status: "blocked", email: normalized, note: "Substack rejected the address. It may be invalid or previously unsubscribed. Do not bypass suppression or automatically retry." };
        }
        if (error instanceof SubstackAPIError && [401, 403, 429].includes(error.statusCode)) {
          this.attempted.delete(normalized);
          return { status: "retryable", email: normalized, note: "Substack refused the request due to authentication or rate limiting. Resolve authentication or back off before an explicit retry; no retry was performed." };
        }
        return { status: "unverified", email: normalized, note: "The add request failed or timed out; its outcome is unknown. Reconcile membership before retrying." };
      }
      try {
        const after = await this.get(normalized);
        if (after.subscriber) return { status: "verified", email: normalized, subscriber: after.subscriber, note: "Membership verified after the request. No welcome email requested." };
      } catch { /* The write may have succeeded despite failed verification. */ }
      return { status: "unverified", email: normalized, note: "Request accepted but membership is not yet verified. Dashboard data may lag. Recheck with get_subscriber; do not automatically retry the add." };
    } finally { this.busy.delete(normalized); }
  }
}
