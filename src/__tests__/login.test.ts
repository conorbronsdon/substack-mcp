import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseLoginArguments, readSessionCookie, selectSessionCookie, runLogin } from "../login.js";
import { loadProfile } from "../auth/profiles.js";
import { loadSession } from "../auth/session-store.js";
import { createKeychain } from "../auth/keychain.js";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "substack-login-test-")); vi.stubEnv("SUBSTACK_MCP_HOME", dir); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); expect(dir.startsWith(join(tmpdir(), "substack-login-test-"))).toBe(true); rmSync(dir, { recursive: true, force: true }); });
function fixture(publicationCookie = true, auth = true) {
  const cookies = vi.fn(async (url: string) => url === "https://substack.com" ? [{ name: "substack.sid", domain: ".substack.com", value: "example-substack-token" }] : publicationCookie ? [{ name: "connect.sid", domain: "example.com", value: "example-publication-token" }] : []);
  const goto = vi.fn(), close = vi.fn(async () => {});
  const launch = vi.fn(async () => ({ newContext: async () => ({ cookies, newPage: async () => ({ goto }) }), close }));
  const deps = { ask: vi.fn(async () => ""), loadChromium: vi.fn(async () => ({ launch })), out: vi.fn(), error: vi.fn(), pollIntervalMs: 1, publicationWaitMs: 50 };
  const fetch = vi.fn(async () => auth ? Response.json({ posts: [] }) : new Response("example-failure-token", { status: 403 })); vi.stubGlobal("fetch", fetch);
  return { deps, cookies, goto, close, launch, fetch };
}
describe("browser login contract", () => {
  it.each([
    ["https://example.com/path"], ["http://example.com"], ["https://u:p@example.com"],
    ["--user-id", "0"], ["--user-id", "1abc"], ["--profile", "../x"], ["--force"],
    ["--user-id", "1", "--user-id", "2"], ["--unknown"],
  ])("rejects invalid input before browser loading: %j", async (...args) => {
    expect(() => parseLoginArguments(args)).toThrow(); const f = fixture();
    expect(await runLogin(args, f.deps)).toBe(2); expect(f.deps.loadChromium).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("prints help without loading a browser or resolving credentials", async () => {
    const f = fixture(); expect(await runLogin(["--help"], f.deps)).toBe(0);
    expect(f.deps.loadChromium).not.toHaveBeenCalled(); expect(f.deps.ask).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("uses only a cookie scoped to the publication API and never infers a byline ID", async () => {
    const f = fixture(); expect(await runLogin(["https://example.com", "--user-id", "42", "--profile", "work"], f.deps)).toBe(0);
    expect(f.cookies.mock.calls.map(call => call[0])).toEqual(["https://substack.com", "https://example.com/api/v1/post_management/drafts"]);
    expect(f.goto.mock.calls.map(call => call[0])).toEqual(["https://substack.com/sign-in", "https://example.com/publish/home"]);
    expect(loadProfile("work")).toMatchObject({ publicationUrl: "https://example.com", sessionToken: "example-publication-token", userId: "42" });
    expect(loadSession()).toBeNull(); expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledOnce();
    const output = f.deps.out.mock.calls.map(call => call[0]).join("\n");
    expect(output).toContain('"user_identity":"not_verified"'); expect(output).not.toContain("example-publication-token");
  });
  it("preserves the legacy login path and requires force to replace a named profile", async () => {
    const f = fixture();
    expect(await runLogin(["https://example.com", "--user-id", "42"], f.deps)).toBe(0);
    expect(loadSession()).toMatchObject({ userId: "42", sessionToken: "example-publication-token" });
    const args = ["https://example.com", "--user-id", "43", "--profile", "work"];
    expect(await runLogin(args, f.deps)).toBe(0);
    const before = loadProfile("work");
    f.deps.loadChromium.mockClear(); f.fetch.mockClear();
    expect(await runLogin(["https://example.com", "--user-id", "44", "--profile", "work"], f.deps)).toBe(1);
    expect(loadProfile("work")).toEqual(before);
    expect(f.deps.loadChromium).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    expect(await runLogin(["https://example.com", "--user-id", "44", "--profile", "work", "--force"], f.deps)).toBe(0);
    expect(loadProfile("work").userId).toBe("44");
    expect(loadSession()?.userId).toBe("42");
  });
  it("never falls back to the general Substack cookie when the publication cookie is absent", async () => {
    const f = fixture(false); expect(await runLogin(["https://example.com", "--user-id", "42"], f.deps)).toBe(1);
    expect(loadSession()).toBeNull(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
    const error = f.deps.error.mock.calls.flat().join(" ");
    expect(error).toContain("connect.sid"); expect(error).toContain("example.com"); expect(error).toContain("/publish/home");
  });
  it("requires a successful authenticated read before saving", async () => {
    const f = fixture(true, false); expect(await runLogin(["https://example.com", "--user-id", "42"], f.deps)).toBe(1);
    expect(loadSession()).toBeNull(); expect(f.close).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledOnce();
    const error = f.deps.error.mock.calls.flat().join(" ");
    expect(error).toContain("connect.sid"); expect(error).toContain("example.com"); expect(error).toContain("unauthorized_or_blocked");
    expect(error).not.toContain("example-"); expect(error).not.toContain("42");
  });
  it("rejects ambiguous same-name cookies", async () => {
    const context = { cookies: vi.fn(async () => [{ name: "connect.sid", domain: "example.com", value: "example-one" }, { name: "connect.sid", domain: "example.com", value: "example-two" }]) };
    await expect(readSessionCookie(context, "https://example.com")).rejects.toThrow("Ambiguous");
    expect(context.cookies).toHaveBeenCalledExactlyOnceWith("https://example.com");
  });
  it("waits for the publication cookie to appear after redirect polls", async () => {
    const f = fixture(); let polls = 0;
    const cookies = f.cookies.getMockImplementation()!;
    f.cookies.mockImplementation(async url => url === "https://substack.com" || ++polls >= 3 ? cookies(url) : []);
    expect(await runLogin(["https://example.com", "--user-id", "42"], f.deps)).toBe(0);
    expect(polls).toBe(3); expect(f.fetch).toHaveBeenCalledOnce();
    expect(loadSession()?.sessionToken).toBe("example-publication-token");
  });
  it("checks each distinct value once and saves the rotated authenticated cookie", async () => {
    const f = fixture(); let polls = 0;
    const cookies = f.cookies.getMockImplementation()!;
    f.cookies.mockImplementation(async url => url === "https://substack.com" ? cookies(url) : [{ name: "connect.sid", domain: "example.com", value: ++polls <= 2 ? "example-stale-token" : "example-rotated-token" }]);
    f.fetch.mockImplementationOnce(async () => new Response("example-failure-token", { status: 403 }));
    expect(await runLogin(["https://example.com", "--user-id", "42"], f.deps)).toBe(0);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ Cookie: expect.stringContaining("example-stale-token") }) }));
    expect(f.fetch).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ Cookie: expect.stringContaining("example-rotated-token") }) }));
    expect(loadSession()?.sessionToken).toBe("example-rotated-token");
  });
  it("surfaces ambiguity without exposing cookie values", async () => {
    const f = fixture(); const cookies = f.cookies.getMockImplementation()!;
    f.cookies.mockImplementation(async url => url === "https://substack.com" ? cookies(url) : [
      { name: "connect.sid", domain: "example.com", value: "example-one" },
      { name: "connect.sid", domain: "example.com", value: "example-two" },
    ]);
    expect(await runLogin(["https://example.com", "--user-id", "42"], f.deps)).toBe(1);
    const error = f.deps.error.mock.calls.flat().join(" ");
    expect(error).toContain("multiple distinct connect.sid cookies for example.com");
    expect(error).toContain("fresh browser context"); expect(error).not.toContain("example-");
    expect(loadSession()).toBeNull(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("writes the selected keychain during browser login without creating a file", async () => {
    vi.stubEnv("SUBSTACK_CREDENTIAL_STORE", "keychain");
    const f = fixture();
    let stored = "";
    const keychain = createKeychain("linux", async (_file, args, input) => {
      if (args[0] === "store") { stored = input; return { code: 0, stdout: "", stderr: "" }; }
      return stored ? { code: 0, stdout: stored, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    });
    expect(await runLogin(["https://example.com", "--user-id", "42", "--profile", "work"], { ...f.deps, keychain })).toBe(0);
    expect(JSON.parse(stored).sessionToken).toBe("example-publication-token");
    expect(loadSession()).toBeNull();
    expect(f.deps.out.mock.calls.flat().join("\n")).toContain('"storage":"keychain"');
  });
  it("refuses an existing named keychain profile before launching the browser", async () => {
    vi.stubEnv("SUBSTACK_CREDENTIAL_STORE", "keychain");
    const f = fixture();
    const calls: string[] = [];
    const keychain = createKeychain("linux", async (_file, args) => {
      calls.push(args[0]);
      return { code: 0, stdout: JSON.stringify({ publicationUrl: "https://example.com", sessionToken: "example-existing-token", userId: "42", savedAt: "2026-01-01T00:00:00.000Z" }), stderr: "" };
    });
    expect(await runLogin(["https://example.com", "--user-id", "42", "--profile", "work"], { ...f.deps, keychain })).toBe(1);
    expect(calls).toEqual(["lookup"]);
    expect(f.deps.loadChromium).not.toHaveBeenCalled();
    expect(f.deps.ask).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.deps.error.mock.calls.flat().join(" ")).toContain("--force");
  });
});

describe("session cookie selection", () => {
  const hostCookie = { name: "connect.sid", domain: "newsletter.example.com", value: "example-host-token" };
  const substackCookie = { name: "substack.sid", domain: ".substack.com", value: "example-substack-token" };
  const url = "https://newsletter.example.com";
  it("prefers the custom host cookie over a different Substack session", () => {
    expect(selectSessionCookie([substackCookie, hostCookie], url)).toEqual({ name: "connect.sid", host: "newsletter.example.com", value: "example-host-token" });
  });
  it("never falls back to Substack for a custom domain", () => {
    expect(selectSessionCookie([substackCookie], url)).toBeNull();
  });
  it("ignores parent domains, other hosts and empty values", () => {
    expect(selectSessionCookie([{ ...hostCookie, domain: ".example.com" }, { ...hostCookie, domain: "other.example.com" }, { ...hostCookie, value: "" }], url)).toBeNull();
  });
  it("allows Substack-hosted fallback and prefers the exact host connect.sid", () => {
    const hosted = "https://example.substack.com";
    expect(selectSessionCookie([substackCookie], hosted)?.host).toBe("substack.com");
    expect(selectSessionCookie([substackCookie, { ...hostCookie, domain: ".EXAMPLE.SUBSTACK.COM" }], hosted)?.name).toBe("connect.sid");
    expect(selectSessionCookie([{ ...substackCookie, domain: "example.substack.com" }], hosted)?.host).toBe("example.substack.com");
    expect(selectSessionCookie([substackCookie], "https://substack.com")?.name).toBe("substack.sid");
  });
  it("rejects distinct values but accepts identical duplicates", () => {
    expect(() => selectSessionCookie([hostCookie, { ...hostCookie, value: "example-other-token" }], url)).toThrow("Ambiguous session cookies");
    expect(selectSessionCookie([hostCookie, { ...hostCookie, domain: ".NEWSLETTER.EXAMPLE.COM" }], url)?.value).toBe("example-host-token");
    expect(() => selectSessionCookie([substackCookie, { ...substackCookie, domain: "example.substack.com", value: "example-other-token" }], "https://example.substack.com")).toThrow("Ambiguous");
  });
});
