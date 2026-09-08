import { afterEach, describe, expect, it, vi } from "vitest";
import { SubstackClient } from "../api/client.js";
import { doctor } from "../doctor.js";
import { validateCredentials } from "../auth/validate-credentials.js";

afterEach(() => vi.unstubAllGlobals());
const base = { publicationUrl: "https://example.substack.com", sessionToken: "example-s%3Asignature", userId: "123" };
const resolve = (overrides: Partial<typeof base>) => () => [{ ...base, ...overrides, key: "test", label: "Test", source: "env" as const, missing: [] }];

describe("shared configuration boundary", () => {
  const invalid = [
    ...["https://example.org/path/..", "https://example.org/?", "https://example.org/#", "https:example.org"].map(publicationUrl => ({ publicationUrl })),
    ...["http://example.org", "https://name:password@example.org", "https://example.org/path", "https://example.org/?private", "https://example.org/#private", "https://example.org:8443", " https://example.org", "https://exam\nple.org", "https:\\example.org", "invalid"].map(publicationUrl => ({ publicationUrl })),
    ...["0", "-1", "1oops", "1.5", "1e3", " 1", "1\n", "9007199254740992", ""].map(userId => ({ userId })),
    ...["", "token; other=value", "token,other", "token\n", "token\r", "token with spaces", '"quoted"', "token\\value", "nonasciié"].map(sessionToken => ({ sessionToken })),
  ];
  it.each(invalid)("rejects invalid config in both paths before fetching: %j", async override => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const p = { ...base, ...override };
    let error: unknown;
    try { new SubstackClient(p.publicationUrl, p.sessionToken, p.userId); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(base.sessionToken);
    const report = await doctor(true, resolve(override));
    expect(report.ok).toBe(false);
    expect(report.publications[0].configuration).toBe("invalid");
    expect(report.publications[0].authentication).toBe("not_checked");
    expect(fetchMock).not.toHaveBeenCalled();
    if ("publicationUrl" in override) expect(report.publications[0].origin).toBeNull();
  });

  it.each([
    ["https://EXAMPLE.substack.com/", "https://example.substack.com"],
    ["https://newsletter.example.org:443/", "https://newsletter.example.org"],
    ["https://münchen.example/", "https://xn--mnchen-3ya.example"],
  ])("normalizes %s and preserves cookies in both request paths", async (publicationUrl, origin) => {
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => new Response('{"posts":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SubstackClient(publicationUrl, base.sessionToken, "000123");
    await client.getDrafts(0, 1);
    const report = await doctor(true, resolve({ publicationUrl, userId: "000123" }));
    expect(report.ok).toBe(true);
    expect(report.publications[0].origin).toBe(origin);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(new URL(url).origin).toBe(origin);
      expect(new Headers(options.headers).get("Cookie")).toBe(`connect.sid=${base.sessionToken}; substack.sid=${base.sessionToken};`);
    }
    expect(validateCredentials(publicationUrl, base.sessionToken, "000123").userId).toBe(123);
    expect(JSON.stringify(report)).not.toContain(base.sessionToken);
  });
  it("retains the largest safe ID without rounding and accepts cookie-octet punctuation", () => {
    expect(validateCredentials(base.publicationUrl, "!#$%&'()*+-./012:<=?>@[]^_`{|}~", String(Number.MAX_SAFE_INTEGER)).userId).toBe(Number.MAX_SAFE_INTEGER);
  });
});
