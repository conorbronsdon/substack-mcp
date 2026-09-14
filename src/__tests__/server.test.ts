import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import {
  SubstackClient,
  MAX_PAGE_SIZE,
  ANALYTICS_SCAN_DEPTH,
} from "../api/client.js";

/**
 * Tool-layer regressions for #28.
 *
 * The clamp and the `describe` strings live in server.ts, so a client-only test
 * cannot reach them — and the description is the load-bearing half: it is what
 * tells a model that limit=100 is a legal argument. These drive the real
 * registered tools over an in-memory MCP transport and assert the limit VALUE
 * that reaches the wire.
 */
describe("tool pagination limits (regression: #28)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    const body = { posts: [], total: 0 };
    const fetchMock = vi.fn(async (..._args: any[]) => new Response(JSON.stringify(body)));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function connect() {
    const server = createServer([
      { key: "default", label: "Default", client: new SubstackClient("https://example.substack.com", "tok", "1") },
    ]);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    return client;
  }

  function limitOf(fetchMock: { mock: { calls: any[][] } }): number {
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    return Number(url.searchParams.get("limit"));
  }

  const paginatedTools = [
    "list_published_posts",
    "list_drafts",
    "list_scheduled_posts",
  ] as const;

  for (const name of paginatedTools) {
    it(`${name} clamps an over-cap limit instead of sending it`, async () => {
      const fetchMock = stubFetch();
      const client = await connect();

      // A caller (or a model reading the old "1-100" description) passing 100
      // must not error — it gets clamped, not rejected.
      const result = await client.callTool({
        name,
        arguments: { limit: 100 },
      });

      expect(result.isError).toBeFalsy();
      expect(limitOf(fetchMock)).toBe(MAX_PAGE_SIZE);
      expect(limitOf(fetchMock)).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    });

    it(`${name} passes an under-cap limit through unchanged`, async () => {
      const fetchMock = stubFetch();
      const client = await connect();

      await client.callTool({ name, arguments: { limit: 7 } });
      expect(limitOf(fetchMock)).toBe(7);
    });

    it(`${name} advertises the real cap, not 100`, async () => {
      const client = await connect();
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();

      const described = String(
        (tool!.inputSchema as any).properties?.limit?.description ?? "",
      );
      expect(described).toContain(`1-${MAX_PAGE_SIZE}`);
      expect(described).not.toContain("1-100");
    });
  }

  it("get_post_analytics derives its scan depth rather than restating 500", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_post_analytics");
    expect(tool?.description).toContain(
      `${ANALYTICS_SCAN_DEPTH} most recent published posts`,
    );
  });

  it("get_post_analytics says the whole feed was searched when the archive ends", async () => {
    stubFetch(); // empty feed: the id is never found
    const client = await connect();

    const result = await client.callTool({
      name: "get_post_analytics",
      arguments: { post_id: 12345 },
    });
    const payload = JSON.parse((result.content as any[])[0].text);
    expect(payload).toMatchObject({ found: false, post_id: 12345, search_result: "archive_exhausted", scanned: 0, feed_capped: null });
    expect(payload.note).toContain("all 0 published posts");
  });

  it("get_post_analytics distinguishes the scan bound from an exhausted archive", async () => {
    // Every page is full and carries isCapped, so the search stops at its bound.
    const fetchMock = vi.fn(async (url: any) => {
      const offset = Number(new URL(String(url)).searchParams.get("offset") ?? 0);
      const posts = Array.from({ length: MAX_PAGE_SIZE }, (_, i) => ({ id: offset + i + 1, title: "Post", stats: { views: 1 } }));
      return new Response(JSON.stringify({ posts, total: 10_000, isCapped: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();

    const missing = JSON.parse(((await client.callTool({ name: "get_post_analytics", arguments: { post_id: 9_999 } })).content as any[])[0].text);
    expect(missing).toMatchObject({ found: false, search_result: "scan_bound_reached", scanned: ANALYTICS_SCAN_DEPTH, feed_capped: true });
    expect(missing.note).toContain(`${ANALYTICS_SCAN_DEPTH} most recent published posts`);
    expect(missing.note).toContain("unknown here, not absent");
  });

  it("get_post_analytics marks a found post without statistics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ posts: [{ id: 7, title: "No stats" }, { id: 8, title: "Stats", stats: { views: 3 } }], total: 2 }))));
    const client = await connect();
    const noStats = JSON.parse(((await client.callTool({ name: "get_post_analytics", arguments: { post_id: 7 } })).content as any[])[0].text);
    expect(noStats).toMatchObject({ found: true, id: 7, stats_available: false, views: null });
    const withStats = JSON.parse(((await client.callTool({ name: "get_post_analytics", arguments: { post_id: 8 } })).content as any[])[0].text);
    expect(withStats).toMatchObject({ found: true, id: 8, stats_available: true, views: 3 });
  });
});
