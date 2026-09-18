import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SubstackClient } from "../api/client.js";
import { createServer } from "../server.js";

const post = {
  id: 42, title: "Published article", subtitle: null, slug: "published-article",
  post_date: "2026-09-18T12:00:00Z", audience: "everyone", type: "newsletter",
  body_html: "<p>Full article body.</p>", wordcount: 4,
  canonical_url: "https://example.substack.com/p/published-article",
};
const envelope = { post, publication: { id: 7, subdomain: "example" }, publicationSettings: { unrelated: true } };
function mockRead(value: unknown = envelope, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(value), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe("published post lookup (#125)", () => {
  it.each(["https://example.substack.com", "https://newsletter.example.com"])("uses the numeric-ID route and unwraps the post on %s", async origin => {
    const read = mockRead();
    const result = await new SubstackClient(origin, "synthetic-token", "1").getPost(42);
    expect(result).toMatchObject({ id: 42, title: post.title, body_html: post.body_html, word_count: 4 });
    expect(result).not.toHaveProperty("publicationSettings");
    expect(result).not.toHaveProperty("post");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(`${origin}/api/v1/posts/by-id/42`, expect.objectContaining({
      redirect: "manual", headers: expect.objectContaining({ Cookie: "connect.sid=synthetic-token; substack.sid=synthetic-token;" }),
    }));
  });
  it("preserves an existing word_count, including zero", async () => {
    mockRead({ post: { ...post, word_count: 0 } });
    expect((await new SubstackClient("https://example.substack.com", "synthetic-token", "1").getPost(42)).word_count).toBe(0);
  });
  it.each([null, {}, { post: null }, { post: { ...post, id: 43 } }])("rejects missing or mismatched post data: %j", async value => {
    mockRead(value);
    await expect(new SubstackClient("https://example.substack.com", "synthetic-token", "1").getPost(42)).rejects.toThrow("Unexpected published post response");
  });
  it.each([401, 403, 404, 429, 500])("preserves HTTP %i without retries or fallback scans", async status => {
    const read = mockRead({ error: "Synthetic upstream error" }, status);
    await expect(new SubstackClient("https://example.substack.com", "synthetic-token", "1").getPost(42)).rejects.toMatchObject({ statusCode: status });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("returns the established text and structured MCP output (multi=%s)", async multi => {
    const read = mockRead();
    const pubs = [{ key: "first", label: "First", client: new SubstackClient("https://first.example", "synthetic-token", "1") },
      ...(multi ? [{ key: "second", label: "Second", client: new SubstackClient("https://second.example", "synthetic-token", "2") }] : [])];
    const server = createServer(pubs), client = new Client({ name: "post-regression", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const result = await client.callTool({ name: "get_post", arguments: { post_id: 42, ...(multi ? { publication: "second" } : {}) } });
      expect(result.isError).not.toBe(true);
      const expected = { id: 42, title: post.title, subtitle: null, slug: post.slug, post_date: post.post_date,
        audience: "everyone", word_count: 4, body_html: post.body_html, url: post.canonical_url };
      expect(result.structuredContent).toEqual(expected);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(expected);
      expect(read).toHaveBeenCalledWith(`https://${multi ? "second" : "first"}.example/api/v1/posts/by-id/42`, expect.anything());
    } finally { await client.close(); await server.close(); }
  });
});
