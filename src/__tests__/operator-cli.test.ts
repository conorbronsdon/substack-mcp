import { afterEach, describe, expect, it, vi } from "vitest";
import { runOperator, runStatus } from "../operator-cli.js";
import packageMetadata from "../../package.json" with { type: "json" };
import { SubstackClient } from "../api/client.js";

const credentials = { key: "example", label: "Example", publicationUrl: "https://example.substack.com", sessionToken: "synthetic-private-token", userId: "1", source: "env" as const, missing: [] };
const io = () => ({ out: vi.fn(), error: vi.fn() });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
    ["drafts", "list", "--offset", "-1"], ["drafts", "list", "--json", "--json"],
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
    vi.spyOn(SubstackClient.prototype, "getDraft").mockRejectedValue(new Error("synthetic-private-token private-body-marker"));
    const output = io(); expect(await runOperator(["drafts", "get", "42"], () => [credentials], output)).toBe(1);
    expect(output.out).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0]).code).toBe("read_failed");
    expect(output.error.mock.calls[0][0]).not.toMatch(/synthetic-private-token|private-body-marker/);
  });
  it("rejects oversized output without printing a partial private result", async () => {
    vi.spyOn(SubstackClient.prototype, "getDraft").mockResolvedValue({ id: 42, draft_body: "x".repeat(4 * 1024 * 1024) } as never);
    const output = io(); expect(await runOperator(["drafts", "get", "42"], () => [credentials], output)).toBe(1);
    expect(output.out).not.toHaveBeenCalled();
  });
});
