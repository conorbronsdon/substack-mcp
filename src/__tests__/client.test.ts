import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SubstackClient,
  parseMagnitude,
  MAX_PAGE_SIZE,
  ANALYTICS_MAX_PAGES,
  ANALYTICS_SCAN_DEPTH,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../api/client.js";
import {
  AuthenticationError,
  RateLimitError,
  ValidationError,
  NotFoundError,
  ServerError,
  SubstackAPIError,
  TimeoutError,
} from "../utils/errors.js";

describe("SubstackClient constructor", () => {
  it("parses valid numeric userId without throwing", () => {
    expect(
      () => new SubstackClient("https://example.substack.com", "tok123", "42")
    ).not.toThrow();
  });

  it("throws with clear message for invalid userId", () => {
    expect(
      () => new SubstackClient("https://example.substack.com", "tok123", "abc")
    ).toThrow('Invalid SUBSTACK_USER_ID: use a positive safe integer containing only digits.');
  });

  it("strips trailing slash from publication URL", () => {
    // Access the private field via any cast to verify behavior
    const client = new SubstackClient(
      "https://example.substack.com/",
      "tok",
      "1"
    ) as any;
    expect(client.publicationUrl).toBe("https://example.substack.com");
  });

  it("sets cookie string with both connect.sid and substack.sid", () => {
    const client = new SubstackClient(
      "https://example.substack.com",
      "mytoken",
      "1"
    ) as any;
    expect(client.cookie).toContain("connect.sid=mytoken");
    expect(client.cookie).toContain("substack.sid=mytoken");
  });
});

describe("SubstackClient requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(jsonBody: unknown) {
    const fetchMock = vi.fn(async (..._args: any[]) => new Response(JSON.stringify(jsonBody)));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("getDrafts uses post_management/drafts with ordering and unwraps posts[]", async () => {
    const fetchMock = stubFetch({ posts: [{ id: 7, draft_title: "hi" }], total: 1 });
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    const drafts = await client.getDrafts(0, 5);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].id).toBe(7);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/v1/post_management/drafts");
    expect(calledUrl).toContain("order_by=draft_updated_at");
    expect(calledUrl).toContain("order_direction=desc");
    expect(calledUrl).not.toContain("/api/v1/drafts?");
  });

  it("getSections matches the publication by hostname and returns its sections", async () => {
    const fetchMock = stubFetch({
      publications: [
        { hostname: "other.substack.com", sections: [{ id: 1, name: "Other" }] },
        {
          hostname: "example.substack.com",
          sections: [
            { id: 10, name: "Essays" },
            { id: 11, name: "Notes" },
          ],
        },
      ],
    });
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    const sections = await client.getSections();

    expect(sections).toHaveLength(2);
    expect(sections[0]).toEqual({ id: 10, name: "Essays" });
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v1/subscriptions");
  });

  it("getSections matches on custom_domain when hostname does not match", async () => {
    const fetchMock = stubFetch({
      publications: [
        {
          hostname: "example.substack.com",
          custom_domain: "newsletter.example.com",
          sections: [{ id: 7, name: "Custom" }],
        },
      ],
    });
    const client = new SubstackClient("https://newsletter.example.com", "tok", "1");
    const sections = await client.getSections();
    expect(sections).toEqual([{ id: 7, name: "Custom" }]);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v1/subscriptions");
  });

  it("getSections does not substring-match an unrelated publication host", async () => {
    // `ample.substack.com` is a substring of `example.substack.com`; exact-host
    // matching must skip it and return the real publication's sections.
    stubFetch({
      publications: [
        { hostname: "ample.substack.com", sections: [{ id: 1, name: "Wrong" }] },
        { hostname: "example.substack.com", sections: [{ id: 2, name: "Right" }] },
      ],
    });
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    const sections = await client.getSections();
    expect(sections).toEqual([{ id: 2, name: "Right" }]);
  });

  it("getSections returns [] when no publication matches", async () => {
    stubFetch({ publications: [{ hostname: "nope.substack.com", sections: [{ id: 1, name: "X" }] }] });
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    expect(await client.getSections()).toEqual([]);
  });

  it("getScheduledPosts uses the scheduled view ordered by trigger_at asc", async () => {
    const fetchMock = stubFetch({
      posts: [{ id: 5, draft_title: "Queued", audience: "everyone", trigger_at: "2030-01-01T00:00:00Z" }],
    });
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    const posts = await client.getScheduledPosts(0, 10);

    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe(5);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/post_management/scheduled");
    expect(url).toContain("order_by=trigger_at");
    expect(url).toContain("order_direction=asc");
  });

  it("getPostAnalytics finds a post's stats row in the published feed", async () => {
    const fetchMock = stubFetch({
      posts: [
        { id: 100, title: "A", stats: { views: 1 } },
        { id: 200, title: "B", stats: { views: 42, opened: 10 } },
      ],
      total: 2,
    });
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    const post = await client.getPostAnalytics(200);

    expect(post?.id).toBe(200);
    expect(post?.stats?.views).toBe(42);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v1/post_management/published");
  });

  it("getPostAnalytics returns null and stops paging when the feed is exhausted", async () => {
    const fetchMock = stubFetch({ posts: [{ id: 1, title: "only" }], total: 1 });
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    const post = await client.getPostAnalytics(999);

    expect(post).toBeNull();
    // A short page (1 < MAX_PAGE_SIZE) means end-of-feed: exactly one request,
    // no over-paging.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a browser User-Agent and a Referer by default", async () => {
    const fetchMock = stubFetch({ posts: [] });
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    await client.getDrafts();

    const opts = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers["User-Agent"]).toContain("Mozilla/5.0");
    expect(opts.headers["Referer"]).toBe("https://example.substack.com/publish/home");
  });

  it("honors a custom User-Agent override", async () => {
    const fetchMock = stubFetch({ posts: [] });
    const client = new SubstackClient("https://example.substack.com", "tok", "1", "MyUA/1.0");
    await client.getDrafts();

    const opts = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers["User-Agent"]).toBe("MyUA/1.0");
  });

  it("omits Content-Type on a bodyless GET", async () => {
    const fetchMock = stubFetch({ posts: [] });
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    await client.getDrafts();

    const opts = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers["Content-Type"]).toBeUndefined();
  });

  it("sends Content-Type on a request with a body", async () => {
    const fetchMock = stubFetch({ id: 1, draft_title: "hi" });
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    await client.createDraft("hi");

    const opts = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });
});

describe("pagination limit cap (regression: #28)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Substack 400s on limit=51 and above, so every request this client issues on
  // its own initiative must carry a limit VALUE within the cap. The pre-fix
  // suite passed with limit=100 on the wire because it only asserted that the
  // URL *contained* the endpoint path — a shape assertion cannot see a bad
  // value. These read the query params back off the URLs the client actually
  // built.
  function paramValues(
    fetchMock: { mock: { calls: any[][] } },
    name: string,
  ): number[] {
    return fetchMock.mock.calls
      .map((call) => new URL(String(call[0])).searchParams.get(name))
      .filter((v): v is string => v !== null)
      .map(Number);
  }

  /**
   * A published feed that honors offset/limit, so paging behavior follows the
   * page size the client asks for rather than a fixture hardcoded around one.
   */
  function stubPagedFeed(totalPosts: number) {
    const fetchMock = vi.fn(async (url: any) => {
      const params = new URL(String(url)).searchParams;
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit") ?? 0);
      const count = Math.max(0, Math.min(limit, totalPosts - offset));
      const body = {
        posts: Array.from({ length: count }, (_, i) => ({
          id: offset + i + 1,
          title: `Post ${offset + i + 1}`,
          stats: { views: 1 },
        })),
        total: totalPosts,
      };
      return new Response(JSON.stringify(body));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("MAX_PAGE_SIZE is within Substack's observed 50 cap", () => {
    // limit=50 → 200, limit=51 → 400 "Invalid value" (probed 2026-08-02).
    expect(MAX_PAGE_SIZE).toBeLessThanOrEqual(50);
    expect(MAX_PAGE_SIZE).toBeGreaterThan(0);
  });

  it("preserves the documented 500-post analytics scan depth", () => {
    expect(MAX_PAGE_SIZE * ANALYTICS_MAX_PAGES).toBe(500);
    expect(ANALYTICS_SCAN_DEPTH).toBe(500);
  });

  it("getPostAnalytics sends a limit value within the cap on every page", async () => {
    const fetchMock = stubPagedFeed(10_000); // feed deeper than the scan bound
    const client = new SubstackClient("https://example.substack.com", "tok", "1");

    // An id past the scan depth, so the loop runs to its bound.
    const post = await client.getPostAnalytics(9_999);
    expect(post).toBeNull();

    const limits = paramValues(fetchMock, "limit");
    // Every request carries a limit — none slipped through unparameterized.
    expect(limits).toHaveLength(fetchMock.mock.calls.length);
    expect(fetchMock).toHaveBeenCalledTimes(ANALYTICS_MAX_PAGES);
    // The value, not the shape: no page may exceed what Substack accepts.
    expect(Math.max(...limits)).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect(limits).toEqual(Array(ANALYTICS_MAX_PAGES).fill(MAX_PAGE_SIZE));
  });

  it("getPostAnalytics tiles offsets across exactly the scan depth", async () => {
    const fetchMock = stubPagedFeed(10_000);
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    await client.getPostAnalytics(9_999);

    const offsets = paramValues(fetchMock, "offset");
    expect(offsets).toEqual(
      Array.from({ length: ANALYTICS_MAX_PAGES }, (_, i) => i * MAX_PAGE_SIZE),
    );
    // Last page starts one page short of the bound, so the scan covers
    // ANALYTICS_SCAN_DEPTH posts with no gap and no overshoot.
    expect(Math.max(...offsets)).toBe(ANALYTICS_SCAN_DEPTH - MAX_PAGE_SIZE);
    expect(Math.max(...offsets) + MAX_PAGE_SIZE).toBe(ANALYTICS_SCAN_DEPTH);
  });

  it("findPostAnalytics reports why a post was not found and passes isCapped through", async () => {
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    stubPagedFeed(10_000);
    expect(await client.findPostAnalytics(9_999)).toEqual({ post: null, outcome: "scan_bound_reached", scanned: ANALYTICS_SCAN_DEPTH, feed_capped: null });
    stubPagedFeed(120);
    expect(await client.findPostAnalytics(999)).toEqual({ post: null, outcome: "archive_exhausted", scanned: 120, feed_capped: null });
    const found = await client.findPostAnalytics(60);
    expect(found).toMatchObject({ outcome: "found", scanned: 100, feed_capped: null });
    expect(found.post?.id).toBe(60);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ posts: [{ id: 1, title: "only" }], total: 1, isCapped: false }))));
    expect(await client.findPostAnalytics(2)).toEqual({ post: null, outcome: "archive_exhausted", scanned: 1, feed_capped: false });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ posts: [], total: 0, isCapped: "yes" }))));
    expect((await client.findPostAnalytics(2)).feed_capped).toBeNull();
  });

  it("findPostAnalytics classifies the search with the feed's reported total", async () => {
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    const feed = (pages: (offset: number) => { posts: unknown[]; total?: unknown }) => vi.stubGlobal("fetch", vi.fn(async (url: any) =>
      new Response(JSON.stringify(pages(Number(new URL(String(url)).searchParams.get("offset") ?? 0))))));
    const posts = (offset: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: offset + i + 1, title: "Post" }));

    // A short page while total says 80 more remain: never claim the archive was searched.
    feed(offset => ({ posts: posts(offset, 20), total: 100 }));
    expect(await client.findPostAnalytics(999)).toMatchObject({ post: null, outcome: "feed_incomplete", scanned: 20 });

    // Exactly ANALYTICS_SCAN_DEPTH posts: ten full pages reach the reported total, so every post was searched.
    stubPagedFeed(ANALYTICS_SCAN_DEPTH);
    expect(await client.findPostAnalytics(9_999)).toMatchObject({ outcome: "archive_exhausted", scanned: ANALYTICS_SCAN_DEPTH });
    stubPagedFeed(ANALYTICS_SCAN_DEPTH + 1);
    expect(await client.findPostAnalytics(9_999)).toMatchObject({ outcome: "scan_bound_reached", scanned: ANALYTICS_SCAN_DEPTH });

    // Without a reported total: a short page ends the feed, and full pages cannot prove exhaustion.
    feed(offset => ({ posts: posts(offset, 7) }));
    expect(await client.findPostAnalytics(999)).toMatchObject({ outcome: "archive_exhausted", scanned: 7 });
    feed(offset => ({ posts: posts(offset, MAX_PAGE_SIZE) }));
    expect(await client.findPostAnalytics(9_999)).toMatchObject({ outcome: "scan_bound_reached", scanned: ANALYTICS_SCAN_DEPTH });
    feed(offset => ({ posts: posts(offset, MAX_PAGE_SIZE), total: "500" }));
    expect(await client.findPostAnalytics(9_999)).toMatchObject({ outcome: "scan_bound_reached" });
  });

  it("findPostAnalytics never claims exhaustion from inconsistent pages", async () => {
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    const feed = (pages: (offset: number) => { posts: unknown[]; total?: unknown }) => vi.stubGlobal("fetch", vi.fn(async (url: any) =>
      new Response(JSON.stringify(pages(Number(new URL(String(url)).searchParams.get("offset") ?? 0))))));
    const posts = (offset: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: offset + i + 1, title: "Post" }));

    // Total shrinks after the first page (posts deleted mid-scan): final total alone would say exhausted.
    feed(offset => ({ posts: posts(offset, MAX_PAGE_SIZE), total: offset === 0 ? 600 : ANALYTICS_SCAN_DEPTH }));
    expect(await client.findPostAnalytics(9_999)).toMatchObject({ outcome: "feed_incomplete", scanned: ANALYTICS_SCAN_DEPTH });
    // Total grows before a short page.
    feed(offset => ({ posts: posts(offset, offset === 0 ? MAX_PAGE_SIZE : 10), total: offset === 0 ? 60 : 55 }));
    expect(await client.findPostAnalytics(9_999)).toMatchObject({ outcome: "feed_incomplete", scanned: 60 });
    // Underreported total: ten full pages with total 0.
    feed(offset => ({ posts: posts(offset, MAX_PAGE_SIZE), total: 0 }));
    expect(await client.findPostAnalytics(9_999)).toMatchObject({ outcome: "feed_incomplete", scanned: ANALYTICS_SCAN_DEPTH });
    // More posts than the total on a short page.
    feed(offset => ({ posts: posts(offset, 10), total: 5 }));
    expect(await client.findPostAnalytics(9_999)).toMatchObject({ outcome: "feed_incomplete", scanned: 10 });
    // Total reported on only some pages.
    feed(offset => ({ posts: posts(offset, offset === 0 ? MAX_PAGE_SIZE : 20), ...(offset === 0 ? { total: 70 } : {}) }));
    expect(await client.findPostAnalytics(9_999)).toMatchObject({ outcome: "feed_incomplete", scanned: 70 });
    // A post repeated across pages (rows shifted by an insertion) with a matching total.
    feed(offset => ({ posts: offset === 0 ? posts(0, MAX_PAGE_SIZE) : posts(MAX_PAGE_SIZE - 1, 10), total: 60 }));
    expect(await client.findPostAnalytics(9_999)).toMatchObject({ outcome: "feed_incomplete", scanned: 60 });
    // A consistent snapshot is still exhausted, and a found post still wins.
    feed(offset => ({ posts: posts(offset, offset === 0 ? MAX_PAGE_SIZE : 10), total: 60 }));
    expect(await client.findPostAnalytics(9_999)).toMatchObject({ outcome: "archive_exhausted", scanned: 60 });
    feed(offset => ({ posts: posts(offset, MAX_PAGE_SIZE), total: offset === 0 ? 600 : 500 }));
    expect((await client.findPostAnalytics(60)).outcome).toBe("found");
  });

  it("getPostAnalytics stops as soon as the post is found", async () => {
    const fetchMock = stubPagedFeed(10_000);
    const client = new SubstackClient("https://example.substack.com", "tok", "1");

    // Post 60 lands on page 1 (offset 50), so page 2 must never be requested.
    const post = await client.getPostAnalytics(60);
    expect(post?.id).toBe(60);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(paramValues(fetchMock, "limit")).toEqual([MAX_PAGE_SIZE, MAX_PAGE_SIZE]);
  });
});

describe("SubstackClient error mapping (end-to-end through request())", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetchError(status: number, body: string) {
    const fetchMock = vi.fn(async (..._args: any[]) => new Response(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("maps a 401 response to AuthenticationError", async () => {
    stubFetchError(401, "Not authorized");
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    await expect(client.getDrafts()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("maps a 403 Cloudflare-style block to AuthenticationError", async () => {
    stubFetchError(403, "error code: 1010");
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    await expect(client.getDrafts()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("maps a 429 response to RateLimitError with the body as detail", async () => {
    stubFetchError(429, JSON.stringify({ error: "Too many requests" }));
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    try {
      await client.getDrafts();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).message).toContain("Too many requests");
    }
  });

  it("maps a 400 response to ValidationError", async () => {
    stubFetchError(400, JSON.stringify({ error: "draft_title is required" }));
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    try {
      await client.createDraft("");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain("draft_title is required");
    }
  });

  it("maps a 404 response to NotFoundError", async () => {
    stubFetchError(404, "Draft not found");
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    try {
      await client.getDraft(999);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toContain("Draft not found");
    }
  });

  it("maps a 500 response to ServerError", async () => {
    stubFetchError(500, "Internal Server Error");
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    try {
      await client.getDrafts();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).message).toContain("Internal Server Error");
    }
  });

  it("falls back to base SubstackAPIError for an unmapped status", async () => {
    stubFetchError(418, "I'm a teapot");
    const client = new SubstackClient("https://example.substack.com", "tok", "1");
    try {
      await client.getDrafts();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SubstackAPIError);
      expect(err).not.toBeInstanceOf(AuthenticationError);
      expect(err).not.toBeInstanceOf(RateLimitError);
      expect(err).not.toBeInstanceOf(ValidationError);
      expect(err).not.toBeInstanceOf(NotFoundError);
      expect(err).not.toBeInstanceOf(ServerError);
      expect((err as SubstackAPIError).message).toContain("I'm a teapot");
    }
  });
});

describe("parseMagnitude", () => {
  it("parses whole-K buckets", () => {
    expect(parseMagnitude("1K+")).toBe(1000);
    expect(parseMagnitude("2K")).toBe(2000);
  });

  it("parses fractional-K buckets (regression: .replace('K','000') produced NaN)", () => {
    expect(parseMagnitude("2.5K+")).toBe(2500);
    expect(parseMagnitude("1.2K")).toBe(1200);
  });

  it("parses bare numbers and M buckets", () => {
    expect(parseMagnitude("750+")).toBe(750);
    expect(parseMagnitude("1,500+")).toBe(1500);
    expect(parseMagnitude("1M+")).toBe(1000000);
  });

  it("returns null for unparseable or zero values", () => {
    expect(parseMagnitude("")).toBeNull();
    expect(parseMagnitude("lots")).toBeNull();
    expect(parseMagnitude("0")).toBeNull();
    expect(parseMagnitude("0K")).toBeNull();
  });
});

describe("SubstackClient.getSubscriberCount", () => {
  const client = () =>
    new SubstackClient("https://example.substack.com", "tok123", "42");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body));
  const htmlResponse = (html: string) =>
    new Response(html);

  it("reports exact when the API returns subscriber_count", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ subscriber_count: 1073 }));
    const r = await client().getSubscriberCount();
    expect(r).toMatchObject({ count: 1073, precision: "exact" });
  });

  it("NEVER counts the paginated subscribers sample as the total", async () => {
    // The regression this guards: an 11-item sample was returned as count: 11
    // for a publication with >1,000 subscribers.
    const sample = { subscribers: Array.from({ length: 11 }, (_, i) => ({ id: i })) };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(sample))
      .mockResolvedValueOnce(htmlResponse('{"freeSubscriberCount":"1,000"}'));
    const r = await client().getSubscriberCount();
    expect(r.count).not.toBe(11);
    expect(r).toMatchObject({ count: 1000, precision: "approximate" });
  });

  it("falls back to the rounded public value and marks it approximate", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ audience: null }))
      .mockResolvedValueOnce(htmlResponse('{\\"freeSubscriberCount\\":\\"1,000\\"}'));
    const r = await client().getSubscriberCount();
    expect(r.precision).toBe("approximate");
    expect(r.count).toBe(1000);
    expect(r.note).toMatch(/or higher/);
  });

  it("uses the order-of-magnitude bucket when no numeric count is present", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(htmlResponse('{"freeSubscriberCountOrderOfMagnitude":"2.5K+"}'));
    const r = await client().getSubscriberCount();
    expect(r).toMatchObject({ count: 2500, precision: "approximate" });
  });

  it("returns unavailable rather than a fabricated number when everything fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const r = await client().getSubscriberCount();
    expect(r).toMatchObject({ count: -1, precision: "unavailable" });
  });
});

describe("SubstackClient request timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubOk() {
    const fetchMock = vi.fn(async (..._args: any[]) => new Response('{"posts":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("attaches an AbortSignal to every request", async () => {
    const fetchMock = stubOk();
    await new SubstackClient("https://example.substack.com", "tok", "1").getDrafts();

    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses a 30s deadline by default", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubOk();
    await new SubstackClient("https://example.substack.com", "tok", "1").getDrafts();

    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("honors an explicit timeout override", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubOk();
    await new SubstackClient("https://example.substack.com", "tok", "1", undefined, 1234).getDrafts();

    expect(timeoutSpy).toHaveBeenCalledWith(1234);
  });

  it.each([0, -1, NaN])("falls back to the default for a nonsense override (%s)", async (bad) => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubOk();
    await new SubstackClient("https://example.substack.com", "tok", "1", undefined, bad).getDrafts();

    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it("surfaces an aborted request as TimeoutError, not a bare DOMException", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );
    const client = new SubstackClient("https://example.substack.com", "tok", "1", undefined, 5000);

    await expect(client.getDrafts()).rejects.toBeInstanceOf(TimeoutError);
    await expect(client.getDrafts()).rejects.toThrow(/timed out after 5000ms/);
    await expect(client.getDrafts()).rejects.toThrow(/post_management\/drafts/);
  });

  it("leaves a non-abort network failure alone instead of calling it a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const client = new SubstackClient("https://example.substack.com", "tok", "1");

    await expect(client.getDrafts()).rejects.toBeInstanceOf(TypeError);
    await expect(client.getDrafts()).rejects.not.toBeInstanceOf(TimeoutError);
  });

  it("bounds the public-page scrape too, and reports unavailable when it aborts", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );
    const r = await new SubstackClient(
      "https://example.substack.com",
      "tok",
      "1",
      undefined,
      7000,
    ).getSubscriberCount();

    expect(r).toMatchObject({ count: -1, precision: "unavailable" });
    // Both the API attempt and the HTML fallback are bounded.
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 7000);
  });
});


describe("authentication evidence", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("never identifies the signed-in user from a draft byline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ posts: [{ draft_bylines: [{ id: 999 }] }] })));
    const client = new SubstackClient("https://example.invalid", "synthetic-token", "42");
    expect(await client.validateAuth()).toEqual({ authentication: "authenticated_read_succeeded", user_identity: "not_verified" });
  });
  it.each([{}, { posts: null }, { posts: "not-an-array" }])("rejects malformed successful authentication responses: %j", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await expect(new SubstackClient("https://example.invalid", "synthetic-token", "42").validateAuth()).rejects.toThrow("unexpected response");
  });
});
