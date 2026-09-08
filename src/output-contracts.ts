import { z } from "zod";
import { MarkdownConversionError } from "./utils/markdown-to-prosemirror.js";
import { TOOL_KINDS } from "./annotations.js";
import { SubstackAPIError, TimeoutError, ResponseError } from "./utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const MAX_TOOL_RESULT_BYTES = 4 * 1024 * 1024;
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string();
const maybeText = text.nullish();
const maybeCount = count.nullish();
const post = z.object({ id, title: maybeText, subtitle: maybeText, slug: maybeText,
  post_date: maybeText, audience: maybeText, word_count: maybeCount, url: maybeText });
const draft = z.object({ id, title: maybeText, subtitle: maybeText, audience: maybeText,
  word_count: maybeCount, created_at: maybeText, updated_at: maybeText });
const subscriber = z.object({ user_email_address: z.string().email().max(254), subscription_id: id, subscription_interval: text.nullable() });
const finding = z.object({ severity: z.enum(["error", "warning"]), code: text, message: text });
const note = z.object({ id, body: maybeText, date: maybeText, message: text, attachment_id: text.optional() });

/** Legacy object field names stay intact. Legacy arrays remain text-only in 1.x. */
export const objectOutputSchemas: Record<string, z.AnyZodObject> = {
  get_subscriber_count: z.object({ count: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER), precision: z.enum(["exact", "approximate", "unavailable"]), note: text }),
  list_published_posts: z.object({ total: maybeCount, posts: z.array(post).max(50) }),
  get_post: post.extend({ body_html: maybeText }),
  get_draft: draft.extend({ body: maybeText }),
  get_post_analytics: z.object({ found: z.boolean(), post_id: id.optional(), note: text.optional(), id: id.optional(), title: maybeText, post_date: maybeText,
    views: maybeCount, sent: maybeCount, delivered: maybeCount, opened: maybeCount, signups: maybeCount, subscribes: maybeCount,
    estimated_value: z.number().finite().nullable().optional(), comment_count: maybeCount, reaction_count: maybeCount }),
  upload_image: z.object({ image_url: text.url() }),
  create_note: note,
  create_note_with_link: note.extend({ attachment_id: text }),
  create_draft: z.object({ id, title: maybeText, unsupported_nodes: z.array(z.object({}).passthrough()), message: text }),
  list_subscribers: z.object({ count, subscribers: z.array(subscriber).max(50), lastSync: text.optional() }),
  get_subscriber: z.object({ email: text.email().max(254), subscriber: subscriber.nullable(), last_sync: text.nullable(), note: text }),
  add_free_subscriber: z.object({ status: z.enum(["existing", "verified", "dry_run", "blocked", "unverified", "busy", "retryable"]), email: text.email().max(254), subscriber: subscriber.optional(), note: text, publication: text, consent_evidence: z.object({ source: text, recorded_at: text }).optional() }),
  search_posts: z.object({ query: text, status: z.enum(["published", "drafts", "scheduled"]), offset: count, limit: count, returned: count, total: count.nullable(), has_more: z.boolean().nullable(), next_offset: count.nullable(), search_scope: text, publication: text,
    posts: z.array(z.object({ id, title: maybeText, draft_title: maybeText, subtitle: maybeText, draft_subtitle: maybeText, slug: maybeText, audience: maybeText, post_date: maybeText, trigger_at: maybeText, draft_updated_at: maybeText, canonical_url: maybeText })).max(50) }),
  preflight_draft: z.object({ draft_id: id, checks_passed: z.boolean(), findings: z.array(finding), counts: z.object({ complete: z.boolean(), nodes: count, images: count, paywalls: count, text_characters: count }), limitations: text, publication: text, editor_url: text.url() }),
};
const arrayOutputSchemas: Record<string, z.ZodTypeAny> = {
  list_drafts: z.array(draft).max(50),
  list_scheduled_posts: z.array(z.object({ id, title: maybeText, audience: maybeText, scheduled_at: maybeText })).max(50),
  get_sections: z.array(z.object({ id, name: text })),
  get_post_comments: z.array(z.object({ id, name: maybeText, body: maybeText, date: maybeText, reactions: z.record(count).optional(), replies: maybeCount })),
};

function failure(name: string, code: string, error?: unknown): CallToolResult {
  const write = (TOOL_KINDS as Record<string, string>)[name] !== "read";
  const api = error instanceof SubstackAPIError ? error : undefined;
  const status = api && Number.isInteger(api.statusCode) && api.statusCode >= 100 && api.statusCode <= 599 ? api.statusCode : undefined;
  const retry = api?.retryAfter;
  const retryAfter = retry && (/^\d{1,10}$/.test(retry) || (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry) && Number.isFinite(Date.parse(retry)))) ? retry : undefined;
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ code, status, status_source: api?.statusSource, retry_after: retryAfter,
    message: write ? "Tool operation or result could not be verified. A write may have occurred; reconcile in Substack before any explicit retry. No automatic retry was performed."
      : "The read could not be verified within its response contract. Check configuration, authentication and upstream availability. No writes were attempted." }) }] };
}

/** Validate before returning anything; never echo a malformed private upstream value. */
export function contractResult(name: string, result: CallToolResult, declaredSchema?: z.ZodTypeAny): CallToolResult {
  const fail = (code: string) => failure(name, code);
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_RESULT_BYTES * 2 + 1024) return fail("result_too_large");
  if (result.content.some(block => block.type === "text" && Buffer.byteLength(block.text, "utf8") > MAX_TOOL_RESULT_BYTES)) return fail("result_too_large");
  if (result.isError) return result;
  const block = result.content[0];
  if (result.content.length !== 1 || block?.type !== "text") return fail("invalid_tool_output");
  if (Buffer.byteLength(block.text, "utf8") > MAX_TOOL_RESULT_BYTES) return fail("result_too_large");
  let value: unknown;
  try { value = JSON.parse(block.text); } catch { return fail("invalid_tool_output"); }
  const schema = declaredSchema ?? objectOutputSchemas[name] ?? arrayOutputSchemas[name];
  if (schema && !schema.safeParse(value).success) return fail("invalid_tool_output");
  if (name === "get_subscriber_count") {
    const v = value as { count: number; precision: string };
    if ((v.precision === "unavailable") !== (v.count === -1)) return fail("invalid_tool_output");
  }
  if (name === "get_post_analytics") {
    const v = value as { found: boolean; id?: number; post_id?: number; note?: string };
    if (v.found ? v.id === undefined : v.post_id === undefined || v.note === undefined) return fail("invalid_tool_output");
  }
  if (Array.isArray(value)) return result;
  if (!value || typeof value !== "object") return fail("invalid_tool_output");
  const final = { ...result, structuredContent: value as Record<string, unknown> };
  if (Buffer.byteLength(JSON.stringify(final), "utf8") > MAX_TOOL_RESULT_BYTES * 2 + 1024) return fail("result_too_large");
  return final;
}

export function contractRegistrar(server: McpServer): McpServer["registerTool"] {
  // Preserve the SDK's generic registration signature at this one adapter boundary.
  const register = server.registerTool.bind(server);
  return ((name: string, config: any, callback: (...args: any[]) => Promise<CallToolResult>) => {
    const outputSchema = config.outputSchema ?? objectOutputSchemas[name]?.shape;
    const schema = outputSchema instanceof z.ZodType ? outputSchema : outputSchema ? z.object(outputSchema) : undefined;
    return register(name, { ...config, outputSchema }, async (...args: any[]) => {
      try { return contractResult(name, await callback(...args), schema); }
      catch (error) {
        if (error instanceof MarkdownConversionError) return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "markdown_conversion_failed", message: "Markdown exceeds conversion bounds or uses an unsupported structure. Simplify the input before retrying; no write was attempted.", write_attempts: 0 }) }] };
        const code = error instanceof TimeoutError ? "timeout" : error instanceof ResponseError ? error.code : error instanceof SubstackAPIError ? "upstream_error" : "tool_execution_failed";
        return failure(name, code, error);
      }
    });
  }) as McpServer["registerTool"];
}
