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
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }));
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

  it("get_post_analytics reports the same depth in its not-found note", async () => {
    stubFetch(); // empty feed: the id is never found
    const client = await connect();

    const result = await client.callTool({
      name: "get_post_analytics",
      arguments: { post_id: 12345 },
    });
    const payload = JSON.parse((result.content as any[])[0].text);
    expect(payload.found).toBe(false);
    expect(payload.note).toContain(
      `${ANALYTICS_SCAN_DEPTH} most recent published posts`,
    );
  });
});
