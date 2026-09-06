import { createHash } from "node:crypto";
import { z } from "zod";

const emailSchema = z.string().email().max(254);
const contactSchema = z.object({ email: emailSchema, answer: z.string(), message_id: z.string(), received_at: z.number().int().nonnegative(), decision: z.enum(["yes", "no", "review"]) });
export type Contact = z.infer<typeof contactSchema>;
const attemptSchema = z.object({ status: z.enum(["attempting", "existing", "verified", "blocked", "unverified", "retryable", "busy"]), message_id: z.string(), attempted_at: z.string(), welcome_email_requested: z.boolean().optional() });
export const stateSchema = z.object({ version: z.literal(1), publication_url: z.string().url(), organizer_email: emailSchema, seen_ids: z.array(z.string()), contacts: z.record(contactSchema), attempts: z.record(attemptSchema) });
export type SyncState = z.infer<typeof stateSchema>;
export const contactKey = (email: string) => createHash("sha256").update(email.toLowerCase()).digest("hex");

interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Array<{name: string; value: string}> }
export interface BookingMessage { id: string; internalDate: string; payload: Part }
function plainText(part: Part): string {
  if (part.mimeType === "text/plain") return Buffer.from(part.body?.data ?? "", "base64url").toString("utf8");
  return (part.parts ?? []).map(plainText).find(Boolean) ?? "";
}
function mailbox(value: string) { return (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase(); }

export function parseBooking(message: BookingMessage, organizer: string): Contact | null {
  const headers = Object.fromEntries((message.payload.headers ?? []).map(h => [h.name.toLowerCase(), h.value]));
  if (!headers.subject?.startsWith("Appointment booked:") || mailbox(headers.from ?? "") !== organizer.toLowerCase() || mailbox(headers.sender ?? "") !== "calendar-notification@google.com") return null;
  const text = plainText(message.payload).replace(/\r\n?/g, "\n");
  const bookers = [...text.matchAll(/^Booked by\n[^\n]+\n([^\s@]+@[^\s@]+)\s*\n/gm)];
  if (bookers.length !== 1) return null;
  const email = bookers[0][1].trim().toLowerCase();
  const answers = [...text.matchAll(/^Would you like to sign up for my newsletter\?\n([^\n]+)/gm)];
  const answer = answers.length === 1 ? answers[0][1].trim() : "";
  const normalized = answer.toLowerCase().replace(/[.,!:)]+$/g, "").replace(/,/g, "").trim();
  const yes = new Set(["yes", "y", "sure", "sounds good", "yes please", "yep", "absolutely", "yeah", "heck yeah", "yessir"]);
  const no = new Set(["no", "no thanks", "no thank you", "nope", "not at this time"]);
  const parsed = contactSchema.safeParse({ email, answer, message_id: message.id, received_at: Number(message.internalDate), decision: yes.has(normalized) ? "yes" : no.has(normalized) ? "no" : "review" });
  return parsed.success ? parsed.data : null;
}

export function ingest(state: SyncState, contact: Contact) {
  const key = contactKey(contact.email), previous = state.contacts[key];
  if (!previous || contact.received_at > previous.received_at || (contact.received_at === previous.received_at && contact.message_id > previous.message_id)) state.contacts[key] = contact;
}

export type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export async function processContacts(state: SyncState, call: Call, persist: () => void | Promise<void>, write: boolean, maxAdds = 5, sendWelcomeEmail = false) {
  const counts = { eligible: 0, existing: 0, verified: 0, blocked: 0, pending: 0, review: 0, no: 0, submitted: 0, capped: 0 };
  for (const [key, contact] of Object.entries(state.contacts)) {
    if (contact.decision !== "yes") { counts[contact.decision === "no" ? "no" : "review"]++; continue; }
    counts.eligible++;
    const prior = state.attempts[key];
    if (prior && ["existing", "verified", "blocked"].includes(prior.status)) {
      counts[prior.status as "existing" | "verified" | "blocked"]++; continue;
    }
    const lookup = z.object({ subscriber: z.object({ user_email_address: z.string(), subscription_id: z.number() }).passthrough().nullable() }).parse(await call("get_subscriber", { email: contact.email }));
    if (lookup.subscriber) {
      if (lookup.subscriber.user_email_address.toLowerCase() !== contact.email) throw new Error("Mismatched subscriber lookup.");
      counts.existing++;
      if (write) { state.attempts[key] = { status: "existing", message_id: contact.message_id, attempted_at: new Date().toISOString() }; await persist(); }
      continue;
    }
    // Any recorded live attempt is reconciliation-only, even after a crash.
    // Retryable/busy are surfaced for an operator; the scheduler never retries.
    if (prior) { counts.pending++; continue; }
    if (!write) continue;
    if (counts.submitted >= maxAdds) { counts.capped++; continue; }
    state.attempts[key] = { status: "attempting", message_id: contact.message_id, attempted_at: new Date().toISOString(), welcome_email_requested: sendWelcomeEmail };
    await persist(); // Must succeed BEFORE sending an external write.
    counts.submitted++;
    try {
      const result = z.object({ status: attemptSchema.shape.status, email: z.string() }).parse(await call("add_free_subscriber", {
        email: contact.email, consent_confirmed: true, dry_run: false,
        ...(sendWelcomeEmail ? { send_welcome_email: true } : {}),
        consent_evidence: { source: `gmail:${contact.message_id}`, recorded_at: new Date(contact.received_at).toISOString() },
      }));
      if (result.email !== contact.email) throw new Error("Mismatched add result.");
      state.attempts[key].status = result.status;
      if (result.status === "existing" || result.status === "verified" || result.status === "blocked") counts[result.status]++;
      else counts.pending++;
    } catch { state.attempts[key].status = "unverified"; counts.pending++; }
    await persist();
  }
  return counts;
}

