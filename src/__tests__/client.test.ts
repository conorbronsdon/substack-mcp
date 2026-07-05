import { describe, it, expect, vi, afterEach } from "vitest";
import { SubstackClient } from "../api/client.js";

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
