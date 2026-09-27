import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { listIncomingRecommendations, listOutgoingRecommendations, listOutgoingRecommendationStats, RecommendationScopeError } from "../api/recommendations.js";
import { SubstackClient } from "../api/client.js";
import { createServer } from "../server.js";

afterEach(() => vi.unstubAllGlobals());

const PUB_ID = 1001;
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/recommendations-stats-to.json", import.meta.url), "utf8"));
const statsRow = (n: number, extra: Record<string, unknown> = {}) => ({ publication_id: 9000 + n, target_publication_id: PUB_ID, xp_signups: n, xp_paid_subs: 0, is_mutual: false, is_active: true,
  created_at: "2026-06-01T00:00:00.000Z", source_pub: { id: 9000 + n, name: `Example ${n}`, subdomain: `example-${n}`, custom_domain: null }, ...extra });
const outgoingFrom = { rows: [{ id: 5, recommending_publication_id: PUB_ID, recommended_publication_id: 9100, created_at: "2026-03-01T00:00:00.000Z", updated_at: "2026-03-02T00:00:00.000Z",
  description: "example-description", subscribe_auth_token: "example-private-subscribe-token", recommendedPublication: { id: 9100, name: "Example Recommended", subdomain: "example-recommended", custom_domain: null, email_from: "example-private@example.test" } }], total: 1 };
const statsFrom = { rows: [{ publication_id: PUB_ID, target_publication_id: 9100, xp_signups: 7, xp_paid_subs: 0, is_mutual: true, is_active: true, created_at: "2026-03-01T00:00:00.000Z",
  target_pub: { id: 9100, name: "Example Recommended", subdomain: "example-recommended", custom_domain: "example-recommended.test", email_from: "example-private@example.test" } }], total: 1 };

describe("recommendation projections", () => {
  it("projects incoming rows with direction, source and no private publication fields", async () => {
    const read = vi.fn(async () => fixture());
    const result = await listIncomingRecommendations({}, PUB_ID, read);
    expect(read).toHaveBeenCalledExactlyOnceWith("/api/v1/recommendations/stats/to?offset=0&limit=20&order_by=xp_signups&order_direction=desc");
    expect(result).toEqual({ direction: "incoming", source: "recommendations/stats/to", offset: 0, limit: 20, returned: 2, total: 2, has_more: false, next_offset: null, ended_before_total: false, recommendations: [
      { recommender: { id: 9001, name: "Example Recommender", subdomain: "example-recommender", custom_domain: "example-recommender.test" }, started_at: "2026-04-01T12:00:00.000Z", active: true, mutual: true, subscribers_attributed: 42, paid_subscribers_attributed: 1 },
      { recommender: { id: 9002, name: "Example Paused Recommender", subdomain: "example-paused", custom_domain: null }, started_at: "2026-05-01T12:00:00.000Z", active: false, mutual: false, subscribers_attributed: 0, paid_subscribers_attributed: 0 },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/example-private|author_id|blurb/);
  });

  it("keeps inactive rows and their historical attribution", async () => {
    const result = await listIncomingRecommendations({}, PUB_ID, async () => ({ rows: [statsRow(3, { is_active: false })], total: 1 }));
    expect(result.recommendations[0]).toMatchObject({ active: false, subscribers_attributed: 3 });
  });

  it("reports missing upstream fields as null, never zero or inactive", async () => {
    const row = { publication_id: 9005, target_publication_id: PUB_ID, xp_signups: null, is_active: null };
    const result = await listIncomingRecommendations({}, PUB_ID, async () => ({ rows: [row] }));
    expect(result.recommendations[0]).toEqual({ recommender: { id: 9005, name: null, subdomain: null, custom_domain: null }, started_at: null, active: null, mutual: null, subscribers_attributed: null, paid_subscribers_attributed: null });
    expect(result.total).toBeNull();
  });

  it.each([
    // [offset, limit, rows, total, has_more, next_offset, ended_before_total]
    [0, 2, 2, 3, true, 2, false],
    [2, 2, 1, 3, false, null, false],
    [0, 2, 2, 2, false, null, false],
    [4, 2, 0, 3, false, null, false],
    [0, 2, 0, 5, false, null, true],
    [0, 50, 2, 6, false, null, true],
    [0, 2, 2, undefined, true, 2, false],
    [2, 2, 1, undefined, false, null, false],
    [0, 2, 0, undefined, false, null, false],
  ])("paginates offset=%s limit=%s rows=%s total=%s", async (offset, limit, rows, total, has_more, next_offset, ended_before_total) => {
    const read = vi.fn(async (_path: string) => ({ rows: Array.from({ length: rows }, (_, i) => statsRow(offset + i)), ...(total === undefined ? {} : { total }) }));
    const result = limit > 20
      ? await listOutgoingRecommendations({ offset, limit }, PUB_ID, async () => ({ rows: Array.from({ length: rows }, (_, i) => ({ ...outgoingFrom.rows[0], recommended_publication_id: 9200 + i, recommendedPublication: undefined })), total }))
      : await listIncomingRecommendations({ offset, limit }, PUB_ID, read);
    if (limit <= 20) expect(read.mock.calls[0][0]).toContain(`offset=${offset}&limit=${limit}&`);
    expect(result).toMatchObject({ offset, limit, returned: rows, total: total ?? null, has_more, next_offset, ended_before_total });
  });

  it("walks every page and terminates", async () => {
    const all = Array.from({ length: 45 }, (_, i) => statsRow(i + 1));
    const read = async (path: string) => { const q = new URL(path, "https://example.test").searchParams; const o = Number(q.get("offset")), l = Number(q.get("limit")); return { rows: all.slice(o, o + l), total: all.length }; };
    const seen: number[] = []; let offset: number | null = 0, pages = 0;
    while (offset !== null && pages < 10) { const page = await listIncomingRecommendations({ offset }, PUB_ID, read); seen.push(...page.recommendations.map(r => r.recommender.id)); offset = page.next_offset; pages++; }
    expect(pages).toBe(3); expect(new Set(seen).size).toBe(45);
  });

  it.each([0, 21])("rejects limit %s before any read (Substack caps stats pages at 20)", async limit => {
    const read = vi.fn();
    await expect(listIncomingRecommendations({ limit }, PUB_ID, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["more rows than requested", { rows: [statsRow(1), statsRow(2)], total: 2 }, 1],
    ["string count", { rows: [statsRow(1, { xp_signups: "5" })], total: 1 }, 20],
    ["negative count", { rows: [statsRow(1, { xp_signups: -1 })], total: 1 }, 20],
    ["missing rows", { total: 1 }, 20],
  ])("rejects a malformed page: %s", async (_label, body, limit) => {
    await expect(listIncomingRecommendations({ limit }, PUB_ID, async () => body)).rejects.toMatchObject({ code: "malformed_json" });
  });

  it.each([
    ["target publication", statsRow(1, { target_publication_id: 4242 })],
    ["embedded recommender id", statsRow(1, { source_pub: { id: 4242, name: "Other", subdomain: "other" } })],
  ])("refuses rows scoped to another publication: %s", async (_label, row) => {
    await expect(listIncomingRecommendations({}, PUB_ID, async () => ({ rows: [row], total: 1 }))).rejects.toBeInstanceOf(RecommendationScopeError);
  });

  it("projects the outgoing list from /from/{id} without tokens or private fields", async () => {
    const read = vi.fn(async () => outgoingFrom);
    const result = await listOutgoingRecommendations({}, PUB_ID, read);
    expect(read).toHaveBeenCalledExactlyOnceWith(`/api/v1/recommendations/from/${PUB_ID}?offset=0&limit=50&paginate=true`);
    expect(result).toEqual({ direction: "outgoing", source: "recommendations/from", offset: 0, limit: 50, returned: 1, total: 1, has_more: false, next_offset: null, ended_before_total: false,
      recommendations: [{ recommended: { id: 9100, name: "Example Recommended", subdomain: "example-recommended", custom_domain: null }, started_at: "2026-03-01T00:00:00.000Z" }] });
    expect(JSON.stringify(result)).not.toMatch(/example-private|description/);
    await expect(listOutgoingRecommendations({}, PUB_ID, async () => ({ rows: [{ ...outgoingFrom.rows[0], recommending_publication_id: 4242 }], total: 1 }))).rejects.toBeInstanceOf(RecommendationScopeError);
  });

  it("projects outgoing impact from /stats/from", async () => {
    const read = vi.fn(async (_path: string) => statsFrom);
    const result = await listOutgoingRecommendationStats({}, PUB_ID, read);
    expect(read.mock.calls[0][0]).toBe("/api/v1/recommendations/stats/from?offset=0&limit=20&order_by=xp_signups&order_direction=desc");
    expect(result).toMatchObject({ direction: "outgoing", source: "recommendations/stats/from", recommendations: [{ recommended: { id: 9100, custom_domain: "example-recommended.test" }, active: true, mutual: true, subscribers_sent: 7, paid_subscribers_sent: 0 }] });
    expect(JSON.stringify(result)).not.toContain("example-private");
    await expect(listOutgoingRecommendationStats({}, PUB_ID, async () => ({ rows: [{ ...statsFrom.rows[0], publication_id: 4242 }], total: 1 }))).rejects.toBeInstanceOf(RecommendationScopeError);
  });
});

type Pub = { key: string; origin: string; id: number; subdomain: string; custom_domain: string | null };
const pubA: Pub = { key: "a", origin: "https://example-a.substack.com", id: 1001, subdomain: "example-a", custom_domain: null };
const pubB: Pub = { key: "b", origin: "https://news.example-b.test", id: 2002, subdomain: "example-b", custom_domain: "news.example-b.test" };

async function connected(pubs: Pub[]) {
  const server = createServer(pubs.map(p => ({ key: p.key, label: p.key, client: new SubstackClient(p.origin, `example-${p.key}-token`, "1") })));
  const client = new Client({ name: "example-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function upstream(pubs: Pub[], respond: (pub: Pub, path: string) => Response) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const u = new URL(url);
    const pub = pubs.find(p => new URL(p.origin).host === u.host)!;
    if (u.pathname === "/api/v1/publication") return Response.json({ id: pub.id, name: `Example ${pub.key}`, subdomain: pub.subdomain, custom_domain: pub.custom_domain });
    return respond(pub, u.pathname + u.search);
  });
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0].text);

describe("recommendation MCP tools", () => {
  it("declares read-only annotations and direction-explicit descriptions", async () => {
    const c = await connected([pubA]);
    try {
      const tools = (await c.client.listTools()).tools;
      for (const name of ["list_incoming_recommendations", "list_outgoing_recommendations", "list_outgoing_recommendation_stats"]) {
        const tool = tools.find(t => t.name === name)!;
        expect(tool.annotations).toEqual({ readOnlyHint: true }); expect(tool.outputSchema).toBeTruthy();
      }
      expect(tools.find(t => t.name === "list_outgoing_recommendations")!.description).toContain("who THIS publication recommends, NOT who recommends it");
      expect(tools.find(t => t.name === "list_incoming_recommendations")!.description).toMatch(/recommend THIS publication \(incoming\)/);
    } finally { await c.close(); }
  });

  it("reads the selected custom-domain publication only, with a dashboard referer", async () => {
    const pubs = [pubA, pubB];
    const fetchMock = upstream(pubs, (pub) => Response.json({ rows: [statsRow(1, { target_publication_id: pub.id })], total: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(pubs);
    try {
      expect((await c.client.callTool({ name: "list_incoming_recommendations", arguments: {} })).isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      const result = await c.client.callTool({ name: "list_incoming_recommendations", arguments: { publication: "b" } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ publication: "b", direction: "incoming", returned: 1 });
      expect(text(result)).toEqual(result.structuredContent);
      expect(fetchMock.mock.calls.map(([url]) => new URL(url).origin)).toEqual([pubB.origin, pubB.origin]);
      const [, init] = fetchMock.mock.calls[1];
      expect((init!.headers as Record<string, string>).Referer).toBe(`${pubB.origin}/publish/recommendations`);
    } finally { await c.close(); }
  });

  it("routes outgoing reads to /from/{selected publication id}", async () => {
    const pubs = [pubA, pubB];
    const fetchMock = upstream(pubs, (pub, path) => Response.json(path.startsWith("/api/v1/recommendations/from/")
      ? { rows: [{ ...outgoingFrom.rows[0], recommending_publication_id: pub.id }], total: 1 }
      : { rows: [{ ...statsFrom.rows[0], publication_id: pub.id }], total: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(pubs);
    try {
      const out = await c.client.callTool({ name: "list_outgoing_recommendations", arguments: { publication: "a" } });
      expect(out.structuredContent).toMatchObject({ publication: "a", direction: "outgoing", source: "recommendations/from" });
      expect(fetchMock.mock.calls[1][0]).toBe(`${pubA.origin}/api/v1/recommendations/from/${pubA.id}?offset=0&limit=50&paginate=true`);
      const stats = await c.client.callTool({ name: "list_outgoing_recommendation_stats", arguments: { publication: "a" } });
      expect(stats.structuredContent).toMatchObject({ publication: "a", direction: "outgoing", source: "recommendations/stats/from" });
      expect(fetchMock.mock.calls.every(([url]) => url.startsWith(pubA.origin))).toBe(true);
    } finally { await c.close(); }
  });

  it("refuses a page scoped to another publication without echoing it", async () => {
    vi.stubGlobal("fetch", upstream([pubA], () => Response.json({ rows: [statsRow(1, { target_publication_id: 4242, source_pub: { id: 9001, name: "example-private-name" } })], total: 1 })));
    const c = await connected([pubA]);
    try {
      const result = await c.client.callTool({ name: "list_incoming_recommendations", arguments: {} });
      expect(result.isError).toBe(true); expect(text(result)).toMatchObject({ code: "publication_mismatch" });
      expect(JSON.stringify(result)).not.toContain("example-private");
    } finally { await c.close(); }
  });

  it.each([
    [401, { code: "upstream_error", status: 401 }],
    [403, { code: "recommendations_unavailable", status: 403 }],
    [404, { code: "recommendations_unavailable", status: 404 }],
    [429, { code: "upstream_error", status: 429, retry_after: "30" }],
  ])("maps HTTP %s without echoing upstream detail", async (status, expected) => {
    vi.stubGlobal("fetch", upstream([pubA], () => new Response("example-private-detail", { status, headers: { "retry-after": "30" } })));
    const c = await connected([pubA]);
    try {
      for (const name of ["list_incoming_recommendations", "list_outgoing_recommendations", "list_outgoing_recommendation_stats"]) {
        const result = await c.client.callTool({ name, arguments: {} });
        expect(result.isError, name).toBe(true);
        expect(text(result)).toMatchObject(expected);
        expect(JSON.stringify(result)).not.toContain("example-private");
      }
    } finally { await c.close(); }
  });

  it("rejects a publication record for a different host before reading recommendations", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 1001, name: "Example", subdomain: "someone-else", custom_domain: null }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected([pubA]);
    try {
      expect((await c.client.callTool({ name: "list_incoming_recommendations", arguments: {} })).isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await c.close(); }
  });
});
