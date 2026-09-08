import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseLoginArguments, readSessionCookie, runLogin } from "../login.js";
import { loadProfile } from "../auth/profiles.js";
import { loadSession } from "../auth/session-store.js";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "substack-login-test-")); vi.stubEnv("SUBSTACK_MCP_HOME", dir); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); expect(dir.startsWith(join(tmpdir(), "substack-login-test-"))).toBe(true); rmSync(dir, { recursive: true, force: true }); });
function fixture(publicationCookie = true, auth = true) {
  const cookies = vi.fn(async (url: string) => url === "https://substack.com" ? [{ name: "substack.sid", value: "example-substack-token" }] : publicationCookie ? [{ name: "connect.sid", value: "example-publication-token" }] : []);
  const goto = vi.fn(), close = vi.fn(async () => {});
  const launch = vi.fn(async () => ({ newContext: async () => ({ cookies, newPage: async () => ({ goto }) }), close }));
  const deps = { ask: vi.fn(async () => ""), loadChromium: vi.fn(async () => ({ launch })), out: vi.fn(), error: vi.fn() };
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
    expect(f.goto.mock.calls.map(call => call[0])).toEqual(["https://substack.com/sign-in", "https://example.com"]);
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
  });
  it("requires a successful authenticated read before saving", async () => {
    const f = fixture(true, false); expect(await runLogin(["https://example.com", "--user-id", "42"], f.deps)).toBe(1);
    expect(loadSession()).toBeNull(); expect(JSON.stringify(f.deps.error.mock.calls)).not.toContain("example-failure-token"); expect(f.close).toHaveBeenCalledOnce();
  });
  it("rejects ambiguous same-name cookies", async () => {
    const context = { cookies: vi.fn(async () => [{ name: "connect.sid", value: "one" }, { name: "connect.sid", value: "two" }]) };
    await expect(readSessionCookie(context, "https://example.com")).rejects.toThrow("Ambiguous");
    expect(context.cookies).toHaveBeenCalledExactlyOnceWith("https://example.com");
  });
});
