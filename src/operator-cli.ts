import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { validateHeaderValue } from "node:http";
import { z } from "zod";
import { createServer } from "./server.js";
import { SubstackClient } from "./api/client.js";
import { resolvePublications } from "./auth/resolve-publications.js";
import { doctor } from "./doctor.js";
import { searchInput } from "./api/search.js";
import { draftEditorUrl } from "./api/draft-export.js";
import { readBoundedFile } from "./utils/bounded-file.js";
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
       substack-mcp drafts preflight <draft-id> [--publication key]
       substack-mcp drafts create <markdown-file> --title <text> [--subtitle <text>] [--audience everyone|only_paid|founding|only_free] [--allow-unsupported] [--publication key]
       substack-mcp posts search <query> [--status published|drafts|scheduled] [--offset n] [--limit 1-50] [--publication key]
       substack-mcp analytics post <post-id> [--publication key]
       substack-mcp subscribers count [--publication key]
       substack-mcp subscribers get <email> [--publication key]
Read-only JSON output for every command except drafts create, which writes one private, unpublished draft and never publishes. --json is accepted explicitly. Pagination performs one bounded page, not an automatic full export.
drafts create reads a UTF-8 Markdown file of at most 1 MiB and stops before writing when the Markdown is unsupported; review unsupported_nodes before using --allow-unsupported. After a create request fails, the result is write_unverified: check drafts list or posts search before any explicit retry.
Subscriber and draft results are private; protect redirected output. Analytics uses the same bounded recent-post scan as MCP. preflight is a static check, not publish approval.
Failed reads keep code read_failed and add a category (authentication, rate_limited, timeout, not_found, invalid_request, upstream_unavailable, response_invalid, response_too_large, cancelled, output_limit, configuration, unknown).`;

const MAX_MARKDOWN_FILE_BYTES = 1024 * 1024;
const MAX_TITLE_CHARACTERS = 1000;
const audiences = z.enum(["everyone", "only_paid", "founding", "only_free"]);

function integer(value: string | undefined, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (!value || !/^\d+$/.test(value)) throw new Error("invalid argument");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error("invalid argument");
  return number;
}

function argument(value: string | undefined) {
  if (value === undefined || value.startsWith("--")) throw new Error("invalid argument");
  return value;
}

function parse(args: string[]) {
  const command = args.slice(0, 2).join(" ");
  const tools: Record<string, string> = { "drafts list": "list_drafts", "drafts get": "get_draft", "drafts preflight": "preflight_draft", "drafts create": "create_draft",
    "posts search": "search_posts", "analytics post": "get_post_analytics", "subscribers count": "get_subscriber_count", "subscribers get": "get_subscriber" };
  const tool = tools[command];
  if (!tool) throw new Error("invalid command");
  const input: Record<string, unknown> = {};
  let index = 2, file: string | undefined;
  if (command === "drafts get" || command === "drafts preflight") input.draft_id = integer(args[index++], 1);
  if (command === "drafts create") file = argument(args[index++]);
  if (command === "posts search") input.query = searchInput.shape.query.parse(argument(args[index++]));
  if (command === "analytics post") input.post_id = integer(args[index++], 1);
  if (command === "subscribers get") input.email = z.string().trim().email().max(254).parse(args[index++]);
  let publication: string | undefined;
  const seen = new Set<string>();
  while (index < args.length) {
    const flag = args[index++];
    if (seen.has(flag)) throw new Error("duplicate option");
    seen.add(flag);
    if (flag === "--json") continue;
    if (command === "drafts create" && flag === "--allow-unsupported") { input.allow_unsupported = true; continue; }
    const value = args[index++];
    const paged = command === "drafts list" || command === "posts search";
    if (flag === "--publication") {
      if (!value || value.startsWith("--") || value.length > 128) throw new Error("invalid selection");
      publication = value;
    } else if (paged && flag === "--offset") input.offset = integer(value, 0, Number.MAX_SAFE_INTEGER - 50);
    else if (paged && flag === "--limit") input.limit = integer(value, 1, 50);
    else if (command === "posts search" && flag === "--status") input.status = searchInput.shape.status.parse(argument(value));
    else if (command === "drafts create" && flag === "--title") {
      const title = argument(value);
      if (!title.trim() || title.length > MAX_TITLE_CHARACTERS) throw new Error("invalid title");
      input.title = title;
    } else if (command === "drafts create" && flag === "--subtitle") {
      const subtitle = argument(value);
      if (subtitle.length > MAX_TITLE_CHARACTERS) throw new Error("invalid subtitle");
      input.subtitle = subtitle;
    } else if (command === "drafts create" && flag === "--audience") input.audience = audiences.parse(argument(value));
    else throw new Error("unknown option");
  }
  if (command === "drafts create" && input.title === undefined) throw new Error("missing title");
  return { command, tool, input, publication, file };
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

function jsonObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

/**
 * Project the MCP boundary's isError JSON to credential-safe CLI fields. Only
 * whitelisted, validated values are copied; upstream messages and non-JSON
 * exception text are never printed. Client-generated codes win over their
 * synthetic statuses (408 for timeouts, 502 for response failures).
 */
export function projectFailure(text: string): FailureProjection {
  const parsed = jsonObject(text);
  if (!parsed) return failure("unknown");
  const { code, status, status_source, retry_after } = parsed;
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

/** create_draft conversion rejections happen before any write; copy only the diagnostic fields (the converter reports at most 100). */
function conversionRejection(text: string) {
  const parsed = jsonObject(text);
  if (!parsed || (parsed.code !== "unsupported_markdown" && parsed.code !== "markdown_conversion_failed")) return undefined;
  const nodes = Array.isArray(parsed.unsupported_nodes) ? parsed.unsupported_nodes.slice(0, 100).flatMap((node: unknown) => {
    const { type, reason, line, column } = (node && typeof node === "object" ? node : {}) as Record<string, unknown>;
    return typeof type === "string" && typeof reason === "string" && Number.isSafeInteger(line) && Number.isSafeInteger(column) ? [{ type, reason, line, column }] : [];
  }) : undefined;
  return { code: parsed.code, ...(nodes ? { unsupported_nodes: nodes } : {}), write_attempts: 0,
    message: parsed.code === "unsupported_markdown"
      ? "No draft was written. Review unsupported_nodes, then simplify the Markdown or pass --allow-unsupported to retain literal fallbacks."
      : "No draft was written. The Markdown exceeds conversion bounds or uses an unsupported structure; simplify it first." };
}

/** Uses the real MCP handlers so projection, pagination, conversion and write semantics stay shared. */
export async function runOperator(args: string[], load = resolvePublications,
  io = { out: (text: string) => console.log(text), error: (text: string) => console.error(text) }): Promise<number> {
  if (args.length >= 2 && ["--help", "-h"].includes(args.at(-1)!) && args.length <= 3) { io.out(usage); return 0; }
  let options: ReturnType<typeof parse>;
  try { options = parse(args); }
  catch { io.error(JSON.stringify({ format_version: 1, ok: false, code: "invalid_arguments", message: usage })); return 2; }
  const { command } = options;
  if (options.file !== undefined) {
    try { options.input.body = await readBoundedFile(options.file, MAX_MARKDOWN_FILE_BYTES); }
    catch {
      io.error(JSON.stringify({ format_version: 1, ok: false, command, code: "invalid_input_file", message: "Read a regular UTF-8 Markdown file of at most 1 MiB. No write was attempted." })); return 2;
    }
  }
  const write = options.tool === "create_draft";
  const fail = (projection: FailureProjection) => {
    const envelope = !write ? { format_version: 1, ok: false, command, code: "read_failed", ...projection }
      : projection.category === "configuration" ? { format_version: 1, ok: false, command, code: "write_not_attempted", ...projection, message: `${failureMessages.configuration} No write was attempted.` }
      : { format_version: 1, ok: false, command, code: "write_unverified", ...projection,
        message: "The draft may or may not have been created. Check substack-mcp drafts list or posts search <title> --status drafts before any explicit retry; nothing was retried automatically." };
    io.error(JSON.stringify(envelope)); return 1;
  };
  let server: ReturnType<typeof createServer> | undefined;
  const client = new Client({ name: "substack-operator-cli", version: "1" });
  let configured = false;
  try {
    const publications = load();
    const selected = options.publication ? publications.find(p => p.key === options.publication) : publications.length === 1 ? publications[0] : undefined;
    if (!selected) {
      io.error(JSON.stringify({ format_version: 1, ok: false, command, code: "publication_required", message: "Select a configured --publication key; required when multiple publications are configured." })); return 2;
    }
    const userAgent = process.env.SUBSTACK_USER_AGENT;
    // Headers normalizes the value; fetch then rejects control characters that Headers accepts.
    // Checking both here reports configuration instead of an unknown failure inside the request.
    if (userAgent) validateHeaderValue("user-agent", new Headers({ "user-agent": userAgent }).get("user-agent") ?? "");
    const substack = new SubstackClient(selected.publicationUrl, selected.sessionToken, selected.userId, userAgent, Number(process.env.SUBSTACK_REQUEST_TIMEOUT_MS) || undefined);
    server = createServer([{ key: selected.key, label: selected.label, client: substack }]);
    configured = true;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    const reply = await client.callTool({ name: options.tool, arguments: options.input });
    const content = reply.content as { type: string; text?: string }[];
    const text = content.length === 1 && content[0].type === "text" ? content[0].text : undefined;
    if (reply.isError) {
      const rejected = write && text !== undefined ? conversionRejection(text) : undefined;
      if (rejected) { io.error(JSON.stringify({ format_version: 1, ok: false, command, ...rejected })); return 1; }
      return fail(text === undefined ? failure("unknown") : projectFailure(text));
    }
    if (!text) return fail(failure("unknown"));
    const parsed: unknown = JSON.parse(text);
    const data = write ? { ...(parsed as Record<string, unknown>), editor_url: draftEditorUrl(substack.origin, (parsed as { id: number }).id) } : parsed;
    const output = JSON.stringify({ format_version: 1, ok: true, command, publication: selected.key, data });
    if (Buffer.byteLength(output, "utf8") > 4 * 1024 * 1024) return fail(failure("output_limit"));
    io.out(output); return 0;
  } catch {
    return fail(failure(configured ? "unknown" : "configuration"));
  } finally { await client.close(); await server?.close(); }
}
