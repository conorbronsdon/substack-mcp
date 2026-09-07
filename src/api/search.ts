import { z } from "zod";

export const searchInput = z.object({
  query: z.string().trim().min(1).max(500),
  status: z.enum(["published", "drafts", "scheduled"]).default("published"),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 50).default(0),
  limit: z.number().int().min(1).max(50).default(25),
});

const row = z.object({
  id: z.number().int().positive(),
  title: z.string().nullable().optional(),
  draft_title: z.string().nullable().optional(),
  subtitle: z.string().nullable().optional(),
  draft_subtitle: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  audience: z.string().nullable().optional(),
  post_date: z.string().nullable().optional(),
  trigger_at: z.string().nullable().optional(),
  draft_updated_at: z.string().nullable().optional(),
  canonical_url: z.string().nullable().optional(),
});
const page = z.object({ posts: z.array(row), total: z.number().int().nonnegative().nullish() });

/** One upstream query, never an implicit full-archive crawl. */
export async function searchPosts(
  input: z.input<typeof searchInput>,
  read: (path: string) => Promise<unknown>,
) {
  const { query, status, offset, limit } = searchInput.parse(input);
  const orderBy = { published: "post_date", drafts: "draft_updated_at", scheduled: "trigger_at" }[status];
  const params = new URLSearchParams({ query, offset: String(offset), limit: String(limit),
    order_by: orderBy, order_direction: status === "scheduled" ? "asc" : "desc" });
  const parsed = page.safeParse(await read(`/api/v1/post_management/${status}?${params}`));
  if (!parsed.success) throw new Error("Unexpected archive search response; no search results can be verified.");
  if (parsed.data.posts.length > limit) throw new Error("Archive search exceeded the requested page size.");
  const { posts } = parsed.data;
  const total = parsed.data.total ?? null;
  if (posts.length === 0 && total !== null && offset < total) {
    throw new Error("Inconsistent archive search page: no rows before the reported total. Retry the query; the archive may have changed.");
  }
  const hasMore = total === null ? (posts.length === limit ? null : false) : offset + posts.length < total;
  return { query, status, offset, limit, returned: posts.length, total,
    has_more: hasMore, next_offset: hasMore === false || posts.length === 0 ? null : offset + posts.length,
    search_scope: "Substack server-side archive query; matching and indexing are controlled by Substack.",
    posts };
}
