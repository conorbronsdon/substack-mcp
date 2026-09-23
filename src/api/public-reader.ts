import { z } from "zod";
import { requestJson } from "./request.js";
import { publicationOrigin } from "../auth/validate-credentials.js";
import { SubstackAPIError } from "../utils/errors.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const short = z.string().max(4000);
const cursor = z.string().min(1).max(2048).refine(value => !/[\x00-\x1f\x7f-\x9f]/.test(value));
const handle = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
const originInput = z.string().max(2048);
const urlInput = z.string().max(4096);
const comment = z.object({ id, body: z.string().max(1_000_000).nullish(), ancestor_path: z.string().max(4096).nullish(),
  parent_id: id.nullish(), user_id: id.nullish(), user_handle: handle.nullish(),
  user: z.object({ handle: handle.nullish() }).nullish(), date: short.nullish(), deleted: z.boolean().nullish(),
  status: short.nullish(), children_count: count.nullish(), reaction_count: count.nullish(), restacks: count.nullish() });
const post = z.object({ id, title: short.nullish(), canonical_url: urlInput.nullish() });
const item = z.object({ entity_key: short, type: short, context: z.object({ type: short, timestamp: short }),
  comment: comment.nullish(), post: post.nullish(), publication: z.object({ name: short.nullish() }).nullish(),
  parentComments: z.array(comment).max(500).optional() });
const profile = z.object({ id, name: short.nullish(), handle, bio: short.nullish(), photo_url: urlInput.nullish(),
  publicationUsers: z.array(z.object({ role: short.nullish(), is_primary: z.boolean().nullish(), publication: z.object({
    id, name: short.nullish(), subdomain: short.nullish(), custom_domain: short.nullish(),
  }) })).max(100).optional() });
const feed = z.object({ items: z.array(item).max(50), nextCursor: cursor.or(z.literal("")).nullish() });
const branch = z.object({ comment, descendantComments: z.array(comment).max(500) });
const replies = z.object({ rootComment: comment, commentBranches: z.array(branch).max(500),
  moreBranches: count.nullish(), nextCursor: cursor.or(z.literal("")).nullish() });
const archivePost = post.extend({ subtitle: short.nullish(), slug: short.nullish(), post_date: short.nullish(),
  audience: short.nullish(), wordcount: count.nullish(), reaction_count: count.nullish(),
  comment_count: count.nullish(), restacks: count.nullish() });
const fullPost = archivePost.extend({ body_html: z.string().max(2_000_000).nullish() });

export const profileInput = z.object({ handle });
export const feedInput = z.object({ user_id: id.optional(), handle: handle.optional(), cursor: cursor.optional() })
  .refine(value => (value.user_id === undefined) !== (value.handle === undefined), "Exactly one of user_id or handle is required.");
export const threadInput = z.object({ comment_id: id, cursor: cursor.optional() });
export const archiveInput = z.object({ publication_url: originInput.optional(), sort: z.enum(["new", "top"]).default("new"),
  query: z.string().min(1).max(200).optional(), offset: count.max(Number.MAX_SAFE_INTEGER - 50).default(0), limit: count.min(1).max(50).default(12) });
export const publicPostInput = z.object({ url: urlInput });

const projectedComment = z.object({ id, body_text: z.string().max(4000).nullable(), body_truncated: z.boolean(),
  ancestor_path: z.string().max(4096).nullable(), parent_id: id.nullable(), parent_status: z.enum(["derived", "not_derived"]),
  date: short.nullable(), deleted: z.boolean().nullable(), status: short.nullable(),
  children_count: count.nullable(), reaction_count: count.nullable(), restacks: count.nullable() });
const projectedPost = z.object({ id, title: short.nullable(), canonical_url: urlInput.nullable(), publication_name: short.nullable() });
const projectedRow = z.object({ kind: z.enum(["note", "post", "restack", "other"]), entity_key: short,
  date: short.nullable(), note: z.object({ id, body_text: z.string().max(4000).nullable(), body_truncated: z.boolean(),
    author_user_id: id.nullable(), author_handle: handle.nullable(), ancestor_path: z.string().max(4096).nullable(), is_reply: z.boolean().nullable(), children_count: count.nullable(),
    reaction_count: count.nullable(), restacks: count.nullable(), url: urlInput.nullable() }).optional(), post: projectedPost.optional() });
export const profileOutput = z.object({ id, name: short.nullable(), handle, bio: short.nullable(), photo_url: urlInput.nullable(),
  primary_publication: z.object({ id, name: short.nullable(), subdomain: short.nullable(), custom_domain: short.nullable() }).nullable() });
export const feedOutput = z.object({ user_id: id, items: z.array(projectedRow).max(50), returned: count.max(50),
  next_cursor: cursor.nullable(), has_more: z.boolean().nullable() });
export const threadOutput = z.object({ ancestors: z.array(projectedComment).max(100), root: projectedComment,
  branches: z.array(z.object({ reply: projectedComment, descendants: z.array(projectedComment).max(100) })).max(100),
  more_branches: count.nullable(), next_cursor: cursor.nullable(), completeness: z.enum(["complete_page", "more_available", "unknown"]),
  truncated: z.boolean() });
export const archiveOutput = z.object({ publication_url: originInput, sort: z.enum(["new", "top"]), query: z.string().nullable(),
  offset: count, limit: count.min(1).max(50), returned: count.max(50), next_offset: count.nullable(),
  has_more: z.boolean().nullable(), posts: z.array(archivePost).max(50) });
export const publicPostOutput = z.object({ ...archivePost.shape, body_html: z.string().max(500_000).nullable(),
  body_truncated: z.boolean(), body_status: z.enum(["full_public", "paywalled_or_truncated", "absent"]) });

export class PublicReadError extends SubstackAPIError {
  constructor(public code: "host_not_allowed" | "invalid_url" | "invalid_arguments" | "invalid_upstream_response" | "not_found", status: number) {
    super(status, "Public read could not be verified.", "public_read", undefined, "client");
  }
}
function invalid(): never { throw new PublicReadError("invalid_upstream_response", 502); }
function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) invalid();
  return result.data;
}
function textBody(value: string | null | undefined) {
  return { body_text: value == null ? null : value.slice(0, 4000), body_truncated: value != null && value.length > 4000 };
}
function htmlBody(value: string | null) {
  if (value === null) return { body_html: null, body_truncated: false };
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= 500_000) return { body_html: value, body_truncated: false };
  let end = 500_000;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { body_html: bytes.subarray(0, end).toString("utf8"), body_truncated: true };
}
function projected(c: z.output<typeof comment>, parent: number | null = null) {
  return { id: c.id, ...textBody(c.body), ancestor_path: c.ancestor_path ?? null,
    parent_id: parent, parent_status: parent === null ? "not_derived" as const : "derived" as const,
    date: c.date ?? null, deleted: c.deleted ?? null, status: c.status ?? null,
    children_count: c.children_count ?? null, reaction_count: c.reaction_count ?? null, restacks: c.restacks ?? null };
}
function pathParent(c: z.output<typeof comment>, present: Set<number>): number | null {
  if (c.parent_id != null && c.parent_id !== c.id && present.has(c.parent_id)) return c.parent_id;
  const match = c.ancestor_path?.match(/(?:^|[^0-9])(\d+)\D*$/);
  const value = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(value) && value !== c.id && present.has(value) ? value : null;
}

export function publicReadOrigin(value: string): string | null {
  if (/^https?:\/\/[^/?#]*%/i.test(value)) return null;
  const origin = publicationOrigin(value);
  if (!origin) return null;
  const hostname = new URL(origin).hostname;
  return !/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && !hostname.includes(":") &&
    hostname !== "localhost" && !hostname.endsWith(".") ? origin : null;
}

/** No credential property or client reference exists on this transport. */
export class PublicReader {
  private origins: Set<string>;
  private userAgent: string;
  private timeoutMs: number;
  constructor(config: { allowedOrigins: string[]; userAgent: string; timeoutMs: number }) {
    this.origins = new Set(config.allowedOrigins.map(value => {
      const origin = publicReadOrigin(value);
      if (!origin) throw new PublicReadError("host_not_allowed", 400);
      return origin;
    }));
    this.userAgent = config.userAgent;
    this.timeoutMs = config.timeoutMs;
  }
  private checkUrl(raw: string): URL {
    let url: URL;
    if (/[\s\x00-\x1f\x7f\\]/.test(raw) || /^https?:\/\/[^/?#]*%/i.test(raw)) throw new PublicReadError("host_not_allowed", 400);
    try { url = new URL(raw); } catch { throw new PublicReadError("host_not_allowed", 400); }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !publicReadOrigin(url.origin) ||
        !(url.origin === "https://substack.com" || this.origins.has(url.origin) ||
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.substack\.com$/.test(url.hostname))) {
      throw new PublicReadError("host_not_allowed", 400);
    }
    return url;
  }
  private async read(url: string, maxBytes = 2_000_000): Promise<unknown> {
    const checked = this.checkUrl(url);
    try {
      return await requestJson<unknown>(checked.href, { method: "GET", credentials: "omit",
        headers: { "User-Agent": this.userAgent, Accept: "application/json" } }, this.timeoutMs, maxBytes);
    } catch (error) {
      if (error instanceof SubstackAPIError && error.statusCode === 404) throw new PublicReadError("not_found", 404);
      throw error;
    }
  }
  async getProfile(value: z.input<typeof profileInput>) {
    const { handle: name } = profileInput.parse(value);
    const p = parse(profile, await this.read(`https://substack.com/api/v1/user/${name}/public_profile`));
    const primary = p.publicationUsers?.find(row => row.is_primary === true)?.publication ?? null;
    return profileOutput.parse({ id: p.id, name: p.name ?? null, handle: p.handle, bio: p.bio ?? null,
      photo_url: p.photo_url ?? null, primary_publication: primary });
  }
  async getFeed(value: z.input<typeof feedInput>) {
    const parsed = feedInput.safeParse(value);
    if (!parsed.success) throw new PublicReadError("invalid_arguments", 400);
    const input = parsed.data;
    const user_id = input.user_id ?? (await this.getProfile({ handle: input.handle! })).id;
    const params = input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : "";
    const data = parse(feed, await this.read(`https://substack.com/api/v1/reader/feed/profile/${user_id}${params}`));
    const items = data.items.map(row => {
      const kind = /restack/i.test(`${row.type} ${row.context?.type ?? ""}`) ? "restack" : row.comment ? "note" : row.post ? "post" : "other";
      const note = row.comment ? { id: row.comment.id, ...textBody(row.comment.body), ancestor_path: row.comment.ancestor_path ?? null,
        author_user_id: row.comment.user_id ?? null, author_handle: row.comment.user?.handle ?? row.comment.user_handle ?? null,
        is_reply: row.comment.ancestor_path == null ? null : row.comment.ancestor_path !== "",
        children_count: row.comment.children_count ?? null, reaction_count: row.comment.reaction_count ?? null,
        restacks: row.comment.restacks ?? null, url: null } : undefined;
      const projectedPost = row.post ? { id: row.post.id, title: row.post.title ?? null,
        canonical_url: row.post.canonical_url ?? null, publication_name: row.publication?.name ?? null } : undefined;
      return { kind, entity_key: row.entity_key, date: row.context?.timestamp ?? row.comment?.date ?? null,
        ...(note ? { note } : {}), ...(projectedPost ? { post: projectedPost } : {}) };
    });
    const next_cursor = data.nextCursor || null;
    return feedOutput.parse({ user_id, items, returned: items.length, next_cursor,
      has_more: data.nextCursor === undefined ? null : next_cursor !== null });
  }
  async getThread(value: z.input<typeof threadInput>) {
    const input = threadInput.parse(value);
    const base = `https://substack.com/api/v1/reader/comment/${input.comment_id}`;
    const first = parse(z.object({ item }), await this.read(base));
    if (!first.item.comment || first.item.comment.id !== input.comment_id) invalid();
    const suffix = input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : "";
    const second = parse(replies, await this.read(`${base}/replies${suffix}`));
    if (second.rootComment.id !== input.comment_id) invalid();
    const ancestors = first.item.parentComments ?? [];
    const selectedAncestors = ancestors.slice(0, 99);
    let remaining = 99 - selectedAncestors.length, truncated = ancestors.length > 99;
    const selectedBranches = [];
    for (const b of second.commentBranches) {
      if (remaining <= 0) { truncated = true; break; }
      remaining--;
      const descendants = b.descendantComments.slice(0, remaining);
      if (b.descendantComments.length > descendants.length) truncated = true;
      remaining -= descendants.length;
      selectedBranches.push({ reply: b.comment, descendants });
    }
    const present = new Set([input.comment_id, ...selectedAncestors.map(c => c.id),
      ...selectedBranches.flatMap(b => [b.reply.id, ...b.descendants.map(d => d.id)])]);
    const branches = selectedBranches.map(b => ({ reply: projected(b.reply, input.comment_id),
      descendants: b.descendants.map(d => projected(d, pathParent(d, present))) }));
    const next_cursor = second.nextCursor || null;
    const root = { ...first.item.comment,
      deleted: second.rootComment.deleted ?? first.item.comment.deleted,
      status: second.rootComment.status ?? first.item.comment.status };
    return threadOutput.parse({ ancestors: selectedAncestors.map(c => projected(c, pathParent(c, present))),
      root: projected(root, pathParent(root, present)), branches,
      more_branches: second.moreBranches ?? null, next_cursor,
      completeness: (second.moreBranches ?? 0) > 0 || next_cursor !== null || truncated ? "more_available"
        : second.moreBranches == null || second.nextCursor === undefined ? "unknown" : "complete_page", truncated });
  }
  async listPosts(value: z.input<typeof archiveInput>, defaultOrigin: string) {
    const input = archiveInput.parse(value);
    const origin = this.checkUrl(input.publication_url ?? defaultOrigin);
    if (origin.pathname !== "/" || origin.search || origin.hash) throw new PublicReadError("invalid_url", 400);
    const params = new URLSearchParams({ sort: input.sort, offset: String(input.offset), limit: String(input.limit) });
    if (input.query) params.set("search", input.query);
    const posts = parse(z.array(archivePost).max(50), await this.read(`${origin.origin}/api/v1/archive?${params}`));
    if (posts.length > input.limit) invalid();
    return archiveOutput.parse({ publication_url: origin.origin, sort: input.sort, query: input.query ?? null,
      offset: input.offset, limit: input.limit, returned: posts.length, posts,
      next_offset: posts.length === input.limit ? input.offset + posts.length : null,
      has_more: posts.length === input.limit ? null : false });
  }
  async getPost(value: z.input<typeof publicPostInput>) {
    const input = publicPostInput.parse(value);
    const url = this.checkUrl(input.url);
    if (url.search || url.hash || !/^\/p\/[A-Za-z0-9_-]{1,200}\/?$/.test(url.pathname)) throw new PublicReadError("invalid_url", 400);
    const slug = url.pathname.split("/")[2];
    const data = parse(fullPost, await this.read(`${url.origin}/api/v1/posts/${slug}`, 3_000_000));
    const body = data.body_html ?? null;
    return publicPostOutput.parse({ ...data, ...htmlBody(body),
      body_status: body === null || body === "" ? "absent" : data.audience === "everyone" ? "full_public" : "paywalled_or_truncated" });
  }
}
