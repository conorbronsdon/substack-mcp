import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { listPublicationTags, getPostTags } from "../api/tags.js";
import { SubstackClient } from "../api/client.js";
import { createServer } from "../server.js";

const context = async () => ({ data: { id: 7 } });
const tag = (id: string, hidden = false) => ({ id, publication_id: 7, name: `Name ${id}`, slug: id, hidden });
const link = (id: string) => ({ id: `link-${id}`, publication_id: 7, post_id: 42, post_tag_id: id });
afterEach(() => vi.unstubAllGlobals());

describe("publication tags", () => {
  it("filters hidden rows before pagination and projects only supported fields", async () => {
    const read = vi.fn(async () => [tag("a", true), { ...tag("b"), private_field: "excluded" }, tag("c")]);
    const result = await listPublicationTags({ include_hidden: false, limit: 1 }, context, read);
    expect(read).toHaveBeenCalledExactlyOnceWith("/api/v1/publication/post-tag");
    expect(result).toMatchObject({ publication_id: 7, total: 2, returned: 1, has_more: true, next_offset: 1, tags: [tag("b")] });
    expect(JSON.stringify(result)).not.toContain("excluded");
    expect(await listPublicationTags({ include_hidden: false, offset: 1, limit: 1 }, context, read)).toMatchObject({ tags: [tag("c")], has_more: false, next_offset: null });
  });
  it("includes hidden tags by default and reports out-of-range/empty pages honestly", async () => {
    expect(await listPublicationTags({}, context, async () => [tag("a", true)])).toMatchObject({ include_hidden: true, tags: [tag("a", true)], total: 1 });
    expect(await listPublicationTags({ offset: 9 }, context, async () => [tag("a")])).toMatchObject({ total: 1, returned: 0, has_more: false, next_offset: null });
    expect(await listPublicationTags({}, context, async () => [])).toMatchObject({ total: 0, tags: [], has_more: false });
  });
  it.each([{ limit: 101 }, { offset: -1 }, { offset: Number.MAX_SAFE_INTEGER }, { limit: 1.1 }])("rejects invalid input before any request", async input => {
    const ctx = vi.fn(context), read = vi.fn();
    await expect(listPublicationTags(input, ctx, read)).rejects.toThrow();
    expect(ctx).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it.each([null, {}, [null], [{ ...tag("a"), hidden: "false" }], [{ ...tag("a"), id: 5 }],
    [{ ...tag("a"), publication_id: 8 }], [tag("a"), tag("a")], Array.from({ length: 10001 }, (_, i) => tag(String(i)))].map(response => ({ response })))("rejects malformed, duplicate, oversized and wrong-publication arrays", async ({ response }) => {
    await expect(listPublicationTags({}, context, async () => response)).rejects.toThrow(/tag|publication/i);
  });
  it("does not fetch tags after failed publication verification", async () => {
    const read = vi.fn();
    await expect(listPublicationTags({}, async () => { throw new Error("host mismatch"); }, read)).rejects.toThrow("host mismatch");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("post tags", () => {
  it("resolves hidden definitions and retains unresolved IDs without inventing names", async () => {
    const read = vi.fn(async (path: string) => path.includes("/post/42/") ? [link("a"), link("missing")] : [tag("a", true)]);
    expect(await getPostTags({ post_id: 42 }, context, read)).toMatchObject({
      post_id: 42, publication_id: 7, total: 2, returned: 2,
      post_identity: "association_rows_match_requested_id",
      tags: [{ tag_id: "a", resolved: true, tag: tag("a", true) }, { tag_id: "missing", resolved: false, tag: null }],
    });
    expect(read.mock.calls.map(([path]) => path)).toEqual(["/api/v1/post/42/tag", "/api/v1/publication/post-tag"]);
  });
  it("paginates associations while retaining unresolved rows in totals", async () => {
    const result = await getPostTags({ post_id: 42, offset: 1, limit: 1 }, context,
      async path => path.includes("/post/42/") ? [link("a"), link("b"), link("c")] : [tag("a")]);
    expect(result).toMatchObject({ total: 3, returned: 1, next_offset: 2, has_more: true, tags: [{ tag_id: "b", resolved: false, tag: null }] });
  });
  it("does not claim an empty association response verifies post identity", async () => {
    const read = vi.fn(async () => []);
    expect(await getPostTags({ post_id: 42 }, context, read)).toMatchObject({ tags: [], total: 0, post_identity: "not_verified_empty_associations" });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each([-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe post IDs before reads: %s", async post_id => {
    const ctx = vi.fn(context), read = vi.fn();
    await expect(getPostTags({ post_id }, ctx, read)).rejects.toThrow();
    expect(ctx).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...link("a"), post_id: 43 }], [{ ...link("a"), publication_id: 8 }],
    [link("a"), link("a")], [link("a"), { ...link("a"), id: "different-link" }], [{}],
  ].map(associations => ({ associations })))("rejects wrong identity or duplicate associations before resolving definitions", async ({ associations }) => {
    const read = vi.fn(async () => associations);
    await expect(getPostTags({ post_id: 42 }, context, read)).rejects.toThrow(/tag|publication/i);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("validates definition publication even when association IDs were valid", async () => {
    await expect(getPostTags({ post_id: 42 }, context, async path => path.includes("/post/42/") ? [link("a")] : [{ ...tag("a"), publication_id: 8 }])).rejects.toThrow(/different publication/);
  });
  it("propagates definition read failure instead of converting failure into unresolved IDs", async () => {
    await expect(getPostTags({ post_id: 42 }, context, async path => {
      if (path.includes("/post/42/")) return [link("a")];
      throw new Error("upstream unavailable");
    })).rejects.toThrow("upstream unavailable");
  });
});

describe("tag MCP routing", () => {
  it.each([1, 2])("publishes output contracts and routes reads with %s configured publications", async count => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => new Response(JSON.stringify(
      url.endsWith("/api/v1/publication") ? { id: 7, name: "Sample", subdomain: "b" } :
        url.includes("/post/42/") ? [link("a")] : [tag("a")])));
    vi.stubGlobal("fetch", fetchMock);
    const server = createServer((count === 1 ? ["b"] : ["a", "b"]).map(key => ({ key, label: key, client: new SubstackClient(`https://${key}.substack.com`, "fixture", "1") })));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      for (const name of ["list_publication_tags", "get_post_tags"]) {
        const tool = (await client.listTools()).tools.find(t => t.name === name)!;
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.outputSchema?.required).toContain("tags");
        const args = name === "get_post_tags" ? { post_id: 42 } : {};
        if (count === 2) {
          expect(tool.inputSchema.required).toContain("publication");
          expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
          expect((await client.callTool({ name, arguments: { ...args, publication: "unknown" } })).isError).toBe(true);
        } else expect(tool.inputSchema.properties).not.toHaveProperty("publication");
        const before = fetchMock.mock.calls.length;
        const result = await client.callTool({ name, arguments: { ...args, ...(count === 2 ? { publication: "b" } : {}) } });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ publication: "b", total: 1, returned: 1 });
        expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(result.structuredContent);
        expect(fetchMock.mock.calls.length - before).toBe(name === "get_post_tags" ? 3 : 2);
      }
      for (const [url, options] of fetchMock.mock.calls) {
        expect(url).toMatch(/^https:\/\/b\.substack\.com\//);
        expect(options?.method ?? "GET").toBe("GET");
      }
      expect(fetchMock).toHaveBeenCalledTimes(5);
    } finally { await client.close(); await server.close(); }
  });
});
