import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createServer } from "./server.js";
import { SubstackClient } from "./api/client.js";
import { resolvePublications } from "./auth/resolve-publications.js";
import { doctor } from "./doctor.js";
import packageMetadata from "../package.json" with { type: "json" };

export async function runStatus(args: string[], load = resolvePublications,
  io = { out: (text: string) => console.log(text), error: (text: string) => console.error(text) }): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    io.out("Usage: substack-mcp status [--json]\nOffline configuration status; never launches a browser or checks remote authentication. Use doctor --json --check-auth for an opt-in authenticated read."); return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    io.error(JSON.stringify({ format_version: 1, ok: false, command: "status", code: "invalid_arguments", message: "Usage: substack-mcp status [--json]" })); return 2;
  }
  const result = await doctor(false, load);
  io.out(JSON.stringify({ format_version: 1, command: "status", ...result, runtime: { node: process.version, platform: process.platform }, version: packageMetadata.version }));
  return result.ok ? 0 : 1;
}

const usage = `Usage: substack-mcp drafts list [--offset n] [--limit 1-50] [--publication key]
       substack-mcp drafts get <draft-id> [--publication key]
       substack-mcp analytics post <post-id> [--publication key]
       substack-mcp subscribers count [--publication key]
       substack-mcp subscribers get <email> [--publication key]
Read-only JSON output. --json is accepted explicitly. Pagination performs one bounded page, not an automatic full export.
Subscriber and draft results are private; protect redirected output. Analytics uses the same bounded recent-post scan as MCP.
Failures keep code read_failed and add a category (authentication, rate_limited, timeout, not_found, invalid_request, upstream_unavailable, response_invalid, response_too_large, cancelled, output_limit, configuration, unknown).`;

function integer(value: string | undefined, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (!value || !/^\d+$/.test(value)) throw new Error("invalid argument");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error("invalid argument");
  return number;
}

function parse(args: string[]) {
  const command = args.slice(0, 2).join(" ");
  const tools: Record<string, string> = { "drafts list": "list_drafts", "drafts get": "get_draft", "analytics post": "get_post_analytics", "subscribers count": "get_subscriber_count", "subscribers get": "get_subscriber" };
  const tool = tools[command];
  if (!tool) throw new Error("invalid command");
  const input: Record<string, unknown> = {};
  let index = 2;
  if (command === "drafts get") input.draft_id = integer(args[index++], 1);
  if (command === "analytics post") input.post_id = integer(args[index++], 1);
  if (command === "subscribers get") input.email = z.string().trim().email().max(254).parse(args[index++]);
  let publication: string | undefined;
  const seen = new Set<string>();
  while (index < args.length) {
    const flag = args[index++];
    if (seen.has(flag)) throw new Error("duplicate option");
    seen.add(flag);
    if (flag === "--json") continue;
    const value = args[index++];
    if (flag === "--publication") {
      if (!value || value.startsWith("--") || value.length > 128) throw new Error("invalid selection");
      publication = value;
    } else if (command === "drafts list" && flag === "--offset") input.offset = integer(value, 0, Number.MAX_SAFE_INTEGER - 50);
    else if (command === "drafts list" && flag === "--limit") input.limit = integer(value, 1, 50);
    else throw new Error("unknown option");
  }
  return { command, tool, input, publication };
}

export type FailureCategory = "authentication" | "rate_limited" | "timeout" | "not_found" | "invalid_request" | "upstream_unavailable"
  | "response_invalid" | "response_too_large" | "cancelled" | "output_limit" | "configuration" | "unknown";
export interface FailureProjection { category: FailureCategory; upstream_code?: string; status?: number; status_source?: "http" | "client"; retry_after?: string; message: string }

const failureMessages: Record<FailureCategory, string> = {
  authentication: "Substack rejected the session or blocked the request. Check with doctor --json --check-auth and refresh the session with substack-mcp login.",
  rate_limited: "Substack rate limited the request. Wait before an explicit retry; retry_after is included when Substack supplied a valid value.",
  timeout: "The request hit its deadline before a complete response. Raise SUBSTACK_REQUEST_TIMEOUT_MS if the publication is slow.",
  not_found: "Substack reported that the requested item was not found.",
  invalid_request: "Substack rejected the request parameters.",
  upstream_unavailable: "Substack returned a server error. Try again later.",
  response_invalid: "The response could not be verified: it was HTML, malformed, a rejected redirect or outside the tool contract. Check the configured publication origin with doctor --json --check-auth.",
  response_too_large: "The upstream response or tool result exceeded its byte limit; no partial result was returned.",
  cancelled: "The request was cancelled before completion.",
  output_limit: "The read completed, but the CLI result exceeded 4 MiB; no partial result was printed.",
  configuration: "Credential or publication configuration could not be loaded. Check with substack-mcp status --json.",
  unknown: "The read could not be completed within its response bounds. Check configuration and authentication with doctor --json --check-auth.",
};
const codeCategories = new Map<string, FailureCategory>([
  ["timeout", "timeout"], ["request_cancelled", "cancelled"], ["response_too_large", "response_too_large"], ["result_too_large", "response_too_large"],
  ["unexpected_html", "response_invalid"], ["malformed_json", "response_invalid"], ["redirect_rejected", "response_invalid"], ["invalid_tool_output", "response_invalid"],
]);

function failure(category: FailureCategory, fields: Omit<FailureProjection, "category" | "message"> = {}): FailureProjection {
  return { category, ...fields, message: `${failureMessages[category]} No writes were attempted.` };
}

function retryAfter(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  if (/^\d{1,10}$/.test(value)) return value;
  return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/**
 * Project the MCP boundary's isError JSON to credential-safe CLI fields. Only
 * whitelisted, validated values are copied; upstream messages and non-JSON
 * exception text are never printed. Client-generated codes win over their
 * synthetic statuses (408 for timeouts, 502 for response failures).
 */
export function projectFailure(text: string): FailureProjection {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return failure("unknown"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failure("unknown");
  const { code, status, status_source, retry_after } = parsed as Record<string, unknown>;
  const fields: Omit<FailureProjection, "category" | "message"> = {};
  if (typeof code === "string" && /^[a-z_]{1,64}$/.test(code)) fields.upstream_code = code;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) fields.status = status;
  if (status_source === "http" || status_source === "client") fields.status_source = status_source;
  const retry = retryAfter(retry_after);
  if (retry) fields.retry_after = retry;
  const byCode = fields.upstream_code === undefined ? undefined : codeCategories.get(fields.upstream_code);
  if (byCode) return failure(byCode, fields);
  const http = fields.status_source === "client" ? undefined : fields.status;
  const category: FailureCategory = http === 401 || http === 403 ? "authentication" : http === 429 ? "rate_limited" : http === 404 ? "not_found"
    : http === 400 ? "invalid_request" : http !== undefined && http >= 500 ? "upstream_unavailable" : "unknown";
  return failure(category, fields);
}

/** Uses the real MCP handlers so projection, pagination and read semantics stay shared. */
export async function runOperator(args: string[], load = resolvePublications,
  io = { out: (text: string) => console.log(text), error: (text: string) => console.error(text) }): Promise<number> {
  if (args.length >= 2 && ["--help", "-h"].includes(args.at(-1)!) && args.length <= 3) { io.out(usage); return 0; }
  let options: ReturnType<typeof parse>;
  try { options = parse(args); }
  catch { io.error(JSON.stringify({ format_version: 1, ok: false, code: "invalid_arguments", message: usage })); return 2; }
  const fail = (projection: FailureProjection) => { io.error(JSON.stringify({ format_version: 1, ok: false, command: options.command, code: "read_failed", ...projection })); return 1; };
  let server: ReturnType<typeof createServer> | undefined;
  const client = new Client({ name: "substack-operator-cli", version: "1" });
  let configured = false;
  try {
    const publications = load();
    const selected = options.publication ? publications.find(p => p.key === options.publication) : publications.length === 1 ? publications[0] : undefined;
    if (!selected) {
      io.error(JSON.stringify({ format_version: 1, ok: false, command: options.command, code: "publication_required", message: "Select a configured --publication key; required when multiple publications are configured." })); return 2;
    }
    const userAgent = process.env.SUBSTACK_USER_AGENT;
    // An invalid header value would otherwise fail later, inside a request, as an unknown error.
    if (userAgent) new Headers({ "user-agent": userAgent });
    server = createServer([{ key: selected.key, label: selected.label, client: new SubstackClient(selected.publicationUrl, selected.sessionToken, selected.userId, userAgent, Number(process.env.SUBSTACK_REQUEST_TIMEOUT_MS) || undefined) }]);
    configured = true;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    const reply = await client.callTool({ name: options.tool, arguments: options.input });
    const content = reply.content as { type: string; text?: string }[];
    const text = content.length === 1 && content[0].type === "text" ? content[0].text : undefined;
    if (reply.isError) return fail(text === undefined ? failure("unknown") : projectFailure(text));
    if (!text) return fail(failure("unknown"));
    const output = JSON.stringify({ format_version: 1, ok: true, command: options.command, publication: selected.key, data: JSON.parse(text) });
    if (Buffer.byteLength(output, "utf8") > 4 * 1024 * 1024) return fail(failure("output_limit"));
    io.out(output); return 0;
  } catch {
    return fail(failure(configured ? "unknown" : "configuration"));
  } finally { await client.close(); await server?.close(); }
}
