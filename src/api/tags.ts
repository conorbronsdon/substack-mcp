import { z } from "zod";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const tagId = z.string().min(1).max(128);
export const tagPageInput = z.object({
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 100).default(0),
  limit: z.number().int().min(1).max(100).default(25),
});
export const listTagsInput = tagPageInput.extend({ include_hidden: z.boolean().default(true) });
export const postTagsInput = tagPageInput.extend({ post_id: positiveId });
const tag = z.object({
  id: tagId, publication_id: positiveId,
  name: z.string().max(1000), slug: z.string().max(1000), hidden: z.boolean(),
});
const association = z.object({ id: tagId, publication_id: positiveId, post_id: positiveId, post_tag_id: tagId });
const pageFields = {
  publication: z.string(), publication_id: positiveId,
  offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(), returned: z.number().int().nonnegative(),
  has_more: z.boolean(), next_offset: z.number().int().nonnegative().nullable(),
  pagination: z.literal("Local pagination of a fresh upstream array; results may change between calls."),
};
export const listTagsOutput = z.object({ ...pageFields, include_hidden: z.boolean(), tags: z.array(tag).max(100) });
export const postTagsOutput = z.object({
  ...pageFields, post_id: positiveId,
  post_identity: z.enum(["association_rows_match_requested_id", "not_verified_empty_associations"]),
  tags: z.array(z.object({ tag_id: tagId, resolved: z.boolean(), tag: tag.nullable() })).max(100),
  resolution_scope: z.literal("Association and publication-tag reads are separate snapshots; unresolved IDs are retained."),
});

type Read = (path: string) => Promise<unknown>;
type Context = () => Promise<{ data: { id: number } }>;
const MAX_ROWS = 10_000;

function parseRows<T extends z.ZodTypeAny>(raw: unknown, schema: T): z.output<T>[] {
  // Check length before parsing rows. This is a processing bound, not an upstream API limit.
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) throw new Error("Unexpected or oversized tag response; no tag results can be verified.");
  const parsed = z.array(schema).safeParse(raw);
  if (!parsed.success) throw new Error("Unexpected tag response; no tag results can be verified.");
  return parsed.data;
}

function verifyRows(rows: { id: string; publication_id: number }[], publicationId: number) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.publication_id !== publicationId) throw new Error("Tag response belongs to a different publication.");
    if (seen.has(row.id)) throw new Error("Duplicate tag response identifiers; retry the read.");
    seen.add(row.id);
  }
}

function page<T>(rows: T[], offset: number, limit: number) {
  const tags = rows.slice(offset, offset + limit);
  const has_more = offset + tags.length < rows.length;
  return { offset, limit, total: rows.length, returned: tags.length, has_more,
    next_offset: has_more ? offset + tags.length : null,
    pagination: "Local pagination of a fresh upstream array; results may change between calls." as const, tags };
}

export async function listPublicationTags(input: z.input<typeof listTagsInput>, context: Context, read: Read) {
  const { offset, limit, include_hidden } = listTagsInput.parse(input);
  const publication_id = positiveId.parse((await context()).data.id);
  const rows = parseRows(await read("/api/v1/publication/post-tag"), tag);
  verifyRows(rows, publication_id);
  return { publication_id, include_hidden, ...page(rows.filter(row => include_hidden || !row.hidden), offset, limit) };
}

export async function getPostTags(input: z.input<typeof postTagsInput>, context: Context, read: Read) {
  const { post_id, offset, limit } = postTagsInput.parse(input);
  const publication_id = positiveId.parse((await context()).data.id);
  const associations = parseRows(await read(`/api/v1/post/${post_id}/tag`), association);
  verifyRows(associations, publication_id);
  const seenTags = new Set<string>();
  for (const row of associations) {
    if (row.post_id !== post_id) throw new Error("Tag associations do not match the requested post.");
    if (seenTags.has(row.post_tag_id)) throw new Error("Duplicate post tag associations; retry the read.");
    seenTags.add(row.post_tag_id);
  }
  // Empty association responses do not prove that the post exists or is accessible.
  const definitions = associations.length ? parseRows(await read("/api/v1/publication/post-tag"), tag) : [];
  verifyRows(definitions, publication_id);
  const byId = new Map(definitions.map(row => [row.id, row]));
  const rows = associations.map(row => ({ tag_id: row.post_tag_id, resolved: byId.has(row.post_tag_id), tag: byId.get(row.post_tag_id) ?? null }));
  return { publication_id, post_id,
    post_identity: associations.length ? "association_rows_match_requested_id" as const : "not_verified_empty_associations" as const,
    resolution_scope: "Association and publication-tag reads are separate snapshots; unresolved IDs are retained." as const,
    ...page(rows, offset, limit) };
}
