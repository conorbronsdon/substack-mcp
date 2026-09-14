import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rankPosts, rankPostsOutput, RANK_ROW_METRICS } from "../api/rankings.js";
import { SubstackClient } from "../api/client.js";
import { createServer } from "../server.js";

// Synthetic rows shaped like the observed email_stats response.
const row = (post_id: number, extra: Record<string, unknown> = {}) => ({
  post_id, title: `Post ${post_id}`, post_date: "2026-09-01T12:00:00.000Z", type: "newsletter",
  views: 100, sent: 50, delivered: 49, opened: 20, open_rate: 0.4, clicked: 5, click_through_rate: 0.1,
  signups: 2, subscribes: 1, unsubscribes: 0, estimated_value: 12.5, likes: 3, comments: 1, restacks: 0,
  bylines: "private-byline", tags: "private-tag", section_name: "private-section", ...extra,
});
const withoutMetrics = (post_id: number) => ({ post_id, title: `Post ${post_id}`, post_date: null, type: "newsletter" });
afterEach(() => vi.unstubAllGlobals());

describe("rankPosts", () => {
  it("builds one bounded read with validated sort parameters and projects documented fields only", async () => {
    const read = vi.fn(async () => ({ rows: [row(1), row(2, { views: 90 })], total: 5 }));
    const result = await rankPosts({ metric: "views", direction: "desc", limit: 2, offset: 0 }, read);
    expect(read).toHaveBeenCalledExactlyOnceWith("/api/v1/publication/stats/email_stats?order_by=views&order_direction=desc&limit=2&offset=0");
    expect(result).toMatchObject({ source: "publication_email_stats", metric: "views", total: 5, returned: 2, has_more: true, next_offset: 2, ordering: "server", unreported_in_page: 0 });
    expect(result.rows[0]).toMatchObject({ rank: 1, post_id: 1, value: 100, value_state: "reported", absent_metrics: [] });
    expect(Object.keys(result.rows[0].metrics)).toEqual([...RANK_ROW_METRICS]);
    expect(JSON.stringify(result)).not.toMatch(/private-(byline|tag|section)/);
    expect(rankPostsOutput.omit({ publication: true }).safeParse(result).success).toBe(true);
  });

  it("uses defaults of views, descending, 10 rows from offset 0", async () => {
    const read = vi.fn(async () => ({ rows: [], total: 0 }));
    expect(await rankPosts({}, read)).toMatchObject({ metric: "views", direction: "desc", limit: 10, offset: 0, returned: 0, has_more: false, next_offset: null });
    expect(read).toHaveBeenCalledWith("/api/v1/publication/stats/email_stats?order_by=views&order_direction=desc&limit=10&offset=0");
  });

  it("preserves server order and distinguishes null, absent and zero without filling values", async () => {
    const rows = [row(1, { open_rate: 0.5 }), row(2, { open_rate: null }), row(3, { open_rate: 0 }), withoutMetrics(4), row(5, { open_rate: 0.7 })];
    const result = await rankPosts({ metric: "open_rate", direction: "desc", limit: 5 }, async () => ({ rows, total: 5 }));
    expect(result.rows.map(r => [r.post_id, r.value, r.value_state])).toEqual([[1, 0.5, "reported"], [2, null, "null"], [3, 0, "reported"], [4, null, "absent"], [5, 0.7, "reported"]]);
    expect(result.rows.map(r => r.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(result.unreported_in_page).toBe(2);
    expect(result.rows[3].absent_metrics).toEqual([...RANK_ROW_METRICS]);
    expect(result.rows[1].absent_metrics).toEqual([]);
    expect(result.semantics).toMatch(/null rates among numeric rows/);
    expect(result.semantics).toMatch(/Neither is zero/);
  });

  it("reports post_date rankings from the date field and continuation honestly", async () => {
    const result = await rankPosts({ metric: "post_date", direction: "asc", limit: 2, offset: 18 }, async () => ({ rows: [row(7), withoutMetrics(8)], total: 20 }));
    expect(result.rows.map(r => [r.rank, r.value, r.value_state])).toEqual([[19, "2026-09-01T12:00:00.000Z", "reported"], [20, null, "null"]]);
    expect(result).toMatchObject({ has_more: false, next_offset: null });
    // Observed live: the page at offset == total is empty.
    expect(await rankPosts({ offset: 20 }, async () => ({ rows: [], total: 20 }))).toMatchObject({ returned: 0, has_more: false, next_offset: null });
    expect(await rankPosts({ offset: 40 }, async () => ({ rows: [], total: 20 }))).toMatchObject({ returned: 0, has_more: false, next_offset: null });
  });

  it.each([
    ["empty page before the end", { offset: 10, limit: 10 }, { rows: [], total: 20 }],
    ["short page before the end", { offset: 0, limit: 10 }, { rows: [row(1), row(2)], total: 20 }],
    ["rows past total", { offset: 19, limit: 5 }, { rows: [row(1), row(2)], total: 20 }],
  ])("rejects a page that contradicts total instead of reporting exhaustion: %s", async (_name, input, response) => {
    await expect(rankPosts(input, async () => response)).rejects.toThrow(/no ranking can be verified/);
  });

  it.each([{ limit: 21 }, { limit: 0 }, { offset: -1 }, { limit: 1.5 }, { metric: "not_a_field" }, { metric: "likes" }, { direction: "sideways" },
    { section_id: 42 }, { order_by: "views" }, { metric: "views", filter: "paid" }])(
    "rejects unverified or out-of-range input before any request: %j", async input => {
      const read = vi.fn();
      await expect(rankPosts(input as never, read)).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    });

  it.each([
    ["non-object", null],
    ["rows missing", { total: 1 }],
    ["total missing", { rows: [] }],
    ["negative total", { rows: [], total: -1 }],
    ["more rows than requested", { rows: [row(1), row(2), row(3)], total: 3 }],
    ["missing post_id", { rows: [{ title: "x" }], total: 1 }],
    ["string metric", { rows: [row(1, { views: "100" })], total: 1 }],
    ["non-finite metric", { rows: [row(1, { opened: Number.POSITIVE_INFINITY })], total: 1 }],
    ["duplicate post", { rows: [row(1), row(1)], total: 2 }],
    ["oversized title", { rows: [row(1, { title: "x".repeat(10_001) })], total: 1 }],
    ["unparseable post_date", { rows: [row(1, { post_date: "not-a-date" })], total: 1 }],
    ["oversized post_date", { rows: [row(1, { post_date: "2026-09-01T12:00:00.000Z".padEnd(65, "Z") })], total: 1 }],
  ])("rejects malformed responses without partial results: %s", async (_name, response) => {
    await expect(rankPosts({ limit: 2 }, async () => response)).rejects.toThrow(/no ranking can be verified/);
  });
});

describe("rank_posts through MCP", () => {
  it.each([1, 2])("publishes a read-only contract and routes to the selected publication with %s configured", async count => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => Response.json({ rows: [row(11), row(12, { views: 40 })], total: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const server = createServer((count === 1 ? ["b"] : ["a", "b"]).map(key => ({ key, label: key, client: new SubstackClient(`https://${key}.substack.com`, "fixture", "1") })));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const tool = (await client.listTools()).tools.find(t => t.name === "rank_posts")!;
      expect(tool.annotations).toEqual({ readOnlyHint: true });
      expect(tool.outputSchema?.required).toContain("rows");
      expect(tool.description).toMatch(/not recompute|20/);
      if (count === 2) {
        expect(tool.inputSchema.required).toContain("publication");
        expect((await client.callTool({ name: "rank_posts", arguments: {} })).isError).toBe(true);
      }
      const result = await client.callTool({ name: "rank_posts", arguments: { metric: "subscribes", limit: 2, ...(count === 2 ? { publication: "b" } : {}) } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ publication: "b", metric: "subscribes", returned: 2, total: 2 });
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(result.structuredContent);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("https://b.substack.com/api/v1/publication/stats/email_stats?order_by=subscribes&order_direction=desc&limit=2&offset=0");
      expect(options?.method ?? "GET").toBe("GET");
      expect((await client.callTool({ name: "rank_posts", arguments: { limit: 21, ...(count === 2 ? { publication: "b" } : {}) } })).isError).toBe(true);
      // An unsupported filter is rejected, not dropped into an unfiltered ranking.
      expect((await client.callTool({ name: "rank_posts", arguments: { section_id: 42, ...(count === 2 ? { publication: "b" } : {}) } })).isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });

  it.each([403, 404])("reports HTTP %s from statistics as analytics_unavailable, not an empty ranking", async status => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "private-upstream-detail" }), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const server = createServer([{ key: "b", label: "b", client: new SubstackClient("https://b.substack.com", "fixture", "1") }]);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const result = await client.callTool({ name: "rank_posts", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ code: "analytics_unavailable", status });
      expect(JSON.stringify(result)).not.toContain("private-upstream-detail");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });

  it("surfaces rate limiting and malformed upstream data as typed read failures without retrying", async () => {
    const responses = [
      new Response(JSON.stringify({ error: "slow down" }), { status: 429, headers: { "retry-after": "30", "content-type": "application/json" } }),
      Response.json({ rows: [{ post_id: "private-id-value" }], total: 1 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const server = createServer([{ key: "b", label: "b", client: new SubstackClient("https://b.substack.com", "fixture", "1") }]);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const limited = await client.callTool({ name: "rank_posts", arguments: {} });
      expect(limited.isError).toBe(true);
      expect(JSON.parse((limited.content as { text: string }[])[0].text)).toMatchObject({ status: 429, retry_after: "30" });
      const malformed = await client.callTool({ name: "rank_posts", arguments: {} });
      expect(malformed.isError).toBe(true);
      expect(JSON.stringify(malformed)).not.toContain("private-id-value");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await client.close(); await server.close(); }
  });
});
