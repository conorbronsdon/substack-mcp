import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  applyDraftUpdate, planDraftUpdate, draftPlanOutput, draftApplyOutput,
  DraftChangeError, MAX_DRAFT_PLAN_BYTES, type DraftChangesInput,
} from "../api/draft-changes.js";
import { convertMarkdown } from "../utils/markdown-to-prosemirror.js";
import type { DraftUpdatePayload } from "../api/types.js";

const originalBody = ' {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Original paragraph"}]}]}\n';
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const input: DraftChangesInput = { draft_id: 42, title: "Revised title", body: "Revised **paragraph**." };

function fixture(overrides: Record<string, unknown> = {}) {
  let state: Record<string, unknown> = {
    id: 42, publication_id: 7, is_published: false,
    draft_title: "Original title", draft_subtitle: null, draft_body: originalBody,
    audience: "everyone", draft_updated_at: "2026-09-07T20:00:00.000Z",
    section_id: null, cover_image: null, draft_bylines: [{ id: 9, is_guest: false }],
    post_date: null, trigger_at: null, scheduled_at: null, email_sent_at: null, published_at: null, is_scheduled: false,
    ...overrides,
  };
  const client = {
    origin: "https://example.substack.com",
    getPublication: vi.fn(async () => ({ data: { id: 7 } })),
    getDraft: vi.fn(async (_id: number): Promise<unknown> => structuredClone(state)),
    writeDraft: vi.fn(async (_id: number, changes: DraftUpdatePayload): Promise<unknown> => {
      state = { ...state, ...changes, draft_updated_at: "2026-09-07T20:01:00.000Z" };
      return structuredClone(state);
    }),
  };
  return { client, get state() { return state; }, setState(value: Record<string, unknown>) { state = value; } };
}

describe("read-only draft plans", () => {
  it("rejects reference expansion beyond the readback body limit before any API call", async () => {
    const { client } = fixture();
    const body = '[x][ref] '.repeat(1000) + '\n\n[ref]: https://example.com/' + 'a'.repeat(3000);
    expect(body.length).toBeLessThan(200_000);
    expect(() => convertMarkdown(body)).toThrow("2,000,000-character output limit");
    await expect(planDraftUpdate(client, { draft_id: 42, body }, "example")).rejects.toMatchObject({ code: "conversion_failed" });
    expect(client.getPublication).not.toHaveBeenCalled();
    expect(client.getDraft).not.toHaveBeenCalled();
    expect(client.writeDraft).not.toHaveBeenCalled();
  });
  it("reports bounded schema field paths without leaking rejected values", async () => {
    const { client } = fixture({ audience: { private: "sensitive marker" }, draft_bylines: [{ id: 9 }] });
    let error: DraftChangeError | undefined;
    try { await planDraftUpdate(client, input, "example"); } catch (caught) { error = caught as DraftChangeError; }
    expect(error?.code).toBe("invalid_draft");
    expect(error?.invalid_fields).toEqual(["/audience", "/draft_bylines/0/is_guest"]);
    expect(JSON.stringify(error)).not.toContain("sensitive marker");
    expect(client.writeDraft).not.toHaveBeenCalled();
  });
  it("describes the exact proposed native body and preflight without writing", async () => {
    const { client } = fixture();
    const plan = await planDraftUpdate(client, input, "example");
    const converted = JSON.stringify(convertMarkdown(input.body!).document);
    expect(plan.changed_fields).toEqual(["title", "body"]);
    expect(plan.changes).toEqual([
      { field: "title", before: { value_type: "string", characters: 14, sha256: hash("Original title"), preview: "Original title", truncated: false },
        after: { value_type: "string", characters: 13, sha256: hash("Revised title"), preview: "Revised title", truncated: false }, preview_format: "text" },
      { field: "body", before: { value_type: "string", characters: originalBody.length, sha256: hash(originalBody), preview: originalBody, truncated: false },
        after: { value_type: "string", characters: converted.length, sha256: hash(converted), preview: converted, truncated: false }, preview_format: "serialized_prosemirror" },
    ]);
    expect(plan.preflight.checks_passed).toBe(true);
    expect(plan.preflight.counts.text_characters).toBe(17);
    expect(plan.proposed_markdown_preview).toBe(input.body);
    expect(plan.receipt).toMatchObject({ format_version: 1, conversion_contract: "markdown-ast-v1", draft_id: 42, publication_id: 7, publication: "example", publication_url: client.origin });
    expect(plan.editor_url).toBe("https://example.substack.com/publish/post/42");
    expect(draftPlanOutput.parse(plan)).toEqual(plan);
    expect(client.getPublication).toHaveBeenCalledTimes(1);
    expect(client.getDraft).toHaveBeenCalledExactlyOnceWith(42);
    expect(client.writeDraft).not.toHaveBeenCalled();
  });

  it.each([-1, 0, 1.2, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])("rejects unsafe ID %s before reading", async draft_id => {
    const { client } = fixture();
    await expect(planDraftUpdate(client, { ...input, draft_id }, "example")).rejects.toMatchObject({ code: "invalid_input" });
    expect(client.getPublication).not.toHaveBeenCalled(); expect(client.getDraft).not.toHaveBeenCalled(); expect(client.writeDraft).not.toHaveBeenCalled();
  });
  it.each([
    { draft_id: 42 }, { draft_id: 42, publish: true }, { draft_id: 42, section_id: 3 },
    { draft_id: 42, title: "x".repeat(10_001) }, { draft_id: 42, audience: "other" },
    { draft_id: 42, body: "x".repeat(200_001) }, { draft_id: 42, subtitle: null },
  ])("rejects empty, unknown or malformed changes before reading", async changes => {
    const { client } = fixture();
    await expect(planDraftUpdate(client, changes as DraftChangesInput, "example")).rejects.toMatchObject({ code: "invalid_input" });
    expect(client.getPublication).not.toHaveBeenCalled(); expect(client.writeDraft).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(129)])("rejects an invalid publication key", async publication => {
    const { client } = fixture();
    await expect(planDraftUpdate(client, input, publication)).rejects.toMatchObject({ code: "invalid_selection" });
    expect(client.getPublication).not.toHaveBeenCalled();
  });
  it.each(["http://example.substack.com", "https://user:password@example.substack.com", "https://example.substack.com/path"])("rejects an invalid origin %s", async origin => {
    const { client } = fixture(); client.origin = origin;
    await expect(planDraftUpdate(client, input, "example")).rejects.toMatchObject({ code: "invalid_selection" });
    expect(client.getPublication).not.toHaveBeenCalled();
  });

  it.each([
    ["missing publication ID", { publication_id: undefined }, "invalid_draft"],
    ["null publication ID", { publication_id: null }, "invalid_draft"],
    ["wrong publication", { publication_id: 8 }, "publication_mismatch"],
    ["wrong draft", { id: 43 }, "invalid_draft"],
    ["missing publication state", { is_published: undefined }, "invalid_draft"],
    ["null publication state", { is_published: null }, "invalid_draft"],
    ["string publication state", { is_published: "false" }, "invalid_draft"],
    ["published", { is_published: true }, "published_draft"],
    ["scheduled flag", { is_scheduled: true }, "scheduled_draft"],
    ["scheduled trigger", { trigger_at: "2026-10-01T00:00:00Z" }, "scheduled_draft"],
    ["scheduled timestamp", { scheduled_at: "2026-10-01T00:00:00Z" }, "scheduled_draft"],
    ["sent", { email_sent_at: "2026-09-07T00:00:00Z" }, "scheduled_draft"],
    ["published timestamp", { published_at: "2026-09-07T00:00:00Z" }, "scheduled_draft"],
    ["missing original body", { draft_body: undefined }, "invalid_draft"],
    ["missing subtitle", { draft_subtitle: undefined }, "invalid_draft"],
    ["oversized original body", { draft_body: "x".repeat(2_000_001) }, "invalid_draft"],
  ] as const)("refuses %s without a PUT", async (_name, state, code) => {
    const { client } = fixture(state);
    await expect(planDraftUpdate(client, input, "example")).rejects.toMatchObject({ code });
    expect(client.writeDraft).not.toHaveBeenCalled();
  });
  it("keeps missing scheduling evidence explicit and does not infer publication from post_date", async () => {
    const { client } = fixture({ post_date: "2026-09-10T00:00:00Z", trigger_at: undefined, scheduled_at: undefined, email_sent_at: undefined, published_at: undefined, is_scheduled: undefined });
    const plan = await planDraftUpdate(client, input, "example");
    expect(plan.scheduling_fields_not_returned).toEqual(["trigger_at", "scheduled_at", "email_sent_at", "published_at", "is_scheduled"]);
    expect(plan.scheduling_policy).toContain("do not prove");
    expect(plan.scheduling_policy).toContain("post_date alone");
    expect(client.writeDraft).not.toHaveBeenCalled();
  });
  it("preserves null metadata in the review and permits explicit empty replacements", async () => {
    const { client } = fixture({ draft_title: null, draft_subtitle: null, draft_body: null });
    const changes = { draft_id: 42, title: "", subtitle: "", body: "" };
    const plan = await planDraftUpdate(client, changes, "example");
    expect(plan.changed_fields).toEqual(["title", "subtitle", "body"]);
    for (const change of plan.changes) expect(change.before).toEqual({ value_type: "null", characters: 0, sha256: null, preview: null, truncated: false });
    expect(plan.preflight.findings).toContainEqual({ severity: "error", code: "missing_title", message: "Add a draft title." });
    const result = await applyDraftUpdate(client, { ...changes, receipt: plan.receipt }, "example");
    expect(result.status).toBe("verified");
    expect(client.writeDraft.mock.calls[0]).toEqual([42, { draft_title: "", draft_subtitle: "", draft_body: '{"type":"doc","content":[{"type":"paragraph"}]}' }]);
  });
  it("bounds previews without changing the proposed payload or claiming a complete preview", async () => {
    const { client } = fixture({ draft_title: "é".repeat(10_000) });
    const body = "New content. ".repeat(2000);
    const changes = { draft_id: 42, title: "t".repeat(10_000), body };
    const plan = await planDraftUpdate(client, changes, "example");
    expect(plan.changes[0].before.preview).toHaveLength(512);
    expect(plan.changes[0].before.truncated).toBe(true);
    expect(plan.proposed_markdown_preview).toBe(body.slice(0, 2000));
    expect(plan.markdown_preview_truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(plan), "utf8")).toBeLessThan(MAX_DRAFT_PLAN_BYTES);
    await applyDraftUpdate(client, { ...changes, receipt: plan.receipt }, "example");
    expect(client.writeDraft.mock.calls[0][1].draft_body).toBe(JSON.stringify(convertMarkdown(body).document));
  });

  it("requires an explicit conversion-loss acknowledgment before reads, and carries the losses through apply", async () => {
    const { client } = fixture();
    const changes = { draft_id: 42, body: "| A | B |\n|---|---|\n| x | y |" };
    const error = await planDraftUpdate(client, changes, "example").catch(error => error) as DraftChangeError;
    expect(error.code).toBe("unsupported_markdown");
    expect(error.unsupported_nodes[0].type).toBe("table");
    expect(client.getPublication).not.toHaveBeenCalled(); expect(client.writeDraft).not.toHaveBeenCalled();
    const acknowledged = { ...changes, allow_unsupported: true };
    const plan = await planDraftUpdate(client, acknowledged, "example");
    const result = await applyDraftUpdate(client, { ...acknowledged, receipt: plan.receipt }, "example");
    expect(result.status).toBe("verified");
    expect(result.unsupported_nodes).toEqual(error.unsupported_nodes);
    expect(JSON.parse(client.writeDraft.mock.calls[0][1].draft_body!).content[0].type).toBe("code_block");
  });
  it("returns a static conversion error without exposing source or reading the API", async () => {
    const { client } = fixture();
    const secret = "private-draft-material";
    const error = await planDraftUpdate(client, { draft_id: 42, body: "> ".repeat(102) + secret }, "example").catch(error => error) as DraftChangeError;
    expect(error.code).toBe("conversion_failed"); expect(error.message).not.toContain(secret);
    expect(client.getPublication).not.toHaveBeenCalled();
  });
  it("does not expose arbitrary failed read messages", async () => {
    const { client } = fixture();
    client.getPublication.mockRejectedValueOnce(new Error("cookie-and-draft-secret"));
    const first = await planDraftUpdate(client, input, "example").catch(error => error) as DraftChangeError;
    expect(first.code).toBe("publication_unavailable"); expect(first.message).not.toContain("secret");
    client.getDraft.mockRejectedValueOnce(new Error("draft-secret"));
    const second = await planDraftUpdate(client, input, "example").catch(error => error) as DraftChangeError;
    expect(second.code).toBe("draft_unavailable"); expect(second.message).not.toContain("secret");
    expect(client.writeDraft).not.toHaveBeenCalled();
  });
});

describe("applying the exact reviewed draft change", () => {
  it("accepts a serialized receipt in an independent client and performs one PUT plus readback", async () => {
    const planning = fixture();
    const plan = await planDraftUpdate(planning.client, input, "example");
    const applying = fixture();
    const result = await applyDraftUpdate(applying.client, { ...input, receipt: JSON.parse(JSON.stringify(plan.receipt)) }, "example");
    expect(result).toMatchObject({ status: "verified", request_status: "accepted", write_attempts: 1, code: "readback_matches", changed_fields: ["title", "body"], mismatched_fields: [] });
    expect(draftApplyOutput.parse(result)).toEqual(result);
    expect(applying.client.writeDraft).toHaveBeenCalledExactlyOnceWith(42, { draft_title: "Revised title", draft_body: JSON.stringify(convertMarkdown(input.body!).document) });
    expect(applying.client.getPublication).toHaveBeenCalledTimes(1);
    expect(applying.client.getDraft.mock.calls).toEqual([[42], [42]]);
    expect(planning.client.writeDraft).not.toHaveBeenCalled();
  });
  it.each([
    { title: "Altered title" }, { body: "Altered body" }, { subtitle: "New subtitle" }, { audience: "only_paid" }, { allow_unsupported: true },
  ] as const)("rejects changed proposed input %j before any apply reads", async alteration => {
    const { client } = fixture();
    const plan = await planDraftUpdate(client, input, "example");
    client.getPublication.mockClear(); client.getDraft.mockClear();
    await expect(applyDraftUpdate(client, { ...input, ...alteration, receipt: plan.receipt }, "example")).rejects.toMatchObject({ code: "payload_changed" });
    expect(client.getPublication).not.toHaveBeenCalled(); expect(client.getDraft).not.toHaveBeenCalled(); expect(client.writeDraft).not.toHaveBeenCalled();
  });
  it("binds exact original Markdown even when different syntax converts to the same document", async () => {
    const { client } = fixture();
    expect(convertMarkdown("**word**").document).toEqual(convertMarkdown("__word__").document);
    const plan = await planDraftUpdate(client, { draft_id: 42, body: "**word**" }, "example");
    await expect(applyDraftUpdate(client, { draft_id: 42, body: "__word__", receipt: plan.receipt }, "example")).rejects.toMatchObject({ code: "payload_changed" });
    expect(client.writeDraft).not.toHaveBeenCalled();
  });
  it.each([
    { draft_title: "Editor title" }, { draft_subtitle: "Editor subtitle" }, { draft_body: originalBody.trim() },
    { audience: "only_paid" }, { section_id: 3 }, { cover_image: "https://substackcdn.com/new.png" },
    { draft_bylines: [{ id: 10, is_guest: false }] }, { draft_updated_at: "2026-09-07T20:01:00Z" },
    { post_date: "2026-09-07T20:02:00Z" }, { type: "podcast" }, { section_id: undefined },
  ])("rejects concurrent changes to baseline fields %j", async alteration => {
    const f = fixture();
    const plan = await planDraftUpdate(f.client, input, "example");
    f.setState({ ...f.state, ...alteration });
    await expect(applyDraftUpdate(f.client, { ...input, receipt: plan.receipt }, "example")).rejects.toMatchObject({ code: "stale_draft" });
    expect(f.client.writeDraft).not.toHaveBeenCalled();
  });
  it.each([
    [{ is_published: true }, "published_draft"], [{ publication_id: 8 }, "publication_mismatch"],
    [{ is_published: undefined }, "invalid_draft"], [{ is_scheduled: true }, "scheduled_draft"],
  ] as const)("rechecks current state immediately before applying %j", async (alteration, code) => {
    const f = fixture();
    const plan = await planDraftUpdate(f.client, input, "example");
    f.setState({ ...f.state, ...alteration });
    await expect(applyDraftUpdate(f.client, { ...input, receipt: plan.receipt }, "example")).rejects.toMatchObject({ code });
    expect(f.client.writeDraft).not.toHaveBeenCalled();
  });
  it.each([
    { publication: "other" }, { publication_url: "https://other.substack.com" }, { draft_id: 43 },
    { publication_id: 8 }, { format_version: 2 }, { conversion_contract: "other" }, { baseline_sha256: "0".repeat(64) },
  ])("rejects an altered receipt target or baseline %j", async alteration => {
    const { client } = fixture();
    const plan = await planDraftUpdate(client, input, "example");
    await expect(applyDraftUpdate(client, { ...input, receipt: { ...plan.receipt, ...alteration } } as never, "example")).rejects.toBeInstanceOf(DraftChangeError);
    expect(client.writeDraft).not.toHaveBeenCalled();
  });
  it("does not issue a PUT for a no-op plan", async () => {
    const { client } = fixture();
    const changes = { draft_id: 42, title: "Original title" };
    const plan = await planDraftUpdate(client, changes, "example");
    expect(plan.changes).toEqual([]);
    const result = await applyDraftUpdate(client, { ...changes, receipt: plan.receipt }, "example");
    expect(result).toMatchObject({ status: "verified", request_status: "not_attempted", write_attempts: 0, code: "no_changes", changed_fields: [] });
    expect(client.writeDraft).not.toHaveBeenCalled(); expect(client.getDraft).toHaveBeenCalledTimes(2);
  });
  it("ignores object key order but distinguishes omitted optional metadata from null", async () => {
    const f = fixture();
    const plan = await planDraftUpdate(f.client, input, "example");
    f.setState(Object.fromEntries(Object.entries(f.state).reverse()));
    expect((await applyDraftUpdate(f.client, { ...input, receipt: plan.receipt }, "example")).status).toBe("verified");
    expect(f.client.writeDraft).toHaveBeenCalledTimes(1);
  });
});

describe("single-attempt draft readback outcomes", () => {
  it.each([{}, { id: 42, error: "private rejection detail" }, { id: 99 }, { id: 42, publication_id: 8 }])("does not treat an unrecognized write reply as acceptance %j", async reply => {
    const f = fixture(); const plan = await planDraftUpdate(f.client, input, "example");
    f.client.writeDraft.mockImplementationOnce(async (_id, payload) => { f.setState({ ...f.state, ...payload }); return reply; });
    const result = await applyDraftUpdate(f.client, { ...input, receipt: plan.receipt }, "example");
    expect(result).toMatchObject({ status: "verified", request_status: "unknown", write_attempts: 1, code: "readback_matches" });
    expect(JSON.stringify(result)).not.toContain("private rejection"); expect(f.client.writeDraft).toHaveBeenCalledTimes(1);
  });
  it("verifies observed state after a timeout following commit without pretending the response succeeded", async () => {
    const f = fixture();
    const plan = await planDraftUpdate(f.client, input, "example");
    f.client.writeDraft.mockImplementationOnce(async (_id, payload) => {
      f.setState({ ...f.state, ...payload });
      throw new Error("timeout with private raw content");
    });
    const result = await applyDraftUpdate(f.client, { ...input, receipt: plan.receipt }, "example");
    expect(result).toMatchObject({ status: "verified", request_status: "unknown", write_attempts: 1, code: "readback_matches" });
    expect(result.message).toContain("not which request");
    expect(JSON.stringify(result)).not.toContain("private raw");
    expect(f.client.writeDraft).toHaveBeenCalledTimes(1); expect(f.client.getDraft).toHaveBeenCalledTimes(3);
  });
  it("reports failed readback after an accepted write without retrying", async () => {
    const f = fixture(); const plan = await planDraftUpdate(f.client, input, "example");
    f.client.getDraft.mockResolvedValueOnce(structuredClone(f.state)).mockRejectedValueOnce(new Error("private-readback-error"));
    const result = await applyDraftUpdate(f.client, { ...input, receipt: plan.receipt }, "example");
    expect(result).toMatchObject({ status: "unverified", request_status: "accepted", code: "readback_unavailable", write_attempts: 1 });
    expect(JSON.stringify(result)).not.toContain("private-readback-error"); expect(f.client.writeDraft).toHaveBeenCalledTimes(1);
  });
  it("reports an unknown write and failed readback as unverified with exactly one write", async () => {
    const f = fixture(); const plan = await planDraftUpdate(f.client, input, "example");
    f.client.writeDraft.mockRejectedValueOnce(new Error("connection reset"));
    f.client.getDraft.mockResolvedValueOnce(structuredClone(f.state)).mockRejectedValueOnce(new Error("read failed"));
    const result = await applyDraftUpdate(f.client, { ...input, receipt: plan.receipt }, "example");
    expect(result).toMatchObject({ status: "unverified", request_status: "unknown", code: "readback_unavailable", write_attempts: 1 });
    expect(f.client.writeDraft).toHaveBeenCalledTimes(1);
  });
  it("reports a conflicting readback without issuing a corrective overwrite", async () => {
    const f = fixture(); const plan = await planDraftUpdate(f.client, input, "example");
    f.client.writeDraft.mockImplementationOnce(async (_id, payload) => {
      f.setState({ ...f.state, ...payload, draft_title: "Concurrent editor change" });
      return f.state;
    });
    const result = await applyDraftUpdate(f.client, { ...input, receipt: plan.receipt }, "example");
    expect(result).toMatchObject({ status: "conflict", request_status: "accepted", code: "readback_mismatch", mismatched_fields: ["title"] });
    expect(f.state.draft_title).toBe("Concurrent editor change"); expect(f.client.writeDraft).toHaveBeenCalledTimes(1);
  });
  it.each([{ is_published: true }, { is_scheduled: true }, { email_sent_at: "2026-09-07T21:00:00Z" }])("reports state changes across the residual race %j", async alteration => {
    const f = fixture(); const plan = await planDraftUpdate(f.client, input, "example");
    f.client.writeDraft.mockImplementationOnce(async (_id, payload) => { f.setState({ ...f.state, ...payload, ...alteration }); return f.state; });
    const result = await applyDraftUpdate(f.client, { ...input, receipt: plan.receipt }, "example");
    expect(result).toMatchObject({ status: "conflict", code: "readback_state_changed", write_attempts: 1 });
    expect(f.client.writeDraft).toHaveBeenCalledTimes(1);
  });
  it.each([{ publication_id: 8 }, { id: 99 }, { is_published: undefined }, { draft_body: undefined }])("never verifies an unreliable readback %j", async alteration => {
    const f = fixture(); const plan = await planDraftUpdate(f.client, input, "example");
    f.client.writeDraft.mockImplementationOnce(async (_id, payload) => { f.setState({ ...f.state, ...payload, ...alteration }); return f.state; });
    const result = await applyDraftUpdate(f.client, { ...input, receipt: plan.receipt }, "example");
    expect(result).toMatchObject({ status: "unverified", code: "readback_unverifiable", write_attempts: 1 });
    expect(f.client.writeDraft).toHaveBeenCalledTimes(1);
  });
  it("does not label upstream body normalization as exact readback", async () => {
    const f = fixture(); const plan = await planDraftUpdate(f.client, input, "example");
    f.client.writeDraft.mockImplementationOnce(async (_id, payload) => {
      f.setState({ ...f.state, ...payload, draft_body: payload.draft_body + "\n" }); return f.state;
    });
    const result = await applyDraftUpdate(f.client, { ...input, receipt: plan.receipt }, "example");
    expect(result).toMatchObject({ status: "conflict", code: "readback_mismatch", mismatched_fields: ["body"] });
    expect(result.message).toContain("cause is not established"); expect(f.client.writeDraft).toHaveBeenCalledTimes(1);
  });
  it("a repeated application of an old receipt cannot reapply a committed change", async () => {
    const { client } = fixture(); const plan = await planDraftUpdate(client, input, "example");
    const applying = { ...input, receipt: plan.receipt };
    await applyDraftUpdate(client, applying, "example");
    await expect(applyDraftUpdate(client, applying, "example")).rejects.toMatchObject({ code: "stale_draft" });
    expect(client.writeDraft).toHaveBeenCalledTimes(1);
  });
});
