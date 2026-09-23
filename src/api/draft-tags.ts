import { z } from "zod";
import { requireEditable, DraftChangeError } from "./draft-changes.js";
import { SubstackAPIError } from "../utils/errors.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().uuid();
const ids = z.array(uuid).max(20);
export const draftTagsShape = {
  draft_id: id, add: ids.default([]), remove: ids.default([]), dry_run: z.boolean().default(true),
};
export function validateDraftTags({ add, remove }: { add: string[]; remove: string[] }, ctx: z.RefinementCtx) {
  if (!add.length && !remove.length) ctx.addIssue({ code: "custom", message: "At least one tag is required." });
  for (const [field, values] of [["add", add], ["remove", remove]] as const) {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: [field], message: "Duplicate tag ID." });
  }
  if (add.some(value => remove.includes(value))) ctx.addIssue({ code: "custom", message: "Add and remove must be disjoint." });
}
export const draftTagsInput = z.object(draftTagsShape).strict().superRefine(validateDraftTags);
export type DraftTagsInput = z.input<typeof draftTagsInput>;

const outcome = z.enum(["already_present", "already_absent", "planned", "verified", "unverified", "rejected", "retryable", "unknown", "observed_after_unconfirmed_write", "not_attempted"]);
const result = z.object({
  tag_id: uuid, tag_name: z.string().max(1000).nullable(), hidden: z.boolean().nullable(),
  requested: z.enum(["add", "remove"]), outcome,
});
export const draftTagsOutput = z.object({
  publication: z.string().min(1), draft_id: id, dry_run: z.boolean(), draft_state_after: z.enum(["unpublished", "changed", "unverifiable", "not_checked"]),
  write_attempts: z.number().int().min(0).max(40), results: z.array(result).max(40), note: z.string().max(1000),
}).strict();
type Result = z.output<typeof result>;
type ErrorCode = "draft_published" | "draft_scheduled" | "draft_unverifiable" | "publication_mismatch" | "unknown_tag" | "response_invalid";
export class DraftTagError extends SubstackAPIError {
  constructor(readonly code: ErrorCode, readonly results: Result[]) {
    super(422, "Draft tag safety check failed. No write was attempted.", "update_draft_tags", undefined, "client");
    this.name = "DraftTagError";
  }
}

const definition = z.object({ id: uuid, publication_id: id, name: z.string().max(1000), slug: z.string().max(1000), hidden: z.boolean() });
const association = z.object({ id: z.string().min(1).max(128), publication_id: id, post_id: id, post_tag_id: uuid });
const draft = z.object({
  id, publication_id: id, is_published: z.boolean(),
  trigger_at: z.string().max(128).nullable().optional(),
  scheduled_at: z.string().max(128).nullable().optional(),
  email_sent_at: z.string().max(128).nullable().optional(),
  published_at: z.string().max(128).nullable().optional(),
  is_scheduled: z.boolean().nullable().optional(),
});
const MAX_ROWS = 10_000;
function rows<T extends z.ZodTypeAny>(raw: unknown, schema: T, results: Result[]): z.output<T>[] {
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) throw new DraftTagError("response_invalid", results);
  const parsed = z.array(schema).safeParse(raw);
  if (!parsed.success) throw new DraftTagError("response_invalid", results);
  return parsed.data;
}
function unique(rows: { id: string; publication_id: number }[], publicationId: number, results: Result[]) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.publication_id !== publicationId || seen.has(row.id)) throw new DraftTagError("response_invalid", results);
    seen.add(row.id);
  }
}
function checkedAssociations(raw: unknown, publicationId: number, draftId: number, results: Result[]) {
  const associations = rows(raw, association, results);
  unique(associations, publicationId, results);
  const seen = new Set<string>();
  for (const row of associations) {
    if (row.post_id !== draftId || seen.has(row.post_tag_id)) throw new DraftTagError("response_invalid", results);
    seen.add(row.post_tag_id);
  }
  return seen;
}
function checkedDraft(raw: unknown, publicationId: number, draftId: number, results: Result[]) {
  const parsed = draft.safeParse(raw);
  if (!parsed.success || parsed.data.id !== draftId) throw new DraftTagError("draft_unverifiable", results);
  if (parsed.data.publication_id !== publicationId) throw new DraftTagError("publication_mismatch", results);
  try { requireEditable(parsed.data); }
  catch (error) {
    if (error instanceof DraftChangeError && error.code === "published_draft") throw new DraftTagError("draft_published", results);
    if (error instanceof DraftChangeError && error.code === "scheduled_draft") throw new DraftTagError("draft_scheduled", results);
    throw new DraftTagError("draft_unverifiable", results);
  }
}

interface Client {
  origin: string;
  getPublication(): Promise<{ data: { id: number } }>;
  getDraft(id: number): Promise<unknown>;
  request(path: string, options?: RequestInit): Promise<unknown>;
}

/** Initial four reads, then a pre-write recheck and post-write draft and association readbacks after at most 40 one-shot writes. */
export async function updateDraftTags(input: DraftTagsInput, publication: string, client: Client) {
  const { draft_id, add, remove, dry_run } = draftTagsInput.parse(input);
  const results: Result[] = [
    ...add.map(tag_id => ({ tag_id, tag_name: null, hidden: null, requested: "add" as const, outcome: "not_attempted" as const })),
    ...remove.map(tag_id => ({ tag_id, tag_name: null, hidden: null, requested: "remove" as const, outcome: "not_attempted" as const })),
  ];
  let publicationId: number;
  try { publicationId = id.parse((await client.getPublication()).data.id); }
  catch { throw new DraftTagError("response_invalid", results); }
  let definitions: z.output<typeof definition>[];
  try { definitions = rows(await client.request("/api/v1/publication/post-tag"), definition, results); }
  catch (error) { if (error instanceof DraftTagError) throw error; throw new DraftTagError("response_invalid", results); }
  unique(definitions, publicationId, results);
  const byId = new Map(definitions.map(row => [row.id, row]));
  for (const row of results) {
    const tag = byId.get(row.tag_id);
    if (tag) { row.tag_name = tag.name; row.hidden = tag.hidden; }
  }
  try { checkedDraft(await client.getDraft(draft_id), publicationId, draft_id, results); }
  catch (error) { if (error instanceof DraftTagError) throw error; throw new DraftTagError("draft_unverifiable", results); }
  let before: Set<string>;
  try { before = checkedAssociations(await client.request(`/api/v1/post/${draft_id}/tag`), publicationId, draft_id, results); }
  catch (error) { if (error instanceof DraftTagError) throw error; throw new DraftTagError("response_invalid", results); }
  if (results.some(row => !byId.has(row.tag_id))) throw new DraftTagError("unknown_tag", results);
  for (const row of results) row.outcome = row.requested === "add" ? before.has(row.tag_id) ? "already_present" : "planned" : before.has(row.tag_id) ? "planned" : "already_absent";
  const finish = (write_attempts: number, draft_state_after: z.output<typeof draftTagsOutput>["draft_state_after"], note: string) =>
    draftTagsOutput.parse({ publication, draft_id, dry_run, write_attempts, draft_state_after, results, note });
  if (dry_run) return finish(0, "not_checked", "Plan only. No tags were changed.");
  const pending = results.filter(row => row.outcome === "planned");
  if (!pending.length) return finish(0, "not_checked", "Requested associations already match. No writes were sent.");
  // The draft may have been published between the first read and the first write.
  try { checkedDraft(await client.getDraft(draft_id), publicationId, draft_id, results); }
  catch (error) {
    for (const row of results) row.outcome = "not_attempted";
    if (error instanceof DraftTagError && error.code === "draft_published") throw new DraftTagError("draft_published", results);
    if (error instanceof DraftTagError && error.code === "draft_scheduled") throw new DraftTagError("draft_scheduled", results);
    throw new DraftTagError("draft_unverifiable", results);
  }
  let write_attempts = 0;
  for (const row of pending) {
    const path = `/api/v1/post/${draft_id}/tag/${row.tag_id}`;
    write_attempts++;
    try {
      const reply = await client.request(path, { method: row.requested === "add" ? "POST" : "DELETE", headers: { Referer: `${client.origin}/publish/post` } });
      const valid = row.requested === "add" ? association.safeParse(reply).success && (reply as z.output<typeof association>).publication_id === publicationId &&
        (reply as z.output<typeof association>).post_id === draft_id && (reply as z.output<typeof association>).post_tag_id === row.tag_id
        : !!reply && typeof reply === "object" && !Array.isArray(reply) && Object.keys(reply).length === 0;
      if (!valid) { row.outcome = "unknown"; break; }
      row.outcome = "unverified";
    } catch (error) {
      row.outcome = error instanceof SubstackAPIError && error.statusCode === 400 ? "rejected"
        : error instanceof SubstackAPIError && [401, 403, 429].includes(error.statusCode) ? "retryable" : "unknown";
      if (row.outcome !== "rejected") break;
    }
  }
  for (const row of pending) if (row.outcome === "planned") row.outcome = "not_attempted";
  let draft_state_after: z.output<typeof draftTagsOutput>["draft_state_after"] = "unverifiable";
  try {
    checkedDraft(await client.getDraft(draft_id), publicationId, draft_id, results);
    draft_state_after = "unpublished";
  } catch (error) {
    if (error instanceof DraftTagError && (error.code === "draft_published" || error.code === "draft_scheduled")) draft_state_after = "changed";
  }
  // A failed readback leaves accepted writes unverified; it never triggers another write.
  try {
    const after = checkedAssociations(await client.request(`/api/v1/post/${draft_id}/tag`), publicationId, draft_id, results);
    for (const row of pending) {
      if (!(row.requested === "add" ? after.has(row.tag_id) : !after.has(row.tag_id))) continue;
      if (row.outcome === "unverified" && draft_state_after === "unpublished") row.outcome = "verified";
      else if (row.outcome === "unknown" || row.outcome === "retryable") row.outcome = "observed_after_unconfirmed_write";
    }
  } catch { /* No partial readback is trusted. */ }
  const note = draft_state_after === "unpublished"
    ? "One readback checked association state. Unverified or unconfirmed outcomes need review in Substack before an explicit retry."
    : draft_state_after === "changed"
      ? "The draft changed state during the operation. Tags may now be on a published or scheduled post. Review in Substack before any explicit retry."
      : "The draft state could not be verified after writing. It may have changed during the operation, and tags may now be on a published or scheduled post. Review in Substack before any explicit retry.";
  return finish(write_attempts, draft_state_after, note);
}
