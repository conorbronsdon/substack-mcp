import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SubstackClient } from "../api/client.js";
import { createServer } from "../server.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const definition = (tagId: string, pubId = 7, hidden = false) => ({ id: tagId, publication_id: pubId, name: `Tag ${tagId.slice(0, 8)}`, slug: "tag", hidden });
const link = (tagId: string, pubId = 7) => ({ id: C, publication_id: pubId, post_id: 42, post_tag_id: tagId });
const draft = (overrides = {}) => ({ id: 42, publication_id: 7, is_published: false, ...overrides });
type Config = { definitions?: unknown; draft?: unknown; associations?: unknown; readback?: unknown; writeStatus?: number; writeResponse?: unknown; prewrite?: unknown; oversizedDefinitions?: boolean };

async function setup(config: Config = {}, multi = false) {
  let draftReads = 0, associationReads = 0;
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = options?.method ?? "GET";
    if (config.oversizedDefinitions && path === "/api/v1/publication/post-tag") return new Response("{}", { headers: { "content-length": String(11 * 1024 * 1024) } });
    let body: unknown;
    if (path === "/api/v1/publication") body = { id: 7, name: "Example", subdomain: "b" };
    else if (path === "/api/v1/publication/post-tag") body = config.definitions === undefined ? [definition(A), definition(B)] : config.definitions;
    else if (path === "/api/v1/drafts/42") { draftReads++; body = draftReads === 2 && config.prewrite !== undefined ? config.prewrite : config.draft ?? draft(); }
    else if (path === "/api/v1/post/42/tag") { associationReads++; body = associationReads === 2 && config.readback !== undefined ? config.readback : config.associations ?? []; }
    else if (path.startsWith("/api/v1/post/42/tag/")) {
      if (config.writeStatus) return new Response("{}", { status: config.writeStatus });
      body = config.writeResponse === undefined ? method === "POST" ? link(path.split("/").at(-1)!) : {} : config.writeResponse;
    } else throw new Error("Unexpected mocked route");
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const pubs = (multi ? ["a", "b"] : ["b"]).map(key => ({ key, label: key, client: new SubstackClient(`https://${key}.substack.com`, "example-session", "1") }));
  const server = createServer(pubs), client = new Client({ name: "draft-tags-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, fetchMock, close: async () => { await client.close(); await server.close(); }, calls: () => fetchMock.mock.calls,
    run: (args: Record<string, unknown>) => client.callTool({ name: "update_draft_tags", arguments: { draft_id: 42, ...args, ...(multi ? { publication: "b" } : {}) } }) };
}
afterEach(() => vi.unstubAllGlobals());
const data = (reply: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["run"]>>) => JSON.parse((reply.content as { text: string }[])[0].text);

describe("update_draft_tags", () => {
  it("dry-runs by default with hidden names and zero non-GET requests", async () => {
    const c = await setup({ definitions: [definition(A, 7, true), definition(B)], associations: [link(B)] });
    try {
      const reply = await c.run({ add: [A, B], remove: [B] });
      // Overlap is invalid even when one side is already attached.
      expect(reply.isError).toBe(true); expect(c.calls()).toHaveLength(0);
      const valid = await c.run({ add: [A], remove: [B] });
      expect(valid.isError).not.toBe(true);
      expect(valid.structuredContent).toEqual(data(valid));
      expect(data(valid)).toMatchObject({ dry_run: true, write_attempts: 0, results: [
        { tag_id: A, hidden: true, requested: "add", outcome: "planned" },
        { tag_id: B, requested: "remove", outcome: "planned" },
      ] });
      expect(c.calls().map(([, options]) => options?.method ?? "GET")).toEqual(["GET", "GET", "GET", "GET"]);
    } finally { await c.close(); }
  });
  it.each([{ add: [A, A] }, { add: [A], remove: [A] }, { add: [] }, { add: ["bad"] },
    { add: Array.from({ length: 21 }, (_, n) => uuid(n)) }])("rejects invalid inputs before fetch: %j", async args => {
    const c = await setup();
    try { expect((await c.run(args)).isError).toBe(true); expect(c.calls()).toHaveLength(0); }
    finally { await c.close(); }
  });
  it.each([
    [{ draft: draft({ is_published: true }) }, "draft_published"],
    [{ draft: draft({ publication_id: 8 }) }, "publication_mismatch"],
    [{ draft: draft({ scheduled_at: "tomorrow" }) }, "draft_unverifiable"],
    [{ definitions: [definition(A, 8)] }, "response_invalid"],
    [{ definitions: [definition(B)] }, "unknown_tag"],
    [{ definitions: null }, "response_invalid"],
    [{ oversizedDefinitions: true }, "response_invalid"],
    [{ definitions: Array.from({ length: 10001 }, (_, n) => definition(uuid(n))) }, "response_invalid"],
    [{ associations: [{ ...link(B), post_id: 99 }] }, "response_invalid"],
    [{ associations: [link(B), { ...link(B), id: A }] }, "response_invalid"],
  ] as const)("refuses unsafe or malformed initial state: %j", async (config, code) => {
    const c = await setup(config);
    try {
      const reply = await c.run({ add: [A], dry_run: false });
      expect(reply.isError).toBe(true); expect(data(reply)).toMatchObject({ code, write_attempts: 0, results: [{ outcome: "not_attempted" }] });
      if (code === "unknown_tag") expect(data(reply).results[0]).toMatchObject({ tag_name: null, hidden: null });
      expect(c.calls().every(([, options]) => (options?.method ?? "GET") === "GET")).toBe(true);
    } finally { await c.close(); }
  });
  it.each([
    [draft({ is_published: true }), "draft_published"],
    [null, "draft_unverifiable"],
  ] as const)("aborts when pre-write recheck cannot prove an unpublished draft", async (prewrite, code) => {
    const c = await setup({ prewrite });
    try {
      const reply = await c.run({ add: [A], dry_run: false });
      expect(data(reply)).toMatchObject({ code, write_attempts: 0, results: [{ outcome: "not_attempted" }] });
      expect(c.calls().every(([, options]) => (options?.method ?? "GET") === "GET")).toBe(true);
    } finally { await c.close(); }
  });
  it("sends bodyless POST then DELETE once each and verifies one readback", async () => {
    const c = await setup({ associations: [link(B)], readback: [link(A)] });
    try {
      const reply = await c.run({ add: [A], remove: [B], dry_run: false });
      expect(data(reply)).toMatchObject({ write_attempts: 2, results: [{ outcome: "verified" }, { outcome: "verified" }] });
      const writes = c.calls().filter(([, options]) => options?.method === "POST" || options?.method === "DELETE");
      expect(writes.map(([, options]) => options?.method)).toEqual(["POST", "DELETE"]);
      for (const [, options] of writes) {
        expect(options?.body).toBeUndefined();
        const headers = new Headers(options?.headers);
        expect(headers.get("content-type")).toBeNull();
        expect(headers.get("referer")).toBe("https://b.substack.com/publish/post");
      }
      expect(c.calls()).toHaveLength(8);
    } finally { await c.close(); }
  });
  it("skips associations already in the requested state", async () => {
    const c = await setup({ associations: [link(A)] });
    try {
      expect(data(await c.run({ add: [A], remove: [B], dry_run: false }))).toMatchObject({ write_attempts: 0,
        results: [{ outcome: "already_present" }, { outcome: "already_absent" }] });
      expect(c.calls()).toHaveLength(4);
    } finally { await c.close(); }
  });
  it("reports readback misses as unverified", async () => {
    const c = await setup();
    try { expect(data(await c.run({ add: [A], dry_run: false }))).toMatchObject({ write_attempts: 1, results: [{ outcome: "unverified" }] }); }
    finally { await c.close(); }
  });
  it("stops on a malformed write acknowledgement and leaves its outcome unknown", async () => {
    const c = await setup({ writeResponse: { unexpected: true } });
    try {
      expect(data(await c.run({ add: [A, B], dry_run: false }))).toMatchObject({ write_attempts: 1,
        results: [{ outcome: "unknown" }, { outcome: "not_attempted" }] });
      expect(c.calls().filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    } finally { await c.close(); }
  });
  it("stops after a 403 and marks the second add not_attempted", async () => {
    const c = await setup({ writeStatus: 403 });
    try {
      expect(data(await c.run({ add: [A, B], dry_run: false }))).toMatchObject({ write_attempts: 1, results: [{ outcome: "retryable" }, { outcome: "not_attempted" }] });
      expect(c.calls().filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    } finally { await c.close(); }
  });
  it("records 400 as rejected and continues with the next requested tag", async () => {
    const c = await setup({ writeStatus: 400 });
    try {
      expect(data(await c.run({ add: [A, B], dry_run: false }))).toMatchObject({ write_attempts: 2,
        results: [{ outcome: "rejected" }, { outcome: "rejected" }] });
    } finally { await c.close(); }
  });
  it("requires a configured publication and never mixes accounts", async () => {
    const c = await setup({}, true);
    try {
      const before = c.calls().length;
      for (const publication of [undefined, "wrong"]) {
        expect((await c.client.callTool({ name: "update_draft_tags", arguments: { draft_id: 42, add: [A], publication } })).isError).toBe(true);
      }
      expect(c.calls()).toHaveLength(before);
      expect((await c.run({ add: [A] })).isError).not.toBe(true);
      expect(c.calls().every(([url]) => url.startsWith("https://b.substack.com/"))).toBe(true);
    } finally { await c.close(); }
  });
});
