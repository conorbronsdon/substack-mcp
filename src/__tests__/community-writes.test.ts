import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CommunityWrites, commentInput, restackInput, type CommunityOptions } from "../api/community-writes.js";
import { SubstackClient } from "../api/client.js";
import { createServer } from "../server.js";

const post = { post_id: 42, body: "A thoughtful comment", account_user_id: 7 };
const restack = { target_type: "note" as const, target_id: 84, account_user_id: 7 };
const live = { dry_run: false, confirm_publish: true };
const reader = { sessionToken: "example-reader-session", userId: "7" };
const comment = { id: 101, post_id: 42, user_id: 7, body: post.body };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function http(responder: (url: URL, options: RequestInit) => unknown = () => ({})) {
  const fetcher = vi.fn(async (url: string | URL | Request, options: RequestInit = {}) => {
    const value = await responder(new URL(String(url)), options);
    return value instanceof Response ? value : new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function connected(options: CommunityOptions = {}, multi = false) {
  const a = new SubstackClient("https://example-a.substack.com", "example-publication-a", "7");
  const b = new SubstackClient("https://example-b.org", "example-publication-b", "8");
  const server = createServer([{ key: "a", label: "A", client: a }, ...(multi ? [{ key: "b", label: "B", client: b }] : [])], { community: options });
  const client = new Client({ name: "example-community-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function data(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  return result.structuredContent as Record<string, any>;
}
const writeCount = (fetcher: ReturnType<typeof http>) => fetcher.mock.calls.filter(([, init]) => init?.method === "POST").length;

describe("community consent and previews", () => {
  it("previews both exact payloads without network or reader credentials", async () => {
    const fetcher = http(); const c = await connected();
    try {
      const p = data(await c.client.callTool({ name: "create_post_comment", arguments: post }));
      expect(p).toMatchObject({ status: "dry_run", write_attempts: 0, readback: "not_attempted", request: {
        url: "https://example-a.substack.com/api/v1/post/42/comment", payload: { body: post.body } } });
      const r = data(await c.client.callTool({ name: "restack", arguments: restack }));
      expect(r).toMatchObject({ status: "dry_run", request: { url: "https://substack.com/api/v1/restack/feed",
        payload: { postId: null, commentId: 84, tabId: "for-you", surface: "feed" } } });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await c.close(); }
  });
  it.each([{}, { confirm_publish: false }])("refuses a live call without per-call consent: %j", async consent => {
    const fetcher = http(); const c = await connected({ enabled: true, reader });
    try {
      for (const [name, args] of [["create_post_comment", post], ["restack", restack]] as const) {
        expect(data(await c.client.callTool({ name, arguments: { ...args, dry_run: false, ...consent } })))
          .toMatchObject({ status: "blocked", code: "consent_required", write_attempts: 0 });
      }
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await c.close(); }
  });
  it("does not carry consent from an earlier call", async () => {
    const fetcher = http(); const c = await connected({ enabled: true, reader });
    try {
      await c.client.callTool({ name: "restack", arguments: { ...restack, confirm_publish: true } });
      expect(data(await c.client.callTool({ name: "restack", arguments: { ...restack, dry_run: false } })).code).toBe("consent_required");
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await c.close(); }
  });
  it("requires an explicit server-side live gate for both tools", async () => {
    const fetcher = http(); const c = await connected({ reader });
    try {
      for (const [name, args] of [["create_post_comment", post], ["restack", restack]] as const) {
        expect(data(await c.client.callTool({ name, arguments: { ...args, ...live } })).code).toBe("community_writes_disabled");
      }
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await c.close(); }
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe IDs before any requests: %s", async id => {
    const fetcher = http(); const c = await connected({ enabled: true, reader });
    try {
      expect((await c.client.callTool({ name: "create_post_comment", arguments: { ...post, ...live, post_id: id } })).isError).toBe(true);
      expect((await c.client.callTool({ name: "restack", arguments: { ...restack, ...live, target_id: id } })).isError).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await c.close(); }
  });
  it("validates inputs at the TypeScript API boundary too", async () => {
    expect(commentInput.safeParse({ ...post, body: "  " }).success).toBe(false);
    expect(commentInput.safeParse({ ...post, body: "x".repeat(10_001) }).success).toBe(false);
    expect(restackInput.safeParse({ ...restack, target_type: "draft" }).success).toBe(false);
    const writer = new CommunityWrites({ enabled: true, reader });
    await expect(writer.restack({ ...restack, ...live, target_id: -1 })).rejects.toThrow();
  });
});

describe("credential routing and identity", () => {
  it("never falls back to publication credentials for a restack", async () => {
    const fetcher = http(); const c = await connected({ enabled: true });
    try {
      expect(data(await c.client.callTool({ name: "restack", arguments: { ...restack, ...live } })))
        .toMatchObject({ status: "blocked", code: "account_mismatch", write_attempts: 0 });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await c.close(); }
  });
  it("refuses a different requested reader identity before network access", async () => {
    const fetcher = http(); const c = await connected({ enabled: true, reader });
    try {
      expect(data(await c.client.callTool({ name: "restack", arguments: { ...restack, ...live, account_user_id: 8 } })).code).toBe("account_mismatch");
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await c.close(); }
  });
  it.each([{ id: 8 }, { name: "private-upstream-body" }, new Response("private-upstream-body", { status: 401 })])("checks authenticated identity before publishing: %j", async identity => {
    const fetcher = http(() => identity); const c = await connected({ enabled: true, reader });
    try {
      for (const [name, args] of [["create_post_comment", post], ["restack", restack]] as const) {
        const result = data(await c.client.callTool({ name, arguments: { ...args, ...live } }));
        expect(result).toMatchObject({ status: "blocked", code: "identity_unverified", write_attempts: 0 });
        expect(JSON.stringify(result)).not.toContain("private-upstream-body");
      }
      expect(writeCount(fetcher)).toBe(0);
    } finally { await c.close(); }
  });
  it("routes comments only to the selected publication and restacks only to the reader host", async () => {
    const fetcher = http((url, init) => {
      if (url.pathname.endsWith("/profile/self")) return { id: url.hostname === "example-b.org" ? 8 : 7 };
      if (url.pathname.endsWith("/comments")) return { comments: [{ ...comment, user_id: 8 }] };
      if (url.pathname.includes("/reader/feed/")) return { items: [{ context: { type: "restack", users: [{ id: 7 }] }, comment: { id: 84 } }] };
      if (init.method === "POST" && url.hostname === "example-b.org") return { ...comment, user_id: 8 };
      return {};
    });
    const c = await connected({ enabled: true, reader }, true);
    try {
      expect((await c.client.callTool({ name: "create_post_comment", arguments: { ...post, ...live } })).isError).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
      expect(data(await c.client.callTool({ name: "create_post_comment", arguments: { ...post, ...live, publication: "b", account_user_id: 8 } })).status).toBe("verified");
      expect(data(await c.client.callTool({ name: "restack", arguments: { ...restack, ...live } })).status).toBe("verified");
      const tools = (await c.client.listTools()).tools;
      expect(tools.find(t => t.name === "restack")!.inputSchema.properties).not.toHaveProperty("publication");
      for (const [address, init] of fetcher.mock.calls) {
        const url = new URL(String(address)), headers = new Headers(init?.headers);
        expect(init?.redirect).toBe("manual");
        if (url.hostname === "substack.com") expect(headers.get("cookie")).toBe("substack.sid=example-reader-session;");
        else {
          expect(url.origin).toBe("https://example-b.org");
          expect(headers.get("cookie")).toContain("example-publication-b");
          expect(headers.get("cookie")).not.toContain("example-reader-session");
        }
      }
    } finally { await c.close(); }
  });
  it.each(["example-reader-session\r\nX:bad", "example-other=1; example-extra=2", ""]) ("rejects malformed reader credentials without printing them", token => {
    expect(() => new CommunityWrites({ reader: { sessionToken: token, userId: "7" } })).toThrow("Invalid session token");
  });
});

describe("publication and readback", () => {
  it("posts exact plain text once, then verifies ID, author and body", async () => {
    const fetcher = http((url, init) => url.pathname.endsWith("/self") ? { id: 7 } : init.method === "POST" ? comment : { comments: [comment] });
    const c = await connected({ enabled: true });
    try {
      const result = data(await c.client.callTool({ name: "create_post_comment", arguments: { ...post, ...live } }));
      expect(result).toMatchObject({ status: "verified", comment_id: 101, write_attempts: 1, readback: "matched" });
      expect(fetcher).toHaveBeenCalledTimes(3); expect(writeCount(fetcher)).toBe(1);
      expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ body: post.body });
    } finally { await c.close(); }
  });
  it.each([{ ...comment, id: 102 }, { ...comment, user_id: 8 }, { ...comment, body: "different" }, { ...comment, post_id: 43 }, { ...comment, deleted: true }, { ...comment, status: "hidden" }])("does not verify a different comment: %j", async row => {
    const fetcher = http((url, init) => url.pathname.endsWith("/self") ? { id: 7 } : init.method === "POST" ? comment : { comments: [row] });
    const c = await connected({ enabled: true });
    try {
      expect(data(await c.client.callTool({ name: "create_post_comment", arguments: { ...post, ...live } })))
        .toMatchObject({ status: "unverified", readback: "unverified", write_attempts: 1, comment_id: 101 });
      expect(writeCount(fetcher)).toBe(1);
    } finally { await c.close(); }
  });
  it.each([{}, { ...comment, user_id: 8 }, { ...comment, body: "private-other-comment" }])("does not trust a malformed or mismatched comment acknowledgement: %j", async acknowledgement => {
    const fetcher = http(url => url.pathname.endsWith("/self") ? { id: 7 } : acknowledgement);
    const c = await connected({ enabled: true });
    try {
      const result = data(await c.client.callTool({ name: "create_post_comment", arguments: { ...post, ...live } }));
      expect(result).toMatchObject({ status: "unverified", code: "write_unverified", readback: "not_attempted", write_attempts: 1 });
      expect(result).not.toHaveProperty("comment_id");
      expect(JSON.stringify(result)).not.toContain("private-other-comment");
      expect(writeCount(fetcher)).toBe(1); expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { await c.close(); }
  });
  it.each(["post", "note"] as const)("uses the camelCase feed contract and verifies restack presence for %s", async target_type => {
    const fetcher = http(url => url.pathname.endsWith("/self") ? { id: 7 } : url.pathname.includes("/reader/feed/")
      ? { items: [{ context: { type: "restack", users: [{ id: 7 }] }, [target_type === "post" ? "post" : "comment"]: { id: 84 } }] } : {});
    const c = await connected({ enabled: true, reader });
    try {
      expect(data(await c.client.callTool({ name: "restack", arguments: { ...restack, ...live, target_type } }))).toMatchObject({ status: "verified", write_attempts: 1, readback: "matched" });
      expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ postId: target_type === "post" ? 84 : null,
        commentId: target_type === "note" ? 84 : null, tabId: "for-you", surface: "feed" });
      expect(writeCount(fetcher)).toBe(1);
    } finally { await c.close(); }
  });
  it.each(["post_restack", "comment_restack"])("recognizes observed feed context %s with exact actor attribution", async type => {
    const target_type = type === "post_restack" ? "post" : "note";
    const fetcher = http(url => url.pathname.endsWith("/self") ? { id: 7 } : url.pathname.includes("/reader/feed/")
      ? { items: [{ context: { type, users: [{ id: 7 }] }, [target_type === "post" ? "post" : "comment"]: { id: 84 } }] } : {});
    const c = await connected({ enabled: true, reader });
    try {
      expect(data(await c.client.callTool({ name: "restack", arguments: { ...restack, ...live, target_type } })).status).toBe("verified");
      expect(writeCount(fetcher)).toBe(1);
    } finally { await c.close(); }
  });
  it.each([
    { items: [] },
    { items: [{ context: { type: "comment_restack" }, comment: { id: 84 } }] },
    { items: [{ context: { type: "comment_restack", users: [{ id: 8 }] }, comment: { id: 84 } }] },
    { items: [{ context: { type: "post_restack", users: [{ id: 7 }] }, comment: { id: 84 } }] }, { items: [{ context: { type: "comment" }, comment: { id: 84 } }] },
    { items: [{ context: { type: "restack", users: [{ id: 7 }] }, comment: { id: 85 } }] },
    { items: [{ context: { type: "restack", users: [{ id: 7 }] }, post: { id: 5 }, comment: { id: 84 } }] },
    { items: [{ context: { type: "restack", users: [{ id: 7 }] }, post: { id: 84 } }] }, { private: "do-not-return" },
  ])("keeps absent, unrelated, and malformed restack readbacks unverified: %j", async feed => {
    const fetcher = http(url => url.pathname.endsWith("/self") ? { id: 7 } : url.pathname.includes("/reader/feed/") ? feed : {});
    const c = await connected({ enabled: true, reader });
    try {
      const result = data(await c.client.callTool({ name: "restack", arguments: { ...restack, ...live } }));
      expect(result).toMatchObject({ status: "unverified", readback: "unverified", write_attempts: 1 });
      expect(JSON.stringify(result)).not.toContain("do-not-return"); expect(writeCount(fetcher)).toBe(1);
    } finally { await c.close(); }
  });
  it.each([401, 403, 429, 500, 302])("never retries HTTP %s or redirects after an attempted publication", async status => {
    const fetcher = http(url => url.pathname.endsWith("/self") ? { id: 7 }
      : new Response("private-upstream-body example-reader-session", { status, headers: { Location: "https://other.example", "Retry-After": "60" } }));
    const c = await connected({ enabled: true, reader });
    try {
      for (const [name, args] of [["create_post_comment", post], ["restack", restack]] as const) {
        const result = data(await c.client.callTool({ name, arguments: { ...args, ...live } }));
        expect(result).toMatchObject({ status: "unverified", write_attempts: 1, code: "write_unverified" });
        expect(JSON.stringify(result)).not.toMatch(/private-upstream-body|example-reader-session/);
      }
      expect(writeCount(fetcher)).toBe(2); expect(fetcher).toHaveBeenCalledTimes(4);
      expect(fetcher.mock.calls.every(([url]) => !String(url).includes("other.example"))).toBe(true);
    } finally { await c.close(); }
  });
  it("keeps readback HTTP failure separate from publication failure", async () => {
    const fetcher = http((url, init) => url.pathname.endsWith("/self") ? { id: 7 } : init.method === "POST" ? comment : new Response("", { status: 500 }));
    const c = await connected({ enabled: true });
    try {
      expect(data(await c.client.callTool({ name: "create_post_comment", arguments: { ...post, ...live } })))
        .toMatchObject({ status: "unverified", comment_id: 101, code: "readback_unverified" });
      expect(writeCount(fetcher)).toBe(1);
    } finally { await c.close(); }
  });
  it("reports an ambiguous timeout without resending a restack", async () => {
    const fetcher = http((url) => url.pathname.endsWith("/self") ? { id: 7 } : new Promise(() => {}));
    const c = await connected({ enabled: true, reader, timeoutMs: 10 });
    try {
      expect(data(await c.client.callTool({ name: "restack", arguments: { ...restack, ...live } })))
        .toMatchObject({ status: "unverified", write_attempts: 1, code: "write_unverified" });
      expect(writeCount(fetcher)).toBe(1);
    } finally { await c.close(); }
  });
});
