/** Google Calendar booking opt-ins -> the registered Substack MCP tools.
 * No Gmail mutations. Private state and an exclusive lock live outside the repo.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SubstackClient } from "./api/client.js";
import { createServer } from "./server.js";
import { resolvePublications } from "./auth/resolve-publications.js";

const exec = promisify(execFile);
const emailSchema = z.string().email().max(254);
const contactSchema = z.object({ email: emailSchema, answer: z.string(), message_id: z.string(), received_at: z.number().int().nonnegative(), decision: z.enum(["yes", "no", "review"]) });
export type Contact = z.infer<typeof contactSchema>;
const attemptSchema = z.object({ status: z.enum(["attempting", "existing", "verified", "blocked", "unverified", "retryable", "busy"]), message_id: z.string(), attempted_at: z.string() });
const stateSchema = z.object({ version: z.literal(1), publication_url: z.string().url(), organizer_email: emailSchema, seen_ids: z.array(z.string()), contacts: z.record(contactSchema), attempts: z.record(attemptSchema) });
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

type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export async function processContacts(state: SyncState, call: Call, persist: () => void, write: boolean, maxAdds = 5) {
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
      if (write) { state.attempts[key] = { status: "existing", message_id: contact.message_id, attempted_at: new Date().toISOString() }; persist(); }
      continue;
    }
    // Any recorded live attempt is reconciliation-only, even after a crash.
    // Retryable/busy are surfaced for an operator; the scheduler never retries.
    if (prior) { counts.pending++; continue; }
    if (!write) continue;
    if (counts.submitted >= maxAdds) { counts.capped++; continue; }
    state.attempts[key] = { status: "attempting", message_id: contact.message_id, attempted_at: new Date().toISOString() };
    persist(); // Must succeed BEFORE sending an external write.
    counts.submitted++;
    try {
      const result = z.object({ status: attemptSchema.shape.status, email: z.string() }).parse(await call("add_free_subscriber", {
        email: contact.email, consent_confirmed: true, dry_run: false,
        consent_evidence: { source: `gmail:${contact.message_id}`, recorded_at: new Date(contact.received_at).toISOString() },
      }));
      if (result.email !== contact.email) throw new Error("Mismatched add result.");
      state.attempts[key].status = result.status;
      if (result.status === "existing" || result.status === "verified" || result.status === "blocked") counts[result.status]++;
      else counts.pending++;
    } catch { state.attempts[key].status = "unverified"; counts.pending++; }
    persist();
  }
  return counts;
}

function save(path: string, state: SyncState) {
  const temporary = `${path}.new`, fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || (args[1] !== undefined && args[1] !== "--write")) throw new Error("Usage: node dist/calendar-sync.js CONFIG.json [--write]");
  const config = z.object({ organizer_email: emailSchema, publication_url: z.string().url(), publication_key: z.string(), state_path: z.string().min(1), gws_command: z.string().default("gws"), days: z.number().int().min(1).max(365).default(180), max_messages: z.number().int().min(10).max(1000).default(200), max_adds: z.number().int().min(1).max(10).default(5) }).strict().parse(JSON.parse(readFileSync(args[0], "utf8")));
  const statePath = resolve(config.state_path), write = args[1] === "--write";
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  // A stale lock after a crash is deliberately not automatically removed.
  const lockPath = `${statePath}.lock`, lock = openSync(lockPath, "wx", 0o600);
  let client: Client | undefined, server: ReturnType<typeof createServer> | undefined;
  try {
    const state = existsSync(statePath) ? stateSchema.parse(JSON.parse(readFileSync(statePath, "utf8"))) : stateSchema.parse({ version: 1, publication_url: config.publication_url, organizer_email: config.organizer_email, seen_ids: [], contacts: {}, attempts: {} });
    if (state.publication_url !== config.publication_url || state.organizer_email !== config.organizer_email) throw new Error("State belongs to a different publication or organizer.");
    const creds = resolvePublications();
    const selected = creds.find(p => p.key === config.publication_key);
    if (!selected || selected.missing.length || selected.publicationUrl.replace(/\/$/, "") !== config.publication_url.replace(/\/$/, "")) throw new Error("Missing or mismatched publication credentials.");
    const gws = async (operation: "list" | "get", params: Record<string, unknown>) => {
      const result = await exec(config.gws_command, ["gmail", "users", "messages", operation, "--params", JSON.stringify({ userId: "me", ...params })], { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return JSON.parse(result.stdout || "{}");
    };
    const seen = new Set(state.seen_ids), ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = z.object({ resultSizeEstimate: z.number().int().nonnegative(), messages: z.array(z.object({ id: z.string() })).optional(), nextPageToken: z.string().optional() }).parse(await gws("list", { q: `from:${config.organizer_email} subject:"Appointment booked" newer_than:${config.days}d`, maxResults: 10, ...(pageToken ? { pageToken } : {}) }));
      ids.push(...(page.messages ?? []).map(m => m.id)); pageToken = page.nextPageToken;
      if (ids.length > config.max_messages || (pageToken && ids.length >= config.max_messages)) throw new Error("Booking scan exceeded its cap; no adds performed.");
    } while (pageToken);
    for (const id of new Set(ids)) {
      if (seen.has(id)) continue;
      const message = await gws("get", { id, format: "full" }) as BookingMessage;
      if (message.id !== id) throw new Error("Mismatched Gmail message.");
      const contact = parseBooking(message, config.organizer_email);
      if (contact) ingest(state, contact);
      seen.add(id);
    }
    state.seen_ids = [...seen];
    if (write) save(statePath, state);
    server = createServer([{ key: selected.key, label: selected.label, client: new SubstackClient(selected.publicationUrl, selected.sessionToken, selected.userId) }]);
    client = new Client({ name: "calendar-consent-sync", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    const activeClient = client;
    const call: Call = async (name, toolArgs) => {
      const result = await activeClient.callTool({ name, arguments: toolArgs });
      if (result.isError) throw new Error("MCP operation failed.");
      const block = (result.content as Array<{type: string; text?: string}>).find(c => c.type === "text");
      if (!block?.text) throw new Error("Missing MCP result.");
      return JSON.parse(block.text);
    };
    const counts = await processContacts(state, call, () => save(statePath, state), write, config.max_adds);
    console.log(JSON.stringify({ mode: write ? "write" : "dry_run", scanned: ids.length, ...counts }));
  } finally {
    try { await client?.close(); await server?.close(); } finally { closeSync(lock); unlinkSync(lockPath); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Calendar newsletter sync failed; inspect credentials, state, scan cap, and lock. No automatic retry of recorded adds."); process.exitCode = 1; });
}
