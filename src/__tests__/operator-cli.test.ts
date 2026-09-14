import { afterEach, describe, expect, it, vi } from "vitest";
import { projectFailure, runOperator, runStatus } from "../operator-cli.js";
import packageMetadata from "../../package.json" with { type: "json" };
import { SubstackClient } from "../api/client.js";
import { TimeoutError } from "../utils/errors.js";

const credentials = { key: "example", label: "Example", publicationUrl: "https://example.substack.com", sessionToken: "example-private-token", userId: "1", source: "env" as const, missing: [] };
const io = () => ({ out: vi.fn(), error: vi.fn() });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("operator read commands", () => {
  it("reports offline status without network, browser or identity claims", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const output = io(); expect(await runStatus(["--json"], () => [credentials], output)).toBe(0);
    const result = JSON.parse(output.out.mock.calls[0][0]);
    expect(result).toMatchObject({ format_version: 1, command: "status", version: packageMetadata.version, ok: true, mode: "configuration_only", runtime: { node: process.version, platform: process.platform } });
    expect(result.publications[0]).toMatchObject({ publication: "example", origin: credentials.publicationUrl, credential_source: "env", authentication: "not_checked", user_identity: "not_verified" });
    expect(JSON.stringify(result)).not.toContain(credentials.sessionToken); expect(fetch).not.toHaveBeenCalled();
    const bad = io(); expect(await runStatus([], () => [{ ...credentials, userId: "0" }], bad)).toBe(1);
    expect(JSON.parse(bad.out.mock.calls[0][0]).ok).toBe(false);
  });
  it("retains exact-email lookup controls and uses no subscriber-write endpoint", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ count: 1, subscribers: [{ user_email_address: "reader@example.com", subscription_id: 9, subscription_interval: "free" }] }));
    vi.stubGlobal("fetch", fetch);
    const output = io(); expect(await runOperator(["subscribers", "get", "Reader@Example.com"], () => [credentials], output)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetch.mock.calls[0][0])).pathname).toBe("/api/v1/subscriber-stats");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ filters: { user_email_address_string_is: "reader@example.com" }, offset: 0, limit: 2 });
    expect(JSON.parse(output.out.mock.calls[0][0]).data).toMatchObject({ email: "reader@example.com", subscriber: { subscription_id: 9 } });
    const mismatch = io(); expect(await runOperator(["subscribers", "get", "other@example.com"], () => [credentials], mismatch)).toBe(1);
    expect(mismatch.out).not.toHaveBeenCalled();
  });
  it.each([
    ["drafts", "get", "-1"], ["drafts", "get", "1.5"], ["drafts", "get", "9007199254740992"],
    ["drafts", "list", "--limit", "0"], ["drafts", "list", "--limit", "51"],
    ["drafts", "list", "--offset", "-1"], ["drafts", "list", "--offset", "9007199254740942"], ["drafts", "list", "--json", "--json"],
    ["subscribers", "get", "bad-email"], ["subscribers", "add", "reader@example.com"],
    ["analytics", "post", "1", "--publish"],
  ])("rejects invalid arguments without resolving credentials: %j", async (...args) => {
    const output = io(), load = vi.fn();
    expect(await runOperator(args, load, output)).toBe(2);
    expect(load).not.toHaveBeenCalled(); expect(output.out).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ format_version: 1, ok: false, code: "invalid_arguments" });
  });
  it("shows help offline", async () => {
    const output = io(), load = vi.fn();
    expect(await runOperator(["analytics", "--help"], load, output)).toBe(0);
    expect(load).not.toHaveBeenCalled(); expect(output.out.mock.calls[0][0]).toContain("subscribers count");
  });
  it("requires an explicit existing selector for multiple publications", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const load = () => [credentials, { ...credentials, key: "second", publicationUrl: "https://second.substack.com" }];
    for (const args of [["drafts", "list"], ["drafts", "list", "--publication", "missing"]]) {
      const output = io(); expect(await runOperator(args, load, output)).toBe(2);
      expect(JSON.parse(output.error.mock.calls[0][0]).code).toBe("publication_required");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("routes one bounded list page to the selected publication and uses the MCP projection", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ posts: [{ id: 42, draft_title: "Draft title", draft_body: "private body not in list", audience: "everyone" }] }));
    vi.stubGlobal("fetch", fetch);
    const output = io(), load = () => [credentials, { ...credentials, key: "second", publicationUrl: "https://second.substack.com" }];
    expect(await runOperator(["drafts", "list", "--offset", "2", "--limit", "3", "--publication", "second"], load, output)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.origin).toBe("https://second.substack.com"); expect(url.searchParams.get("offset")).toBe("2"); expect(url.searchParams.get("limit")).toBe("3");
    expect(JSON.parse(output.out.mock.calls[0][0])).toEqual({ format_version: 1, ok: true, command: "drafts list", publication: "second", data: [{ id: 42, title: "Draft title", audience: "everyone" }] });
    expect(output.out.mock.calls[0][0]).not.toContain("private body");
  });
  it("returns full draft data through the shared handler", async () => {
    const read = vi.spyOn(SubstackClient.prototype, "getDraft").mockResolvedValue({ id: 42, draft_title: "Title", draft_body: "Body" } as never);
    const output = io(); expect(await runOperator(["drafts", "get", "42", "--json"], () => [credentials], output)).toBe(0);
    expect(read).toHaveBeenCalledExactlyOnceWith(42);
    expect(JSON.parse(output.out.mock.calls[0][0]).data).toEqual({ id: 42, title: "Title", body: "Body" });
  });
  it("preserves missing analytics and approximate subscriber-count semantics", async () => {
    vi.spyOn(SubstackClient.prototype, "getPostAnalytics").mockResolvedValue(null);
    vi.spyOn(SubstackClient.prototype, "getSubscriberCount").mockResolvedValue({ count: 1000, precision: "approximate", note: "Rounded public count." } as never);
    const analytics = io(); expect(await runOperator(["analytics", "post", "42"], () => [credentials], analytics)).toBe(0);
    expect(JSON.parse(analytics.out.mock.calls[0][0]).data).toMatchObject({ found: false, post_id: 42 });
    const count = io(); expect(await runOperator(["subscribers", "count"], () => [credentials], count)).toBe(0);
    expect(JSON.parse(count.out.mock.calls[0][0]).data).toEqual({ count: 1000, precision: "approximate", note: "Rounded public count." });
  });
  it("does not print upstream errors or credential values", async () => {
    vi.spyOn(SubstackClient.prototype, "getDraft").mockRejectedValue(new Error("example-private-token private-body-marker"));
    const output = io(); expect(await runOperator(["drafts", "get", "42"], () => [credentials], output)).toBe(1);
    expect(output.out).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ code: "read_failed", category: "unknown", upstream_code: "tool_execution_failed" });
    expect(output.error.mock.calls[0][0]).not.toMatch(/example-private-token|private-body-marker/);
  });
  it("rejects oversized output without printing a partial private result", async () => {
    vi.spyOn(SubstackClient.prototype, "getDraft").mockResolvedValue({ id: 42, draft_body: "x".repeat(4 * 1024 * 1024) } as never);
    const output = io(); expect(await runOperator(["drafts", "get", "42"], () => [credentials], output)).toBe(1);
    expect(output.out).not.toHaveBeenCalled();
    // A body this large trips the MCP result cap before the CLI's own output cap.
    expect(JSON.parse(output.error.mock.calls[0][0])).toEqual({ format_version: 1, ok: false, command: "drafts get", code: "read_failed", category: "response_too_large",
      upstream_code: "result_too_large", message: expect.stringMatching(/No writes were attempted\.$/) });
    expect(output.error.mock.calls[0][0]).not.toContain("xxxxxxxx");
  });
});

describe("operator failure categories", () => {
  const read = async (response: () => Response, args = ["drafts", "list"]) => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal("fetch", fetch);
    const output = io(); const exit = await runOperator(args, () => [credentials], output);
    expect(exit).toBe(1); expect(output.out).not.toHaveBeenCalled(); expect(output.error).toHaveBeenCalledTimes(1);
    // Failures are never retried: each read command makes exactly one request.
    expect(fetch).toHaveBeenCalledTimes(1);
    const line = output.error.mock.calls[0][0] as string;
    expect(line).not.toContain(credentials.sessionToken); expect(line).not.toContain("private-body-marker");
    expect(Object.keys(JSON.parse(line)).every(key => ["format_version", "ok", "command", "code", "category", "upstream_code", "status", "status_source", "retry_after", "message"].includes(key))).toBe(true);
    return JSON.parse(line);
  };

  it("keeps the envelope and adds only whitelisted fields for authentication failures", async () => {
    const result = await read(() => new Response("example-private-token private-body-marker", { status: 401 }));
    expect(result).toEqual({ format_version: 1, ok: false, command: "drafts list", code: "read_failed", category: "authentication",
      upstream_code: "upstream_error", status: 401, status_source: "http", message: expect.stringContaining("substack-mcp login") });
    expect(result.message).toMatch(/No writes were attempted\.$/);
    expect(JSON.stringify(result)).not.toContain("private-body-marker");
  });
  it("retains a valid Retry-After and drops an invalid one", async () => {
    expect(await read(() => new Response("private-body-marker", { status: 429, headers: { "retry-after": "120" } }))).toMatchObject({ category: "rate_limited", status: 429, retry_after: "120" });
    const invalid = await read(() => new Response("private-body-marker", { status: 429, headers: { "retry-after": "soon" } }));
    expect(invalid.category).toBe("rate_limited"); expect(invalid).not.toHaveProperty("retry_after");
  });
  it("distinguishes not found, invalid requests and server errors", async () => {
    expect((await read(() => Response.json({ error: "private-body-marker" }, { status: 404 }))).category).toBe("not_found");
    expect((await read(() => Response.json({ error: "private-body-marker" }, { status: 400 }))).category).toBe("invalid_request");
    expect((await read(() => new Response("private-body-marker", { status: 503 }))).category).toBe("upstream_unavailable");
  });
  it("classifies client-side response failures by code, not their synthetic 502 status", async () => {
    const html = await read(() => new Response("<html>private-body-marker</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(html).toMatchObject({ category: "response_invalid", upstream_code: "unexpected_html", status: 502, status_source: "client" });
    expect(await read(() => new Response("private-body-marker", { status: 200 }))).toMatchObject({ category: "response_invalid", upstream_code: "malformed_json" });
    expect((await read(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }))).category).toBe("response_invalid");
  });
  it("classifies deadline failures as timeouts", async () => {
    vi.spyOn(SubstackClient.prototype, "getDraft").mockRejectedValue(new TimeoutError("https://example.substack.com/api/v1/drafts/42", 5));
    const output = io(); expect(await runOperator(["drafts", "get", "42"], () => [credentials], output)).toBe(1);
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ category: "timeout", upstream_code: "timeout", status: 408, status_source: "client" });
  });
  it("enforces the CLI output cap for results that pass the MCP result cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: 42, draft_body: "x".repeat(4 * 1024 * 1024 - 50) })));
    const output = io(); expect(await runOperator(["drafts", "get", "42"], () => [credentials], output)).toBe(1);
    expect(output.out).not.toHaveBeenCalled(); expect(output.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output.error.mock.calls[0][0])).toEqual({ format_version: 1, ok: false, command: "drafts get", code: "read_failed", category: "output_limit", message: expect.stringContaining("4 MiB") });
  });
  it.each([1, 10, 31, 127])("reports a User-Agent containing character %i as configuration without printing it", async code => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    vi.stubEnv("SUBSTACK_USER_AGENT", "bad" + String.fromCharCode(code) + "agent-marker");
    const output = io(); expect(await runOperator(["drafts", "list"], () => [credentials], output)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ code: "read_failed", category: "configuration" });
    expect(output.error.mock.calls[0][0]).not.toContain("agent-marker");
  });
  it.each([["tab", "Agent" + String.fromCharCode(9) + "Name"], ["Latin-1", "Caf" + String.fromCharCode(233) + " Agent"]])("sends a valid %s User-Agent unchanged", async (_name, agent) => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ posts: [] })); vi.stubGlobal("fetch", fetch);
    vi.stubEnv("SUBSTACK_USER_AGENT", agent);
    const output = io(); expect(await runOperator(["drafts", "list"], () => [credentials], output)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0][1]!.headers).get("user-agent")).toBe(agent);
  });
  it("classifies credential loading and client configuration failures without printing their text", async () => {
    for (const load of [() => { throw new Error("example-private-token"); }, () => [{ ...credentials, userId: "0" }]]) {
      const output = io(); expect(await runOperator(["drafts", "list"], load, output)).toBe(1);
      expect(output.out).not.toHaveBeenCalled();
      expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ code: "read_failed", category: "configuration" });
      expect(output.error.mock.calls[0][0]).not.toContain("example-private-token");
    }
  });
  it.each([
    [{ code: "upstream_error", status: 403, status_source: "http" }, "authentication"],
    [{ code: "upstream_error", status: 429, status_source: "http", retry_after: "Wed, 21 Oct 2026 07:28:00 GMT" }, "rate_limited"],
    [{ code: "timeout", status: 408, status_source: "client" }, "timeout"],
    [{ code: "response_too_large", status: 502, status_source: "client" }, "response_too_large"],
    [{ code: "result_too_large" }, "response_too_large"],
    [{ code: "invalid_tool_output" }, "response_invalid"],
    [{ code: "request_cancelled", status: 502, status_source: "client" }, "cancelled"],
    [{ status: 503 }, "upstream_unavailable"],
    [{ status: 502, status_source: "client" }, "unknown"],
    [{ code: "constructor", status: 200 }, "unknown"],
    [{ code: "tool_execution_failed" }, "unknown"],
  ])("projects %j to %s", (value, category) => {
    const result = projectFailure(JSON.stringify(value));
    expect(result.category).toBe(category);
    expect(result.message).toMatch(/No writes were attempted\.$/);
    if ("retry_after" in value) expect(result.retry_after).toBe(value.retry_after);
  });
  it.each([
    ["not json at all: example-private-token"], ["[1,2]"], ["null"],
    [JSON.stringify({ code: "Bearer example-private-token", status: 401.5, status_source: "server", retry_after: "soon", message: "example-private-token" })],
    [JSON.stringify({ code: "x".repeat(65), status: 99 })],
  ])("drops hostile or invalid fields: %s", text => {
    const result = projectFailure(text);
    expect(result.category).toBe("unknown");
    expect(Object.keys(result).sort()).toEqual(["category", "message"]);
    expect(JSON.stringify(result)).not.toContain("example-private-token");
  });
});
