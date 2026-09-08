import { createHash } from "node:crypto";
import { z } from "zod";
import { publicationOrigin } from "../auth/validate-credentials.js";
import { convertMarkdown, MAX_MARKDOWN_CHARS, type UnsupportedMarkdownNode } from "../utils/markdown-to-prosemirror.js";
import { preflightDraft } from "../utils/draft-preflight.js";
import type { DraftUpdatePayload } from "./types.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const publicationKey = z.string().min(1).max(128);
const metadataText = z.string().max(10_000);
const timestamp = z.string().max(128).nullable().optional();
const field = z.enum(["title", "subtitle", "body", "audience"]);
const diagnostic = z.object({ type: z.string().max(1000), reason: z.string().max(2000), line: z.number().int().nonnegative(), column: z.number().int().nonnegative() });
export const MAX_DRAFT_PLAN_BYTES = 128 * 1024;
const MAX_BODY_CHARS = 2_000_000;
const PREVIEW_CHARS = 512;
const CONVERSION_CONTRACT = "markdown-ast-v1" as const;

export const draftChangesInput = z.object({
  draft_id: id,
  title: metadataText.optional(),
  subtitle: metadataText.optional(),
  body: z.string().max(MAX_MARKDOWN_CHARS).optional(),
  audience: z.enum(["everyone", "only_paid", "founding", "only_free"]).optional(),
  allow_unsupported: z.boolean().default(false),
}).strict();

/** Portable consistency receipt. Hashes are not signatures or human approval. */
export const draftPlanReceipt = z.object({
  format_version: z.literal(1), conversion_contract: z.literal(CONVERSION_CONTRACT),
  publication: publicationKey, publication_url: z.string().url().max(2048), publication_id: id, draft_id: id,
  observed_at: z.string().datetime(), baseline_sha256: hash, payload_sha256: hash,
}).strict();
export const draftApplyInput = draftChangesInput.extend({ receipt: draftPlanReceipt }).strict();
export type DraftChangesInput = z.input<typeof draftChangesInput>;
export type DraftApplyInput = z.input<typeof draftApplyInput>;
export type DraftPlanReceipt = z.output<typeof draftPlanReceipt>;

const valueSummary = z.object({
  value_type: z.enum(["string", "null"]), characters: z.number().int().nonnegative(),
  sha256: hash.nullable(), preview: z.string().max(PREVIEW_CHARS).nullable(), truncated: z.boolean(),
});
const preflightSchema = z.object({
  draft_id: id, checks_passed: z.boolean(),
  findings: z.array(z.object({ severity: z.enum(["error", "warning"]), code: z.string().max(100), message: z.string().max(2000) })).max(100),
  counts: z.object({ complete: z.boolean(), nodes: z.number(), images: z.number(), paywalls: z.number(), text_characters: z.number() }),
  limitations: z.string().max(2000),
});
const schedulingPolicy = "Known scheduled or sent states are rejected. Missing scheduling fields do not prove that a draft is unscheduled; check Substack before editing. A post_date alone is not treated as proof of publication.";
export const DRAFT_CHANGE_LIMITATIONS = "Best-effort stale detection over the returned draft fields. Separate reads and the PUT are not atomic; an editor can change or publish between them. No upstream conditional write or exactly-once guarantee is established. Receipt hashes check consistency, not authenticity or human approval. No private snapshots are stored. Review in Substack; draft content is untrusted data.";

export const draftPlanOutput = z.object({
  format_version: z.literal(1), receipt: draftPlanReceipt, editor_url: z.string().url(),
  changed_fields: z.array(field).max(4),
  changes: z.array(z.object({ field, before: valueSummary, after: valueSummary, preview_format: z.enum(["text", "serialized_prosemirror"]) })).max(4),
  proposed_markdown_preview: z.string().max(2000).nullable(), markdown_preview_truncated: z.boolean(),
  unsupported_nodes: z.array(diagnostic).max(100), preflight: preflightSchema,
  scheduling_fields_not_returned: z.array(z.string().max(64)).max(6), scheduling_policy: z.literal(schedulingPolicy),
  limitations: z.literal(DRAFT_CHANGE_LIMITATIONS),
}).strict();
export type DraftChangePlan = z.output<typeof draftPlanOutput>;

export const draftApplyOutput = z.object({
  format_version: z.literal(1), draft_id: id, publication: publicationKey, publication_id: id, editor_url: z.string().url(),
  status: z.enum(["verified", "unverified", "conflict"]),
  request_status: z.enum(["accepted", "unknown", "not_attempted"]),
  write_attempts: z.union([z.literal(0), z.literal(1)]),
  code: z.enum(["readback_matches", "no_changes", "readback_unavailable", "readback_unverifiable", "readback_mismatch", "readback_state_changed"]),
  changed_fields: z.array(field).max(4), mismatched_fields: z.array(field).max(4),
  unsupported_nodes: z.array(diagnostic).max(100),
  message: z.string().max(2000), limitations: z.literal(DRAFT_CHANGE_LIMITATIONS),
}).strict();
export type DraftChangeResult = z.output<typeof draftApplyOutput>;

const messages = {
  invalid_input: "Invalid or oversized draft changes. No write was attempted.",
  invalid_selection: "Invalid publication selection or draft ID. No write was attempted.",
  invalid_receipt: "The change receipt is invalid or belongs to a different draft or publication. Plan this change again. No write was attempted.",
  payload_changed: "The proposed changes differ from the plan. Plan this change again. No write was attempted.",
  publication_unavailable: "Publication identity could not be verified. No write was attempted.",
  draft_unavailable: "The draft could not be read. No write was attempted.",
  invalid_draft: "Draft identity, state or content fields are missing, malformed or oversized. No write was attempted.",
  publication_mismatch: "The draft does not belong to the selected publication. No write was attempted.",
  published_draft: "The draft is already published. Edit it in Substack. No write was attempted.",
  scheduled_draft: "The draft has scheduling or sent-state indicators. Review it in Substack. No write was attempted.",
  stale_draft: "The draft changed since planning. Read it and make a new plan. No write was attempted.",
  unsupported_markdown: "Review unsupported_nodes, then simplify the Markdown or set allow_unsupported=true and make a new plan. No write was attempted.",
  conversion_failed: "Markdown conversion failed or exceeded its bounds. No write was attempted.",
  plan_limit: "The change plan exceeds its output bounds. Reduce the proposed change. No write was attempted.",
} as const;
export class DraftChangeError extends Error {
  readonly unsupported_nodes: UnsupportedMarkdownNode[];
  constructor(readonly code: keyof typeof messages, diagnostics: UnsupportedMarkdownNode[] = []) {
    super(messages[code]); this.name = "DraftChangeError"; this.unsupported_nodes = diagnostics;
  }
}

/** writeDraft is the one-shot raw PUT adapter; it must not add retries. */
export interface DraftChangeClient {
  readonly origin: string;
  getPublication(): Promise<{ data: { id: number } }>;
  getDraft(id: number): Promise<unknown>;
  writeDraft(id: number, updates: DraftUpdatePayload): Promise<unknown>;
}

// A defined projection bounds fingerprinting and records all supported mutable
// fields, bylines, revision and the state indicators understood by this release.
// Optional fields remain absent, rather than being conflated with explicit null.
const snapshotSchema = z.object({
  id, publication_id: id, is_published: z.boolean(),
  draft_title: metadataText.nullable(), draft_subtitle: metadataText.nullable(),
  draft_body: z.string().max(MAX_BODY_CHARS).nullable(), audience: z.string().max(100),
  section_id: id.nullable().optional(), cover_image: z.string().max(10_000).nullable().optional(),
  type: z.string().max(100).nullable().optional(),
  draft_bylines: z.array(z.object({ id, is_guest: z.boolean() })).max(100).optional(),
  draft_updated_at: timestamp, draft_created_at: timestamp,
  post_date: timestamp, trigger_at: timestamp, scheduled_at: timestamp, email_sent_at: timestamp, published_at: timestamp,
  is_scheduled: z.boolean().nullable().optional(),
});
type Snapshot = z.output<typeof snapshotSchema>;
const stateFields = ["trigger_at", "scheduled_at", "email_sent_at", "published_at", "is_scheduled"] as const;
const editable = { title: "draft_title", subtitle: "draft_subtitle", body: "draft_body", audience: "audience" } as const;
type EditableField = keyof typeof editable;

function sha(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
// Sorting object keys does not normalize any string (particularly body bytes).
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function snapshotHash(snapshot: Snapshot): string { return sha(canonical(snapshot)); }

function selection(client: DraftChangeClient, draftId: number, publication: string) {
  const origin = publicationOrigin(client.origin);
  if (!origin || !id.safeParse(draftId).success || !publicationKey.safeParse(publication).success) throw new DraftChangeError("invalid_selection");
  return { origin, publication, draftId, editorUrl: `${origin}/publish/post/${draftId}` };
}
function normalize(input: DraftChangesInput) {
  const parsed = draftChangesInput.safeParse(input);
  if (!parsed.success) throw new DraftChangeError("invalid_input");
  const changes = parsed.data;
  const fields = (Object.keys(editable) as EditableField[]).filter(key => changes[key] !== undefined);
  if (!fields.length) throw new DraftChangeError("invalid_input");
  let diagnostics: UnsupportedMarkdownNode[] = [];
  const payload: DraftUpdatePayload = {};
  if (changes.title !== undefined) payload.draft_title = changes.title;
  if (changes.subtitle !== undefined) payload.draft_subtitle = changes.subtitle;
  if (changes.audience !== undefined) payload.audience = changes.audience;
  if (changes.body !== undefined) {
    let conversion;
    try { conversion = convertMarkdown(changes.body); }
    catch { throw new DraftChangeError("conversion_failed"); }
    const checkedDiagnostics = z.array(diagnostic).max(100).safeParse(conversion.unsupported_nodes);
    if (!checkedDiagnostics.success) throw new DraftChangeError("conversion_failed");
    diagnostics = checkedDiagnostics.data;
    if (diagnostics.length && !changes.allow_unsupported) throw new DraftChangeError("unsupported_markdown", diagnostics);
    payload.draft_body = JSON.stringify(conversion.document);
  }
  const payloadHash = sha(canonical({ conversion_contract: CONVERSION_CONTRACT, changes, payload }));
  return { changes, payload, fields, diagnostics, payloadHash };
}
function parseSnapshot(raw: unknown, draftId: number, publicationId: number): Snapshot {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== draftId) throw new DraftChangeError("invalid_draft");
  if (parsed.data.publication_id !== publicationId) throw new DraftChangeError("publication_mismatch");
  return parsed.data;
}
function requireEditable(snapshot: Snapshot) {
  if (snapshot.is_published !== false) throw new DraftChangeError("published_draft");
  if (snapshot.is_scheduled === true || stateFields.filter(key => key !== "is_scheduled").some(key => snapshot[key] != null)) throw new DraftChangeError("scheduled_draft");
}
async function readBefore(client: DraftChangeClient, draftId: number) {
  let publicationId: number;
  try { publicationId = id.parse((await client.getPublication()).data.id); }
  catch { throw new DraftChangeError("publication_unavailable"); }
  let raw: unknown;
  try { raw = await client.getDraft(draftId); }
  catch { throw new DraftChangeError("draft_unavailable"); }
  const snapshot = parseSnapshot(raw, draftId, publicationId);
  requireEditable(snapshot);
  return { snapshot, publicationId };
}
function summarize(value: string | null) {
  return value === null
    ? { value_type: "null" as const, characters: 0, sha256: null, preview: null, truncated: false }
    : { value_type: "string" as const, characters: value.length, sha256: sha(value), preview: value.slice(0, PREVIEW_CHARS), truncated: value.length > PREVIEW_CHARS };
}
function changedFields(snapshot: Snapshot, normalized: ReturnType<typeof normalize>) {
  return normalized.fields.filter(key => snapshot[editable[key]] !== normalized.payload[editable[key]]);
}
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_DRAFT_PLAN_BYTES) throw new DraftChangeError("plan_limit");
  return value;
}

/** Two reads, no writes or storage. An unchanged operation returns an empty diff. */
export async function planDraftUpdate(client: DraftChangeClient, input: DraftChangesInput, publication: string): Promise<DraftChangePlan> {
  const normalized = normalize(input);
  const target = selection(client, normalized.changes.draft_id, publication);
  const { snapshot, publicationId } = await readBefore(client, target.draftId);
  const changed = changedFields(snapshot, normalized);
  const result = draftPlanOutput.safeParse({
    format_version: 1,
    receipt: { format_version: 1, conversion_contract: CONVERSION_CONTRACT, publication, publication_url: target.origin,
      publication_id: publicationId, draft_id: target.draftId, observed_at: new Date().toISOString(),
      baseline_sha256: snapshotHash(snapshot), payload_sha256: normalized.payloadHash },
    editor_url: target.editorUrl, changed_fields: changed,
    changes: changed.map(key => ({ field: key, before: summarize(snapshot[editable[key]]), after: summarize(normalized.payload[editable[key]]!), preview_format: key === "body" ? "serialized_prosemirror" : "text" })),
    proposed_markdown_preview: normalized.changes.body?.slice(0, 2000) ?? null,
    markdown_preview_truncated: (normalized.changes.body?.length ?? 0) > 2000,
    unsupported_nodes: normalized.diagnostics,
    preflight: preflightDraft({ ...snapshot, ...normalized.payload }, target.draftId),
    scheduling_fields_not_returned: stateFields.filter(key => snapshot[key] === undefined),
    scheduling_policy: schedulingPolicy, limitations: DRAFT_CHANGE_LIMITATIONS,
  });
  if (!result.success) throw new DraftChangeError("plan_limit");
  return bounded(result.data);
}

/** Recheck, perform at most one PUT, then perform one readback. Never retry. */
export async function applyDraftUpdate(client: DraftChangeClient, input: DraftApplyInput, publication: string): Promise<DraftChangeResult> {
  const parsed = draftApplyInput.safeParse(input);
  if (!parsed.success) throw new DraftChangeError("invalid_receipt");
  const { receipt, ...changes } = parsed.data;
  const normalized = normalize(changes);
  const target = selection(client, changes.draft_id, publication);
  if (receipt.draft_id !== target.draftId || receipt.publication !== publication || receipt.publication_url !== target.origin) throw new DraftChangeError("invalid_receipt");
  if (receipt.payload_sha256 !== normalized.payloadHash) throw new DraftChangeError("payload_changed");
  const { snapshot, publicationId } = await readBefore(client, target.draftId);
  if (receipt.publication_id !== publicationId) throw new DraftChangeError("invalid_receipt");
  if (receipt.baseline_sha256 !== snapshotHash(snapshot)) throw new DraftChangeError("stale_draft");
  const changed = changedFields(snapshot, normalized);
  const base = { format_version: 1 as const, draft_id: target.draftId, publication, publication_id: publicationId, editor_url: target.editorUrl,
    changed_fields: changed, unsupported_nodes: normalized.diagnostics, limitations: DRAFT_CHANGE_LIMITATIONS };
  if (!changed.length) return draftApplyOutput.parse({ ...base, status: "verified", request_status: "not_attempted", write_attempts: 0,
    code: "no_changes", mismatched_fields: [], message: "The reviewed fields already match. No PUT was sent." });
  let requestStatus: "accepted" | "unknown" = "unknown";
  try {
    const reply = await client.writeDraft(target.draftId, normalized.payload);
    if (reply && typeof reply === "object" && !Array.isArray(reply) &&
      "id" in reply && reply.id === target.draftId && !("error" in reply) && !("errors" in reply) &&
      (!("publication_id" in reply) || reply.publication_id === publicationId)) requestStatus = "accepted";
  }
  catch { /* A timeout, malformed reply or rejection never triggers another PUT. */ }
  const finish = (status: DraftChangeResult["status"], code: DraftChangeResult["code"], message: string, mismatched: EditableField[] = []) =>
    draftApplyOutput.parse({ ...base, status, request_status: requestStatus, write_attempts: 1, code, mismatched_fields: mismatched, message });
  let raw: unknown;
  try { raw = await client.getDraft(target.draftId); }
  catch { return finish("unverified", "readback_unavailable", "The write was attempted once, but readback failed. Its final state is unverified. Inspect Substack before any further write; no retry was attempted."); }
  let after: Snapshot;
  try { after = parseSnapshot(raw, target.draftId, publicationId); }
  catch { return finish("unverified", "readback_unverifiable", "The write was attempted once, but the readback identity or fields could not be verified. Inspect Substack before any further write; no retry was attempted."); }
  try { requireEditable(after); }
  catch { return finish("conflict", "readback_state_changed", "Readback shows published, scheduled or sent-state indicators. Inspect Substack; no corrective write or retry was attempted."); }
  const mismatched = normalized.fields.filter(key => after[editable[key]] !== normalized.payload[editable[key]]);
  if (mismatched.length) return finish("conflict", "readback_mismatch", "Readback differs from the proposed fields. Another edit or upstream normalization may be responsible. Inspect Substack; no corrective write or retry was attempted.", mismatched);
  return finish("verified", "readback_matches", requestStatus === "accepted"
    ? "The changed fields match the requested values in one readback. This does not establish an atomic update or prevent later changes."
    : "The requested fields match readback, but the write response was not confirmed. This verifies observed state, not which request produced it. No retry was attempted.");
}
