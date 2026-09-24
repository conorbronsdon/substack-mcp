import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { SubstackClient } from "../api/client.js";

const row = {
  user_email_address: "example-reader@example.org", subscription_id: 42, subscription_interval: "free",
  activity_rating: 3, subscription_created_at: "2026-09-01T00:00:00Z", total_revenue_generated: 0,
  is_comp: false, is_founding: false, is_gift: false, is_free_trial: false,
  user_name: "private name", user_photo_url: "https://example.org/private.jpg", user_id: 999,
};
const page = { count: 1, subscribers: [row], order: { by: "subscription_created_at", direction: "desc" } };

async function connected(multi = false) {
  const pubs = ["one", ...(multi ? ["two"] : [])].map(key => ({ key, label: key,
    client: new SubstackClient(`https://${key}.substack.com`, "example-session", "1") }));
  const server = createServer(pubs), client = new Client({ name: "example-search-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const data = (reply: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((reply.content as Array<{ text: string }>)[0].text);
afterEach(() => vi.unstubAllGlobals());

describe("search_subscribers", () => {
  it("returns a minimal projection and preserves the legacy list request and result", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(page)));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected();
    try {
      const reply = await c.client.callTool({ name: "search_subscribers", arguments: {} });
      expect(reply.isError).toBeFalsy();
      expect(data(reply)).toEqual(reply.structuredContent);
      expect(data(reply)).toMatchObject({ total_matching: 1, returned: 1, offset: 0, limit: 10, has_more: false, next_offset: null,
        applied_filters: { order_by_desc_nulls_last: "subscription_created_at" }, sort: "created_desc",
        subscribers: [{ user_email_address: row.user_email_address, subscription_id: 42, subscription_interval: "free" }] });
      expect(Object.keys(data(reply).subscribers[0]).sort()).toEqual(["subscription_id", "subscription_interval", "user_email_address"]);
      expect(JSON.stringify(reply)).not.toMatch(/private name|private\.jpg|user_id|chartCounts/);
      const legacy = await c.client.callTool({ name: "list_subscribers", arguments: {} });
      expect(data(legacy)).toEqual({ count: 1, subscribers: [{ user_email_address: row.user_email_address, subscription_id: 42, subscription_interval: "free" }] });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ filters: { order_by_desc_nulls_last: "subscription_created_at" }, limit: 10, offset: 0 });
    } finally { await c.close(); }
  });

  it("sends verified filters and returns only requested groups with honest continuation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...page, count: 3 })));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected();
    try {
      const reply = await c.client.callTool({ name: "search_subscribers", arguments: {
        subscription_types: ["paid", "comp"], activity_rating_min: 2, activity_rating_max: 4,
        created_on_or_after: "2026-08-01", created_on_or_before: "2026-09-30", search: " reader ", sort: "activity_asc", limit: 1,
        include: ["activity_rating", "created_at", "flags", "revenue"],
      } });
      expect(reply.isError).toBeFalsy();
      expect(data(reply)).toMatchObject({ returned: 1, total_matching: 3, has_more: true, next_offset: 1,
        subscribers: [{ activity_rating: 3, created_at: row.subscription_created_at, revenue: 0, is_comp: false }] });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ filters: {
        order_by: "activity_rating", subscription_type_in: ["paid", "comp"], activity_rating_gte: 2, activity_rating_lte: 4,
        subscription_created_at_gte: "2026-08-01", subscription_created_at_is_on_or_before: "2026-09-30", search: "reader",
      }, limit: 1, offset: 0 });
    } finally { await c.close(); }
  });

  it("continues at the returned offset without repeating rows", async () => {
    const next = { ...row, user_email_address: "example-next@example.org", subscription_id: 43 };
    const fetchMock = vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
      const { offset } = JSON.parse(options.body as string) as { offset: number };
      return new Response(JSON.stringify({ count: 2, subscribers: [offset === 0 ? row : next] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected();
    try {
      const first = data(await c.client.callTool({ name: "search_subscribers", arguments: { limit: 1 } }));
      const second = data(await c.client.callTool({ name: "search_subscribers", arguments: { limit: 1, offset: first.next_offset } }));
      expect(first).toMatchObject({ returned: 1, has_more: true, next_offset: 1 });
      expect(second).toMatchObject({ returned: 1, offset: 1, has_more: false, next_offset: null });
      expect(second.subscribers[0].subscription_id).not.toBe(first.subscribers[0].subscription_id);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await c.close(); }
  });

  it("rejects invalid input before fetch", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const c = await connected();
    try {
      for (const args of [{ sort: "unknown" }, { subscription_types: ["unknown"] }, { activity_rating_min: 4, activity_rating_max: 2 },
        { created_on_or_after: "2026-09-02", created_on_or_before: "2026-09-01" }, { limit: 51 }, { subscription_types: ["free", "free"] }]) {
        expect((await c.client.callTool({ name: "search_subscribers", arguments: args })).isError).toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await c.close(); }
  });

  it("maps upstream 400 to filter_rejected with one request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "private filter detail", type: "BadRequest" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected();
    try {
      const reply = await c.client.callTool({ name: "search_subscribers", arguments: { subscription_types: ["free"] } });
      expect(data(reply).code).toBe("filter_rejected"); expect(reply.isError).toBe(true);
      expect(JSON.stringify(reply)).not.toContain("private filter detail"); expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await c.close(); }
  });

  it("rejects contradictory rows and malformed or oversized responses", async () => {
    for (const [body, args, code] of [
      [{ ...page, subscribers: [{ ...row, activity_rating: 1 }] }, { activity_rating_min: 2 }, "filter_not_honored"],
      [{ ...page, subscribers: [{ ...row, is_comp: false }] }, { subscription_types: ["comp"] }, "filter_not_honored"],
      [{ ...page, subscribers: [{ ...row, activity_rating: null }] }, {}, "invalid_subscriber_response"],
      [{ ...page, subscribers: Array.from({ length: 51 }, () => row) }, {}, "invalid_subscriber_response"],
    ] as const) {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
      vi.stubGlobal("fetch", fetchMock);
      const c = await connected();
      try { const reply = await c.client.callTool({ name: "search_subscribers", arguments: args });
        expect(reply.isError).toBe(true); expect(data(reply).code).toBe(code); expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(reply)).not.toContain("private name");
      } finally { await c.close(); vi.unstubAllGlobals(); }
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { headers: { "content-length": String(11 * 1024 * 1024) } }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected();
    try { const reply = await c.client.callTool({ name: "search_subscribers", arguments: {} });
      expect(reply.isError).toBe(true); expect(data(reply).code).toBe("response_too_large"); expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await c.close(); }
  });

  it("routes only to a selected publication", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify({ count: 1,
      subscribers: [{ ...row, user_email_address: url.includes("two.substack.com") ? "example-two@example.org" : "example-one@example.org" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const c = await connected(true);
    try {
      for (const publication of [undefined, "wrong"]) expect((await c.client.callTool({ name: "search_subscribers", arguments: { publication } })).isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      const reply = await c.client.callTool({ name: "search_subscribers", arguments: { publication: "two" } });
      expect(reply.isError).toBeFalsy(); expect(fetchMock.mock.calls[0][0]).toBe("https://two.substack.com/api/v1/subscriber-stats");
      expect(data(reply).subscribers[0].user_email_address).toBe("example-two@example.org");
      expect(JSON.stringify(reply)).not.toContain("example-one@example.org");
      expect(JSON.stringify(reply)).not.toContain("example-session");
    } finally { await c.close(); }
  });
});
