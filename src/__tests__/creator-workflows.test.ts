import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { SubstackClient } from "../api/client.js";
import { searchPosts } from "../api/search.js";
import { preflightDraft } from "../utils/draft-preflight.js";
import { doctor } from "../doctor.js";
import type { PublicationCredentials } from "../auth/resolve-publications.js";

afterEach(() => vi.unstubAllGlobals());
const body = (content: unknown[]) => JSON.stringify({ type: "doc", content });
const draft = { id: 42, draft_title: "A draft", audience: "everyone", draft_body: body([{ type: "paragraph", content: [{ type: "text", text: "Content" }] }]) };
const codes = (d: unknown) => preflightDraft(d, 42).findings.map(f => f.code);

describe("archive search", () => {
  it.each(["published", "drafts", "scheduled"] as const)("encodes the query and uses the %s archive in a single request", async status => {
    const read = vi.fn(async (_path: string) => ({ posts: [{ id: 1, title: "Match", draft_body: "private full body", stats: { secret: true } }], total: 10 }));
    const result = await searchPosts({ query: "A&B #test", status, offset: 2, limit: 1 }, read);
    const url = new URL(read.mock.calls[0][0]!, "https://a.substack.com");
    expect(url.pathname).toBe(`/api/v1/post_management/${status}`);
    expect(url.searchParams.get("query")).toBe("A&B #test");
    expect(url.searchParams.get("order_by")).toBe({ published: "post_date", drafts: "draft_updated_at", scheduled: "trigger_at" }[status]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ next_offset: 3, has_more: true, returned: 1, total: 10 });
    expect(result.posts).toEqual([{ id: 1, title: "Match" }]);
  });
  it.each([{ query: " " }, { query: "x", limit: 51 }, { query: "x", offset: -1 }, { query: "x", limit: 1.5 }])("rejects invalid bounds without a request: %j", async input => {
    const read = vi.fn();
    await expect(searchPosts(input, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it.each([{}, { posts: null }, { posts: [{}] }, { posts: [], total: -1 }, { posts: [{ id: 1 }, { id: 2 }] }])("does not turn malformed responses into an empty archive: %j", async response => {
    await expect(searchPosts({ query: "x", limit: 1 }, async () => response)).rejects.toThrow(/archive search/i);
  });
  it("preserves uncertainty when totals are omitted", async () => {
    expect(await searchPosts({ query: "x", limit: 1 }, async () => ({ posts: [{ id: 1 }] }))).toMatchObject({ total: null, has_more: null, next_offset: 1 });
    expect(await searchPosts({ query: "x" }, async () => ({ posts: [] }))).toMatchObject({ total: null, has_more: false, next_offset: null });
  });
  it("rejects an empty page before the reported total instead of returning a contradictory cursor", async () => {
    await expect(searchPosts({ query: "x", offset: 2 }, async () => ({ posts: [], total: 10 }))).rejects.toThrow(/Inconsistent/);
  });
  it.each([
    { offset: 0, posts: [{ id: 1 }], total: 0, expected: "returned rows exceed the reported total" },
    { offset: 2, posts: [{ id: 1 }, { id: 2 }], total: 3, expected: "returned rows exceed the reported total" },
    { offset: 0, posts: [{ id: 1 }, { id: 1 }], total: 2, expected: "duplicate post IDs" },
    { offset: 0, posts: [{ id: Number.MAX_SAFE_INTEGER + 1 }], total: 1, expected: "Unexpected archive search response" },
    { offset: 0, posts: [], total: Number.MAX_SAFE_INTEGER + 1, expected: "Unexpected archive search response" },
  ])("rejects inconsistent totals, duplicate rows and unsafe integers", async ({ offset, expected, ...response }) => {
    await expect(searchPosts({ query: "x", offset }, async () => response)).rejects.toThrow(expected);
  });
  it("accepts an exact final page and an empty page beyond a now-smaller archive", async () => {
    expect(await searchPosts({ query: "x", offset: 2 }, async () => ({ posts: [{ id: 3 }], total: 3 }))).toMatchObject({ has_more: false, next_offset: null, returned: 1 });
    expect(await searchPosts({ query: "x", offset: 5 }, async () => ({ posts: [], total: 3 }))).toMatchObject({ has_more: false, next_offset: null, returned: 0 });
  });
  it("advances a short nonempty page and stops a full final page", async () => {
    expect(await searchPosts({ query: "x", limit: 25 }, async () => ({ posts: [{ id: 1 }], total: 3 }))).toMatchObject({ has_more: true, next_offset: 1 });
    expect(await searchPosts({ query: "x", offset: 2, limit: 1 }, async () => ({ posts: [{ id: 3 }], total: 3 }))).toMatchObject({ has_more: false, next_offset: null });
  });
});

describe("draft preflight", () => {
  it("passes ordinary content without mutating the draft", () => {
    const copy = JSON.stringify(draft);
    expect(preflightDraft(draft, 42)).toMatchObject({ checks_passed: true, findings: [] });
    expect(JSON.stringify(draft)).toBe(copy);
  });
  it("rejects mismatched IDs", () => expect(() => preflightDraft(draft, 43)).toThrow(/mismatched/));
  it.each([
    [{ ...draft, draft_title: " " }, "missing_title"],
    [{ ...draft, audience: "made_up" }, "unknown_audience"],
    [{ ...draft, draft_body: "{" }, "invalid_json"],
    [{ ...draft, draft_body: "null" }, "invalid_document"],
    [{ ...draft, draft_body: body([{ type: "paragraph", content: "bad" }]) }, "invalid_content"],
    [{ ...draft, draft_body: body([{ type: "captionedImage", attrs: { src: "https://example.org/a.png" } }]) }, "image_wrapper"],
    [{ ...draft, draft_body: body([{ type: "image2", attrs: { src: "javascript:alert(1)" } }]) }, "invalid_image_url"],
    [{ ...draft, draft_body: body([{ type: "paywall" }, { type: "paywall" }]) }, "multiple_paywalls"],
    [{ ...draft, draft_body: "x".repeat(2_000_001) }, "body_limit"],
  ])("reports blocking findings", (input, code) => {
    expect(codes(input)).toContain(code);
    expect(preflightDraft(input, 42).checks_passed).toBe(false);
  });
  it("flags unknown nodes and lookalike CDN domains without fetching images", () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(codes({ ...draft, draft_body: body([{ type: "embed" }, { type: "image2", attrs: { src: "https://substackcdn.com.example.org/a.png" } }]) })).toEqual(expect.arrayContaining(["unrecognized_nodes", "external_images"]));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("bounds deeply nested bodies", () => {
    let node: unknown = { type: "text", text: "deep" };
    for (let i = 0; i < 102; i++) node = { type: "blockquote", content: [node] };
    const result = preflightDraft({ ...draft, draft_body: body([node]) }, 42);
    expect(result.findings.map(f => f.code)).toContain("structure_limit");
    expect(result.counts.complete).toBe(false);
    expect(result.findings.map(f => f.code)).not.toContain("no_text_or_images");
  });
  it("names unknown node types in a bounded warning", () => {
    const result = preflightDraft({ ...draft, draft_body: body(Array.from({ length: 12 }, (_, i) => ({ type: `custom_${i}` }))) }, 42);
    const warning = result.findings.find(f => f.code === "unrecognized_nodes")!;
    expect(warning.message.match(/custom_/g)).toHaveLength(5);
    expect(result.counts.complete).toBe(true);
  });
});

const testSessionToken = randomUUID();
const credential: PublicationCredentials = { key: "example", label: "Example", publicationUrl: "https://example.substack.com", sessionToken: testSessionToken, userId: "123", source: "env", missing: [] };
describe("doctor", () => {
  it("is offline by default and omits credentials and user IDs", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const report = await doctor(false, () => [credential]);
    expect(report.ok).toBe(true);
    expect(report.runtime).toEqual({ node: process.version, platform: process.platform });
    expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.stringify(report)).not.toContain(testSessionToken);
    expect(JSON.stringify(report)).not.toContain("123");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["https://name:secret@example.org", "https://example.org/path?secret", "http://example.org", "invalid"])("rejects and redacts malformed origin %s", async publicationUrl => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const report = await doctor(true, () => [{ ...credential, publicationUrl }]);
    expect(report.ok).toBe(false);
    expect(report.publications[0].origin).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["0", "1foo", "-2", "9007199254740992"])("rejects invalid user ID %s", async userId => {
    expect((await doctor(false, () => [{ ...credential, userId }])).ok).toBe(false);
  });
  it("redacts configuration exceptions", async () => {
    const result = await doctor(false, () => { throw new Error("secret-value"); });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
  it.each(["token; other=cookie", "token,other", "token\n", '"quoted"', "token with spaces"])("rejects malformed cookie values without a request", async sessionToken => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect((await doctor(true, () => [{ ...credential, sessionToken }])).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("checks reads with a timeout and no redirects without claiming user binding", async () => {
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ posts: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const report = await doctor(true, () => [credential]);
    expect(report).toMatchObject({ ok: true, publications: [{ authentication: "authenticated_read_succeeded", user_identity: "not_verified" }] });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
  });
  it.each([401, 403, 429, 500])("reports HTTP %s without echoing server content", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-error-secret", { status })));
    const report = await doctor(true, () => [credential]);
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private-error-secret");
  });
  it("does not accept a successful response with the wrong shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    expect((await doctor(true, () => [credential])).ok).toBe(false);
  });
});

describe("MCP publication isolation", () => {
  it("requires publication on every tool and routes both new reads without writes", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/drafts/42") ? draft : { posts: [], total: 0 })));
    vi.stubGlobal("fetch", fetchMock);
    const server = createServer(["a", "b"].map(key => ({ key, label: key, client: new SubstackClient(`https://${key}.substack.com`, "example-session-token", "1") })));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      for (const tool of (await client.listTools()).tools) expect(tool.inputSchema.required).toContain("publication");
      for (const [name, args] of [["search_posts", { query: "x" }], ["preflight_draft", { draft_id: 42 }]] as const) {
        expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
        expect((await client.callTool({ name, arguments: { ...args, publication: "unknown" } })).isError).toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      for (const [name, args] of [["search_posts", { query: "x" }], ["preflight_draft", { draft_id: 42 }]] as const) {
        const result = await client.callTool({ name, arguments: { ...args, publication: "b" } });
        expect(result.isError).toBeFalsy();
        expect(JSON.parse((result.content as { text: string }[])[0].text).publication).toBe("b");
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const call of fetchMock.mock.calls) expect(call[0]).toMatch(/^https:\/\/b\.substack\.com\//);
    } finally { await client.close(); await server.close(); }
  });
});
