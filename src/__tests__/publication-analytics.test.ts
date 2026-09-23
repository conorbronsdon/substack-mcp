import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getGrowthSources, getPublicationStats } from "../api/publication-analytics.js";
import { SubstackClient } from "../api/client.js";
import { createServer } from "../server.js";

afterEach(() => vi.unstubAllGlobals());
const summary = { appSubscribers: 1, appSubscribersLast30Days: 2, subscribers: 3, subscribersLast30Days: 4, totalEmail: 5, totalEmailLast30Days: 6, views: 7, viewsDelta: 8, openRate: 42.5, openRateDiff: -1.2, pledgesAmount: 9, numPledges: 10, pledgeCurrency: "USD", isBestseller: false };
const range = { totalSubscribersStart: 1, totalSubscribersEnd: 2, paidSubscribersStart: 3, paidSubscribersEnd: 4, arrStart: 5, arrEnd: 6, totalViewsStart: 7, totalViewsEnd: 8, pledgedArrStart: 9, pledgedArrEnd: 10 };
const source = (children: unknown[] = []) => ({ source: "direct", sourceName: "Direct", originalSourceName: "Direct", category: "direct", metrics: [{ name: "example-new-metric", total: 4, timeseries: [{ date: "2026-09-01", value: 4 }] }], children });
const dates = { from_date: "2026-09-01", to_date: "2026-09-23" };

describe("publication analytics projections", () => {
  it("preserves reported units and distinct windows without deriving a count", async () => {
    const read = vi.fn(async path => path.endsWith("/summary") ? summary : range);
    const result = await getPublicationStats({}, read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.summary).toMatchObject({ status: "available", metrics: { openRate: { value: 42.5, unit: "percent_0_100", status: "reported", source: "publish-dashboard/summary", captured_at: expect.any(String) }, subscribersLast30Days: { window: "last 30 days" }, pledgesAmount: { currency: "USD" } } });
    expect(result.range).toMatchObject({ status: "available", metrics: { arrStart: { currency: "not_reported", value: 5 }, totalSubscribersEnd: { value: 2 } } });
  });
  it("rejects a string open rate without coercion and keeps a successful group", async () => {
    const result = await getPublicationStats({}, async path => path.endsWith("/summary") ? { ...summary, openRate: "42.5" } : range);
    expect(result.summary).toEqual({ status: "unavailable", reason: "malformed" });
    expect(result.range.status).toBe("available");
  });
  it("marks a failed range group unavailable, including a valid input rejected upstream", async () => {
    const result = await getPublicationStats({ range_days: 365 }, async path => { if (path.includes("summary-v2")) throw new Error("upstream rejection"); return summary; });
    expect(result.range).toEqual({ status: "unavailable", reason: "malformed" });
    expect(result.summary.status).toBe("available");
  });
  it("reports local limits and nested truncation, with optional events as a second read", async () => {
    const read = vi.fn(async path => path.includes("/events?") ? { pubEvents: [] } : { sourceMetrics: [{ ...source([source([source([source()])])]), href: "example-private-referral", logoUrl: "example-private-logo", pubId: "example-private-id" }, source()], totals: [{ name: "users", total: 4 }] });
    const result = await getGrowthSources({ ...dates, limit: 1, include_events: true }, read);
    expect(result).toMatchObject({ returned: 1, total_sources: 2, has_more: true, truncated: { depth: true, nodes: false, timeseries: false }, events: [] });
    expect(result.sources[0].metrics[0].name).toBe("example-new-metric");
    expect(JSON.stringify(result)).not.toContain("example-private");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("rejects reversed dates before fetching and rejects malformed upstream shapes", async () => {
    const read = vi.fn(async () => ({}));
    await expect(getGrowthSources({ from_date: dates.to_date, to_date: dates.from_date }, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    await expect(getGrowthSources(dates, read)).rejects.toThrow();
  });
  it("cuts timeseries at 400 points and marks the metric", async () => {
    const long = source(); long.metrics[0].timeseries = Array.from({ length: 401 }, (_, i) => ({ date: `2026-09-${String(i % 30 + 1).padStart(2, "0")}`, value: i }));
    const result = await getGrowthSources({ ...dates, include_timeseries: true }, async () => ({ sourceMetrics: [long], totals: [] }));
    expect(result.truncated.timeseries).toBe(true);
    expect(result.sources[0].metrics[0].timeseries).toHaveLength(400);
    expect(result.sources[0].metrics[0].timeseries_truncated).toBe(true);
  });
  it("processes at most 500 nodes and reports the cut", async () => {
    const result = await getGrowthSources(dates, async () => ({ sourceMetrics: [source(Array.from({ length: 501 }, () => source()))], totals: [] }));
    expect(result.truncated.nodes).toBe(true);
    expect(result.sources[0].children).toHaveLength(499);
  });
  it("rejects an oversized top-level source array without a partial projection", async () => {
    await expect(getGrowthSources(dates, async () => ({ sourceMetrics: Array.from({ length: 5001 }, () => source()), totals: [] }))).rejects.toThrow();
  });
});

async function connected(multi: boolean) {
  const keys = multi ? ["a", "b"] : ["b"];
  const server = createServer(keys.map(key => ({ key, label: key, client: new SubstackClient(`https://${key}.example`, `example-${key}-token`, "1") })));
  const client = new Client({ name: "example-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
describe("analytics MCP routing", () => {
  it.each([false, true])("publishes both schemas and routes to the selected publication (multi=%s)", async multi => {
    const fetchMock = vi.fn(async (url: string) => Response.json(url.endsWith("/summary") ? summary : url.includes("summary-v2") ? range : { sourceMetrics: [source()], totals: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(multi);
    try {
      const tools = (await c.client.listTools()).tools;
      for (const name of ["get_publication_stats", "get_growth_sources"]) {
        const tool = tools.find(t => t.name === name)!;
        expect(tool.outputSchema).toBeTruthy(); expect(tool.annotations).toEqual({ readOnlyHint: true });
      }
      const args = multi ? { publication: "b" } : {};
      if (multi) {
        expect((await c.client.callTool({ name: "get_publication_stats", arguments: {} })).isError).toBe(true);
        expect((await c.client.callTool({ name: "get_publication_stats", arguments: { publication: "wrong" } })).isError).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
      }
      const stats = await c.client.callTool({ name: "get_publication_stats", arguments: args });
      expect(stats.isError).toBeFalsy(); expect(stats.structuredContent).toMatchObject({ publication: "b", summary: { status: "available" } });
      expect(JSON.parse((stats.content as { text: string }[])[0].text)).toEqual(stats.structuredContent);
      const growth = await c.client.callTool({ name: "get_growth_sources", arguments: { ...args, ...dates } });
      expect(growth.isError).toBeFalsy(); expect(growth.structuredContent).toMatchObject({ publication: "b", returned: 1 });
      expect(fetchMock.mock.calls.every(([url]) => url.startsWith("https://b.example/"))).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { await c.close(); }
  });
  it("maps two 403s to analytics_unavailable and never echoes upstream detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "private-example-detail" }), { status: 403 })));
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_publication_stats", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ code: "analytics_unavailable", status: 403 });
      expect(JSON.stringify(result)).not.toContain("private-example-detail");
    } finally { await c.close(); }
  });
  it("maps growth HTTP 403 to analytics_unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("example-private", { status: 403 })));
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_growth_sources", arguments: dates });
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ code: "analytics_unavailable", status: 403 });
      expect(JSON.stringify(result)).not.toContain("example-private");
    } finally { await c.close(); }
  });
  it("propagates a 401 as an authentication failure even after a successful summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/summary") ? Response.json(summary) : new Response("example-private", { status: 401 })));
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_publication_stats", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ code: "upstream_error", status: 401 });
      expect(JSON.stringify(result)).not.toContain("example-private");
    } finally { await c.close(); }
  });
  it("marks an oversized summary body unavailable without returning partial data", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/summary")
      ? new Response("{}", { headers: { "content-length": String(11 * 1024 * 1024) } })
      : Response.json(range)));
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_publication_stats", arguments: {} });
      expect(result.structuredContent).toMatchObject({ summary: { status: "unavailable", reason: "malformed" }, range: { status: "available" } });
    } finally { await c.close(); }
  });
  it("gets one exact post without scanning the feed", async () => {
    const fetchMock = vi.fn(async () => Response.json({ posts: [{ id: 42, title: "Example", post_date: null, stats: { views: 5 } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_post_analytics", arguments: { post_id: 42 } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ id: 42, views: 5, source: "post_detail" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await c.close(); }
  });
  it.each([403, 404])("falls back to a readable feed after detail HTTP %s", async status => {
    const fetchMock = vi.fn(async (url: string) => url.includes("/detail/") ? new Response("example-hidden", { status }) : Response.json({ posts: [{ id: 42, title: "Example", stats: { views: 3 } }], total: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_post_analytics", arguments: { post_id: 42 } });
      expect(result.structuredContent).toMatchObject({ id: 42, views: 3, source: "published_feed_scan", detail_fallback_reason: status === 403 ? "forbidden" : "not_found" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await c.close(); }
  });
  it("rejects a reversed growth date range before any fetch through MCP", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_growth_sources", arguments: { from_date: dates.to_date, to_date: dates.from_date } });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await c.close(); }
  });
  it("uses exact post detail, then rejects an ID mismatch and falls back to the feed", async () => {
    const fetchMock = vi.fn(async (url: string) => Response.json(url.includes("/detail/") ? { posts: [{ id: 7, title: "Wrong", stats: { views: 90 } }] } : { posts: [{ id: 42, title: "Right", post_date: null, stats: { views: 5 } }], total: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_post_analytics", arguments: { post_id: 42 } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ found: true, id: 42, views: 5, source: "published_feed_scan", detail_fallback_reason: "id_mismatch" });
      expect(JSON.stringify(result)).not.toContain("Wrong");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await c.close(); }
  });
});
