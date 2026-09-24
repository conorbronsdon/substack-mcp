import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getGrowthSources, getPublicationStats, growthSourcesInput } from "../api/publication-analytics.js";
import { SubstackClient } from "../api/client.js";
import { createServer } from "../server.js";
import { ResponseError, SubstackAPIError, TimeoutError } from "../utils/errors.js";

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
  it("accepts null currency and bestseller without losing the summary", async () => {
    const result = await getPublicationStats({}, async path => path.endsWith("/summary") ? { ...summary, pledgeCurrency: null, isBestseller: null } : range);
    expect(result.summary).toMatchObject({ status: "available", is_bestseller: null, metrics: { pledgesAmount: { currency: "not_reported" } } });
  });
  it.each([
    [new ResponseError("example-endpoint", "response_too_large"), "response_too_large"],
    [new ResponseError("example-endpoint", "redirect_rejected"), "redirect_rejected"],
    [new ResponseError("example-endpoint", "unexpected_html"), "unexpected_html"],
    [new ResponseError("example-endpoint", "malformed_json"), "malformed"],
    [new TimeoutError("example-endpoint", 100), "timeout"],
    [new SubstackAPIError(403, "example", "example-endpoint"), "http_403"],
  ])("classifies a failed group as %s", async (error, expected) => {
    const result = await getPublicationStats({}, async path => { if (path.includes("summary-v2")) throw error; return summary; });
    expect(result.range).toEqual({ status: "unavailable", reason: expected });
    expect(result.summary.status).toBe("available");
  });
  it.each([new ResponseError("example-endpoint", "request_cancelled"), new Error("example-code-bug")])("rethrows cancellation and code errors", async error => {
    await expect(getPublicationStats({}, async path => { if (path.includes("summary-v2")) throw error; return summary; })).rejects.toBe(error);
  });
  it("reports local limits and nested truncation, with optional events as a second read", async () => {
    const read = vi.fn(async path => path.includes("/events?") ? { pubEvents: [] } : { sourceMetrics: [{ ...source([source([source([source()])])]), href: "example-private-referral", logoUrl: "example-private-logo", pubId: "example-private-id" }, source()], totals: [{ name: "users", total: 4 }] });
    const result = await getGrowthSources({ ...dates, limit: 1, include_events: true }, read);
    expect(result).toMatchObject({ returned: 1, total_sources: 2, has_more: true, truncated: { depth: true, nodes: false, timeseries: false }, events: { status: "available", items: [] } });
    expect(result.sources[0].metrics[0].name).toBe("example-new-metric");
    expect(JSON.stringify(result)).not.toContain("example-private");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("projects populated events, capping long Note text used as the title", async () => {
    // Live-shaped: Note events carry the Note body as `title` (785 characters observed) and omit slug/url.
    const events = [
      { id: 1, date: "2026-09-20T12:00:00.000Z", title: "x".repeat(785), type: "note" },
      { id: 2, date: "2026-09-21T12:00:00.000Z", title: "Example post", slug: "example-post", type: "text", url: "https://example.test/p/example-post" },
    ];
    const result = await getGrowthSources({ ...dates, include_events: true }, async path => path.includes("/events?") ? { pubEvents: events } : { sourceMetrics: [source()], totals: [] });
    expect(result.events).toMatchObject({ status: "available" });
    const items = result.events?.status === "available" ? result.events.items : [];
    expect(items.map(item => [item.title.length, item.title_truncated, item.slug, item.url])).toEqual([[300, true, null, null], [12, false, "example-post", "https://example.test/p/example-post"]]);
  });
  it.each([
    [new SubstackAPIError(403, "example", "example-events"), "http_403"],
    [new SubstackAPIError(404, "example", "example-events"), "http_404"],
    [new SubstackAPIError(429, "example", "example-events"), "http_429"],
    [new SubstackAPIError(500, "example", "example-events"), "http_5xx"],
    [{ pubEvents: "invalid" }, "malformed"],
  ])("preserves sources when optional events fail: %s", async (failure, expected) => {
    const result = await getGrowthSources({ ...dates, include_events: true }, async path => {
      if (!path.includes("/events?")) return { sourceMetrics: [source()], totals: [] };
      if (failure instanceof Error) throw failure;
      return failure;
    });
    expect(result).toMatchObject({ returned: 1, events: { status: "unavailable", reason: expected } });
  });
  it("propagates authentication failure from optional events", async () => {
    await expect(getGrowthSources({ ...dates, include_events: true }, async path => {
      if (path.includes("/events?")) throw new SubstackAPIError(401, "example", "example-events");
      return { sourceMetrics: [source()], totals: [] };
    })).rejects.toMatchObject({ statusCode: 401 });
  });
  it("accepts 366 inclusive days and tomorrow UTC, but rejects the next day and 367 days", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-23T23:59:59Z"));
    expect(growthSourcesInput.safeParse({ from_date: "2025-09-24", to_date: "2026-09-24" }).success).toBe(true);
    expect(growthSourcesInput.safeParse({ from_date: "2025-09-23", to_date: "2026-09-24" }).success).toBe(false);
    expect(growthSourcesInput.safeParse({ from_date: "2026-09-24", to_date: "2026-09-24" }).success).toBe(true);
    expect(growthSourcesInput.safeParse({ from_date: "2026-09-25", to_date: "2026-09-25" }).success).toBe(false);
    vi.restoreAllMocks();
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
  it.each([false, true])("keeps growth sources through MCP when optional events are available=%s", async available => {
    const fetchMock = vi.fn(async (url: string) => url.includes("/events?")
      ? available ? Response.json({ pubEvents: [] }) : new Response("example-private", { status: 403 })
      : Response.json({ sourceMetrics: [source()], totals: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_growth_sources", arguments: { ...dates, include_events: true } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ returned: 1, events: available ? { status: "available", items: [] } : { status: "unavailable", reason: "http_403" } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
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
      expect(result.structuredContent).toMatchObject({ summary: { status: "unavailable", reason: "response_too_large" }, range: { status: "available" } });
    } finally { await c.close(); }
  });
  it("gets one exact post without scanning the feed", async () => {
    const fetchMock = vi.fn(async () => Response.json({ posts: [{ id: 42, title: "Example", is_published: true, post_date: "2026-09-01T00:00:00Z", stats: { views: 5 } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_post_analytics", arguments: { post_id: 42 } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ id: 42, views: 5, source: "post_detail" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await c.close(); }
  });
  it.each([
    [false, null],
    [false, "2026-09-01T00:00:00Z"],
    [true, null],
    [true, ""],
  ])("falls back for unpublished detail (is_published=%s, post_date=%s)", async (is_published, post_date) => {
    const fetchMock = vi.fn(async (url: string) => Response.json(url.includes("/detail/")
      ? { posts: [{ id: 42, title: "Example draft", is_published, post_date, stats: { views: 99 } }] }
      : { posts: [], total: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_post_analytics", arguments: { post_id: 42 } });
      expect(result.structuredContent).toMatchObject({ found: false, source: "published_feed_scan", detail_fallback_reason: "not_published" });
      expect(JSON.stringify(result)).not.toContain("Example draft");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await c.close(); }
  });
  it("accepts published detail with null statistics", async () => {
    const fetchMock = vi.fn(async () => Response.json({ posts: [{ id: 42, is_published: true, post_date: "2026-09-01T00:00:00Z", stats: null }] }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_post_analytics", arguments: { post_id: 42 } });
      expect(result.structuredContent).toMatchObject({ found: true, source: "post_detail", stats_available: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await c.close(); }
  });
  it.each([500, 400, 410])("falls back after detail HTTP %s", async status => {
    const fetchMock = vi.fn(async (url: string) => url.includes("/detail/") ? new Response("example-upstream", { status }) : Response.json({ posts: [{ id: 42, stats: { views: 3 } }], total: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_post_analytics", arguments: { post_id: 42 } });
      expect(result.structuredContent).toMatchObject({ found: true, source: "published_feed_scan", detail_fallback_reason: "upstream_error" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await c.close(); }
  });
  it("falls back after a detail timeout", async () => {
    const fetchMock = vi.fn(async (url: string) => { if (url.includes("/detail/")) throw new TimeoutError("example-detail", 100); return Response.json({ posts: [], total: 0 }); });
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_post_analytics", arguments: { post_id: 42 } });
      expect(result.structuredContent).toMatchObject({ found: false, source: "published_feed_scan", detail_fallback_reason: "upstream_error" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await c.close(); }
  });
  it.each([401, 429])("propagates detail HTTP %s without scanning", async status => {
    const fetchMock = vi.fn(async () => new Response("example-upstream", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(false);
    try {
      const result = await c.client.callTool({ name: "get_post_analytics", arguments: { post_id: 42 } });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ status });
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
