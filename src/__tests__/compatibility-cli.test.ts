import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_KINDS } from "../annotations.js";
import { runCompatibility } from "../compatibility-cli.js";
import type { PublicationCredentials } from "../auth/resolve-publications.js";
import * as keychain from "../auth/keychain.js";
const first: PublicationCredentials = { key: "example-private-profile", label: "Example private label", publicationUrl: "https://example-private.substack.com",
  sessionToken: "example-private-token", userId: "987654321", source: "env", missing: [] };
const second: PublicationCredentials = { ...first, key: "example-second-profile", publicationUrl: "https://example-second.org", sessionToken: "example-second-token" };
const now = () => new Date("2026-10-27T12:00:00Z");
function fixture(pubs = [first]) {
  const resolve = vi.fn(async () => pubs), io = { out: vi.fn(), error: vi.fn() };
  const fetch = vi.fn(async () => Response.json({ posts: [{ id: 101, draft_title: "example-private-title", draft_body: "example-private-body" }] }));
  vi.stubGlobal("fetch", fetch);
  return { resolve, io, now, fetch, result: () => JSON.parse(io.out.mock.calls[0][0]) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("shareable compatibility reports", () => {
  it("observes local initialization/catalog with no network and no account identifiers", async () => {
    const f = fixture(); expect(await runCompatibility(["report"], f)).toBe(0);
    expect(f.result()).toMatchObject({ format_version: 1, generated_at: now().toISOString(), ok: true, code: "offline_report",
      configuration: { status: "valid", credential_source: "env" }, authentication: { status: "not_checked", user_identity: "not_verified" },
      protocol: { transport: "in_memory", initialize: "pass", tools_list: "pass", tool_count: Object.keys(TOOL_KINDS).length, annotated_tool_count: Object.keys(TOOL_KINDS).length, output_schema_count: Object.keys(TOOL_KINDS).length - 4 },
      manual_observations: { client_name: "unknown", browser_login: "untested", account_tier: "unknown", client_workflows: "untested" } });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.io.error).not.toHaveBeenCalled();
    const output = JSON.stringify(f.io.out.mock.calls);
    for (const privateValue of [first.key, first.label, first.publicationUrl, first.sessionToken, first.userId]) expect(output).not.toContain(privateValue);
  });
  it.each([["--help"], ["report", "--help"]])("prints help without loading credentials or fetching: %j", async (...args) => {
    const f = fixture(); expect(await runCompatibility(args, f)).toBe(0);
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.io.out).toHaveBeenCalledOnce();
  });
  it.each([[], ["wat"], ["report", "--unknown"], ["report", "--check-auth", "--check-auth"], ["report", "--publication"],
    ["report", "--publication", "--check-auth"], ["report", "--json", "--json"], ["report", "--publication", "a\nb"]])("rejects invalid arguments without setup or requests: %j", async (...args) => {
    const f = fixture(); expect(await runCompatibility(args, f)).toBe(2);
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.io.out).not.toHaveBeenCalled();
  });
  it.each([false, true])("requires explicit publication selection in multi-account mode (live=%s)", async live => {
    const f = fixture([first, second]); expect(await runCompatibility(["report", ...(live ? ["--check-auth"] : [])], f)).toBe(1);
    expect(f.result()).toMatchObject({ code: "publication_selection_required", selection: { configured_publications: 2 }, protocol: { initialize: "not_run" } });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("checks resolved environment credentials without requiring an unrelated keychain probe", async () => {
    vi.stubEnv("SUBSTACK_CREDENTIAL_STORE", "keychain");
    vi.stubEnv("SUBSTACK_PUBLICATION_URL", first.publicationUrl);
    vi.stubEnv("SUBSTACK_SESSION_TOKEN", first.sessionToken);
    vi.stubEnv("SUBSTACK_USER_ID", first.userId);
    const store = keychain.createKeychain();
    const available = vi.fn().mockResolvedValue(false);
    const read = vi.fn().mockRejectedValue(new Error("example-unavailable-keychain"));
    vi.spyOn(keychain, "createKeychain").mockReturnValue({ ...store, available, read });
    const f = fixture();
    expect(await runCompatibility(["report", "--check-auth"], { io: f.io, now })).toBe(0);
    expect(f.result()).toMatchObject({ ok: true, code: "authenticated_read_observed", authentication: { status: "authenticated_read_succeeded" } });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(available).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it("does not guess on an unknown publication key", async () => {
    const f = fixture(); expect(await runCompatibility(["report", "--publication", "example-unknown-key", "--check-auth"], f)).toBe(1);
    expect(f.result().code).toBe("unknown_publication"); expect(f.fetch).not.toHaveBeenCalled();
    expect(f.io.out.mock.calls[0][0]).not.toContain("example-unknown-key");
  });
  it("reads exactly one explicitly selected publication and discards private draft data", async () => {
    const f = fixture([first, second]);
    expect(await runCompatibility(["report", "--check-auth", "--publication", second.key], f)).toBe(0);
    expect(f.result()).toMatchObject({ code: "authenticated_read_observed", authentication: { status: "authenticated_read_succeeded", user_identity: "not_verified", write_permissions: "not_checked" } });
    expect(f.fetch).toHaveBeenCalledOnce();
    const [url, init] = f.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example-second.org/api/v1/post_management/drafts?offset=0&limit=1&order_by=draft_updated_at&order_direction=desc");
    expect(init.method ?? "GET").toBe("GET"); expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("cookie")).toContain(second.sessionToken);
    expect(new Headers(init.headers).get("cookie")).not.toContain(first.sessionToken);
    for (const value of [first.key, second.key, second.publicationUrl, first.sessionToken, second.sessionToken, "example-private-title", "example-private-body", first.userId]) expect(f.io.out.mock.calls[0][0]).not.toContain(value);
  });
  it.each([[401, "unauthorized_or_blocked"], [403, "unauthorized_or_blocked"], [429, "rate_limited"], [500, "upstream_error"], [302, "redirect_rejected"]])("keeps HTTP %s failures static and makes no retries", async (status, category) => {
    const f = fixture(); f.fetch.mockImplementation(async () => new Response("example-private-token example-private-body", { status: Number(status), headers: { Location: "https://example-leak.org" } }));
    expect(await runCompatibility(["report", "--check-auth"], f)).toBe(1);
    expect(f.result()).toMatchObject({ code: "authenticated_read_failed", authentication: { status: category } });
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.io.out.mock.calls[0][0]).not.toMatch(/example-private|example-leak/);
  });
  it.each([{ posts: null }, { private: "example-private-value" }])("does not claim success on unexpected authenticated response: %j", async response => {
    const f = fixture(); f.fetch.mockImplementation(async () => Response.json(response));
    expect(await runCompatibility(["report", "--check-auth"], f)).toBe(1);
    expect(f.result().authentication.status).toBe("unexpected_response"); expect(f.io.out.mock.calls[0][0]).not.toContain("example-private-value");
  });
  it.each([{ ...first, sessionToken: "example-token; other=bad" }, { ...first, userId: "invalid-user-id" }, { ...first, missing: ["SUBSTACK_SESSION_TOKEN"] }])("reports malformed config without echoing it or connecting: %j", async credential => {
    const f = fixture([credential]); expect(await runCompatibility(["report", "--check-auth"], f)).toBe(1);
    expect(f.result()).toMatchObject({ code: "invalid_configuration", configuration: { status: "invalid" }, protocol: { initialize: "not_run" } });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.io.out.mock.calls[0][0]).not.toContain(credential.sessionToken);
  });
  it("sanitizes resolver exceptions and makes no network request", async () => {
    const f = fixture(); f.resolve.mockRejectedValue(new Error("example-private-path example-private-token"));
    expect(await runCompatibility(["report", "--check-auth"], f)).toBe(1);
    expect(f.result().code).toBe("invalid_configuration"); expect(f.fetch).not.toHaveBeenCalled();
    expect(f.io.out.mock.calls[0][0]).not.toContain("example-private");
  });
  it("sanitizes local protocol-setup exceptions instead of leaking invalid allowlist content", async () => {
    vi.stubEnv("SUBSTACK_PUBLIC_READ_ORIGINS", "example-private-invalid-origin");
    const f = fixture(); expect(await runCompatibility(["report"], f)).toBe(1);
    expect(f.result()).toMatchObject({ code: "local_protocol_failed", protocol: { initialize: "fail" } });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.io.out.mock.calls[0][0]).not.toContain("example-private-invalid-origin");
  });
});
