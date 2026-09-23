import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { SubstackClient } from "../api/client.js";

const firstOrigin = "https://example-first.substack.com";
const secondOrigin = "https://example-second.substack.com";
const c = (id: number, extra = {}) => ({ id, body: "Body", ancestor_path: "", date: "2026-09-23", children_count: 0,
  reaction_count: 0, restacks: 0, ...extra });
const p = (id: number) => ({ id, title: "Public post", subtitle: null, slug: "post", post_date: "2026-09-23",
  audience: "everyone", canonical_url: `${firstOrigin}/p/post`, wordcount: 12, reaction_count: 1, comment_count: 0, restacks: 0 });
const profile = { id: 7, name: "Example", handle: "example_reader", bio: "Bio", photo_url: null,
  publicationUsers: [{ role: "admin", is_primary: true, publication: { id: 9, name: "Example", subdomain: "example-first", custom_domain: null } }] };
type Route = (url: URL) => { status?: number; data: unknown; headers?: Record<string, string> };
function mockPublicFetch(route: Route) {
  const calls: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect([...headers.keys()]).toEqual(["accept", "user-agent"]);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    expect(init?.credentials).toBe("omit");
    const url = new URL(String(input));
    calls.push(url);
    const response = route(url);
    return new Response(JSON.stringify(response.data), { status: response.status ?? 200,
      headers: { "content-type": "application/json", ...response.headers } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}
async function connected(multi = false) {
  const server = createServer([{ key: "first", label: "First", client: new SubstackClient(firstOrigin, "example-first-token", "1") },
    ...(multi ? [{ key: "second", label: "Second", client: new SubstackClient(secondOrigin, "example-second-token", "2") }] : [])]);
  const client = new Client({ name: "public-reader-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function output(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  const value = result.structuredContent;
  expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(value);
  return value as Record<string, any>;
}
function errorCode(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).toBe(true);
  return JSON.parse((result.content as { text: string }[])[0].text).code;
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("anonymous public reader tools", () => {
  it("projects profile and resolves a handle for one upstream-controlled feed page", async () => {
    const { calls } = mockPublicFetch(url => url.pathname.includes("public_profile") ? { data: profile } : {
      data: { items: [{ entity_key: "note:42", type: "comment", context: { type: "comment", timestamp: "2026-09-23" },
        comment: c(42, { body: "x".repeat(4001) }), post: null, publication: null }], nextCursor: "next page", originalCursorTimestamp: "2026-09-23" } });
    const s = await connected();
    try {
      expect(output(await s.client.callTool({ name: "get_user_profile", arguments: { handle: "example_reader" } })).primary_publication.id).toBe(9);
      const feed = output(await s.client.callTool({ name: "get_profile_feed", arguments: { handle: "example_reader", cursor: "start page" } }));
      expect(feed.returned).toBe(1); expect(feed.has_more).toBe(true); expect(feed.next_cursor).toBe("next page");
      expect(feed.items[0].note.body_text).toHaveLength(4000); expect(feed.items[0].note.body_truncated).toBe(true);
      expect(calls).toHaveLength(3);
      expect(calls.at(-1)?.search).toBe("?cursor=start%20page");
    } finally { await s.close(); }
  });
  it("keeps thread structure, markers and continuation with two reads", async () => {
    const { calls } = mockPublicFetch(url => url.pathname.endsWith("/replies") ? { data: {
      rootComment: c(42, { deleted: true, status: "hidden" }), commentBranches: [{ comment: c(43, { ancestor_path: "42", deleted: true, status: "hidden" }),
        descendantComments: [c(44, { ancestor_path: "42/43" })] }], moreBranches: 1, nextCursor: "more" } } :
      { data: { item: { entity_key: "note:42", type: "comment", context: { type: "comment", timestamp: "2026-09-23" }, comment: c(42), parentComments: [c(40)] } } });
    const s = await connected();
    try {
      const result = output(await s.client.callTool({ name: "get_note_thread", arguments: { comment_id: 42, cursor: "page 2" } }));
      expect(result.root).toMatchObject({ id: 42, deleted: true, status: "hidden" }); expect(result.ancestors).toHaveLength(1);
      expect(result.ancestors[0]).toMatchObject({ parent_id: null, parent_status: "not_derived" });
      expect(result.branches[0].reply).toMatchObject({ id: 43, parent_id: 42, deleted: true, status: "hidden" });
      expect(result.branches[0].descendants[0].parent_id).toBe(43);
      expect(result.completeness).toBe("more_available"); expect(result.next_cursor).toBe("more");
      expect(calls).toHaveLength(2); expect(calls[1].search).toBe("?cursor=page%202");
    } finally { await s.close(); }
  });
  it("marks a thread page truncated when the local 100-comment cap bites", async () => {
    mockPublicFetch(url => url.pathname.endsWith("/replies") ?
      { data: { rootComment: c(42), commentBranches: [], moreBranches: 0, nextCursor: null } } :
      { data: { item: { entity_key: "note:42", type: "comment", context: { type: "comment", timestamp: "2026-09-23" },
        comment: c(42), parentComments: Array.from({ length: 101 }, (_, i) => c(i + 100)) } } });
    const s = await connected();
    try {
      const result = output(await s.client.callTool({ name: "get_note_thread", arguments: { comment_id: 42 } }));
      expect(result.ancestors).toHaveLength(99);
      expect(result).toMatchObject({ truncated: true, completeness: "more_available" });
    } finally { await s.close(); }
  });
  it("routes default archive origin by publication and reports full-page uncertainty", async () => {
    const { calls } = mockPublicFetch(() => ({ data: [p(1), p(2)] }));
    const s = await connected(true);
    try {
      expect((await s.client.callTool({ name: "list_public_posts", arguments: {} })).isError).toBe(true);
      expect((await s.client.callTool({ name: "list_public_posts", arguments: { publication: "wrong" } })).isError).toBe(true);
      expect(calls).toHaveLength(0);
      const result = output(await s.client.callTool({ name: "list_public_posts", arguments: { publication: "second", limit: 2, offset: 4 } }));
      expect(calls[0].origin).toBe(secondOrigin); expect(result.publication_url).toBe(secondOrigin);
      expect(result).toMatchObject({ returned: 2, next_offset: 6, has_more: null });
    } finally { await s.close(); }
  });
  it("accepts only configured exact extra HTTPS origins", async () => {
    vi.stubEnv("SUBSTACK_PUBLIC_READ_ORIGINS", "https://example-extra.test");
    const { calls } = mockPublicFetch(() => ({ data: [] }));
    const s = await connected();
    try {
      expect(output(await s.client.callTool({ name: "list_public_posts", arguments: { publication_url: "https://example-extra.test" } })).returned).toBe(0);
      expect(calls[0].origin).toBe("https://example-extra.test");
      expect(errorCode(await s.client.callTool({ name: "list_public_posts", arguments: { publication_url: "https://other-extra.test" } }))).toBe("host_not_allowed");
    } finally { await s.close(); }
  });
  it("classifies public post bodies conservatively and 404s as not_found", async () => {
    mockPublicFetch(url => url.pathname.endsWith("missing") ? { status: 404, data: {} } :
      { data: { ...p(1), audience: "paid", body_html: "Preview" } });
    const s = await connected();
    try {
      const result = output(await s.client.callTool({ name: "get_public_post", arguments: { url: `${firstOrigin}/p/post` } }));
      expect(result).toMatchObject({ body_status: "paywalled_or_truncated", body_html: "Preview", body_truncated: false });
      expect(errorCode(await s.client.callTool({ name: "get_public_post", arguments: { url: `${firstOrigin}/p/missing` } }))).toBe("not_found");
      expect(errorCode(await s.client.callTool({ name: "get_note_thread", arguments: { comment_id: 42 } }))).toBe("invalid_upstream_response");
    } finally { await s.close(); }
  });
  it("maps missing public comments to not_found", async () => {
    mockPublicFetch(() => ({ status: 404, data: {} }));
    const s = await connected();
    try { expect(errorCode(await s.client.callTool({ name: "get_note_thread", arguments: { comment_id: 42 } }))).toBe("not_found"); }
    finally { await s.close(); }
  });
  it("caps the returned post body and keeps the public-body heuristic explicit", async () => {
    mockPublicFetch(url => ({ data: { ...p(1), body_html: url.pathname.endsWith("unicode") ? "é".repeat(300_000) : "x".repeat(500_001) } }));
    const s = await connected();
    try {
      const result = output(await s.client.callTool({ name: "get_public_post", arguments: { url: `${firstOrigin}/p/post` } }));
      expect(result.body_html).toHaveLength(500_000);
      expect(result).toMatchObject({ body_truncated: true, body_status: "full_public" });
      const unicode = output(await s.client.callTool({ name: "get_public_post", arguments: { url: `${firstOrigin}/p/unicode` } }));
      expect(unicode.body_html).toHaveLength(250_000);
      expect(Buffer.byteLength(unicode.body_html, "utf8")).toBe(500_000);
    } finally { await s.close(); }
  });
  it("does not turn a feed missing continuation metadata into a complete page", async () => {
    mockPublicFetch(() => ({ data: { items: [] } }));
    const s = await connected();
    try { expect(errorCode(await s.client.callTool({ name: "get_profile_feed", arguments: { user_id: 7 } }))).toBe("invalid_upstream_response"); }
    finally { await s.close(); }
  });
  it("does not follow a public JSON redirect", async () => {
    const { calls } = mockPublicFetch(() => ({ status: 302, data: {}, headers: { location: "https://evil.com/steal" } }));
    const s = await connected();
    try {
      expect(errorCode(await s.client.callTool({ name: "get_user_profile", arguments: { handle: "example_reader" } }))).toBe("redirect_rejected");
      expect(calls).toHaveLength(1);
    } finally { await s.close(); }
  });
  it("rejects disallowed URLs and invalid arguments before fetch", async () => {
    const { fetchMock } = mockPublicFetch(() => ({ data: [] }));
    const s = await connected();
    try {
      const origins = ["http://x.substack.com", "https://evil.com", "https://substack.com.evil.com",
        "https://a.b.substack.com", "https://127.0.0.1", "https://user:pass@x.substack.com", "https://x.substack.com:444", "https://x.substack.com\n"];
      for (const publication_url of origins) expect(errorCode(await s.client.callTool({ name: "list_public_posts", arguments: { publication_url } }))).toBe("host_not_allowed");
      for (const url of origins.map(o => `${o}/p/post`)) expect(errorCode(await s.client.callTool({ name: "get_public_post", arguments: { url } }))).toBe("host_not_allowed");
      for (const args of [{}, { user_id: 1, handle: "example_reader" }, { user_id: 1, cursor: "bad\nvalue" }])
        expect((await s.client.callTool({ name: "get_profile_feed", arguments: args })).isError).toBe(true);
      expect((await s.client.callTool({ name: "get_note_thread", arguments: { comment_id: 1, cursor: "bad\nvalue" } })).isError).toBe(true);
      expect((await s.client.callTool({ name: "list_public_posts", arguments: { limit: 51 } })).isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it("fails closed on malformed branches and oversized upstream JSON", async () => {
    mockPublicFetch(url => url.pathname.endsWith("/replies") ? { data: { rootComment: c(42),
      commentBranches: [{ comment: { body: "missing id" }, descendantComments: [] }], moreBranches: 0, nextCursor: null } } :
      { data: { item: { entity_key: "note:42", type: "comment", context: { type: "comment", timestamp: "2026-09-23" }, comment: c(42), parentComments: [] } } });
    const s = await connected();
    try { expect(errorCode(await s.client.callTool({ name: "get_note_thread", arguments: { comment_id: 42 } }))).toBe("invalid_upstream_response"); }
    finally { await s.close(); }
    vi.unstubAllGlobals();
    mockPublicFetch(() => ({ data: { ...profile, bio: "x".repeat(3_000_000) } }));
    const t = await connected();
    try { expect(errorCode(await t.client.callTool({ name: "get_user_profile", arguments: { handle: "example_reader" } }))).toBe("response_too_large"); }
    finally { await t.close(); }
  });
});
