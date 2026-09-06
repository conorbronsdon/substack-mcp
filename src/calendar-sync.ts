/** Google Calendar booking opt-ins -> the registered Substack MCP tools.
 * No Gmail mutations. Private state and an exclusive lock live outside the repo.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { stateSchema, ingest, parseBooking, processContacts, type SyncState, type BookingMessage, type Call } from "./calendar-consent.js";
export { contactKey, ingest, parseBooking, processContacts, type BookingMessage, type SyncState, type Contact } from "./calendar-consent.js";
const emailSchema = z.string().email().max(254);

function save(path: string, state: SyncState) {
  const temporary = `${path}.new`, fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || (args[1] !== undefined && args[1] !== "--write")) throw new Error("Usage: node dist/calendar-sync.js CONFIG.json [--write]");
  const config = z.object({ organizer_email: emailSchema, publication_url: z.string().url(), publication_key: z.string(), state_path: z.string().min(1), gws_command: z.string().default("gws"), days: z.number().int().min(1).max(365).default(180), max_messages: z.number().int().min(10).max(1000).default(200), max_adds: z.number().int().min(1).max(10).default(5), send_welcome_email: z.boolean().default(false) }).strict().parse(JSON.parse(readFileSync(args[0], "utf8")));
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
    const counts = await processContacts(state, call, () => save(statePath, state), write, config.max_adds, config.send_welcome_email);
    console.log(JSON.stringify({ mode: write ? "write" : "dry_run", scanned: ids.length, ...counts }));
  } finally {
    try { await client?.close(); await server?.close(); } finally { closeSync(lock); unlinkSync(lockPath); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Calendar newsletter sync failed; inspect credentials, state, scan cap, and lock. No automatic retry of recorded adds."); process.exitCode = 1; });
}
