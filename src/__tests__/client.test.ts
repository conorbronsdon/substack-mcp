import { describe, it, expect, vi, afterEach } from "vitest";
import { SubstackClient } from "../api/client.js";
import {
  AuthenticationError,
  RateLimitError,
  ValidationError,
  NotFoundError,
  ServerError,
  SubstackAPIError,
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
    ).toThrow('Invalid SUBSTACK_USER_ID: "abc" — must be a number');
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
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      status: 200,
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody),
    }));
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
    // A short page (1 < 100) means end-of-feed: exactly one request, no over-paging.
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

describe("SubstackClient error mapping (end-to-end through request())", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetchError(status: number, body: string) {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: false,
      status,
      json: async () => JSON.parse(body),
      text: async () => body,
    }));
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
