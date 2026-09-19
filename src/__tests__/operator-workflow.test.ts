import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperator } from "../operator-cli.js";
import { convertMarkdown } from "../utils/markdown-to-prosemirror.js";
import { SubstackClient } from "../api/client.js";

const credentials = { key: "example", label: "Example", publicationUrl: "https://example.substack.com", sessionToken: "example-private-token", userId: "1", source: "env" as const, missing: [] };
const second = { ...credentials, key: "second", publicationUrl: "https://second.substack.com" };
const io = () => ({ out: vi.fn(), error: vi.fn() });
const dir = mkdtempSync(join(tmpdir(), "substack-operator-workflow-"));
const file = (name: string, content: string | Buffer) => { const path = join(dir, name); writeFileSync(path, content); return path; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("operator draft workflow commands", () => {
  it("creates one private draft from a Markdown file and returns its editor link", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ id: 77, draft_title: "Launch notes" }));
    vi.stubGlobal("fetch", fetch);
    const path = file("post.md", ["# Heading kept", "", "Hello **world**."].join("\n"));
    const output = io();
    expect(await runOperator(["drafts", "create", path, "--title", "Launch notes", "--subtitle", "Sub", "--audience", "only_free"], () => [credentials], output)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe("/api/v1/drafts");
    expect(init?.method).toBe("POST");
    const payload = JSON.parse(init!.body as string);
    expect(payload).toMatchObject({ draft_title: "Launch notes", draft_subtitle: "Sub", audience: "only_free", type: "newsletter" });
    expect(payload.draft_body).toContain("Heading kept");
    expect(output.error).not.toHaveBeenCalled();
    expect(JSON.parse(output.out.mock.calls[0][0])).toEqual({ format_version: 1, ok: true, command: "drafts create", publication: "example",
      data: { id: 77, title: "Launch notes", unsupported_nodes: [], message: expect.any(String), editor_url: "https://example.substack.com/publish/post/77" } });
  });

  it("stops unsupported Markdown before any request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const path = file("table.md", ["| A | B |", "|---|---|", "| x | y |"].join("\n"));
    const output = io();
    expect(await runOperator(["drafts", "create", path, "--title", "T"], () => [credentials], output)).toBe(1);
    expect(fetch).not.toHaveBeenCalled(); expect(output.out).not.toHaveBeenCalled();
    const result = JSON.parse(output.error.mock.calls[0][0]);
    expect(result).toMatchObject({ format_version: 1, ok: false, command: "drafts create", code: "unsupported_markdown", write_attempts: 0 });
    expect(result.unsupported_nodes.length).toBeGreaterThan(0);
    for (const node of result.unsupported_nodes) expect(Object.keys(node).sort()).toEqual(["column", "line", "reason", "type"]);
  });

  it("returns every conversion diagnostic, not a truncated subset", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const markdown = Array.from({ length: 60 }, (_, i) => "- [ ] task " + i).join(String.fromCharCode(10));
    const expected = convertMarkdown(markdown).unsupported_nodes.length;
    expect(expected).toBeGreaterThan(50); expect(expected).toBeLessThanOrEqual(100);
    const output = io();
    expect(await runOperator(["drafts", "create", file("many.md", markdown), "--title", "T"], () => [credentials], output)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0]).unsupported_nodes).toHaveLength(expected);
  });

  it("writes literal fallbacks only when unsupported Markdown is explicitly allowed", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ id: 78, draft_title: "T" }));
    vi.stubGlobal("fetch", fetch);
    const path = file("allowed.md", ["| A | B |", "|---|---|", "| x | y |"].join("\n"));
    const output = io();
    expect(await runOperator(["drafts", "create", path, "--title", "T", "--allow-unsupported"], () => [credentials], output)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output.out.mock.calls[0][0]).data.unsupported_nodes.length).toBeGreaterThan(0);
  });

  it.each([
    ["missing", () => join(dir, "missing.md")],
    ["directory", () => dir],
    ["oversized", () => file("large.md", "x".repeat(1024 * 1024 + 1))],
    ["invalid UTF-8", () => file("invalid.md", Buffer.from([0x66, 0xff, 0xfe]))],
  ])("rejects a %s Markdown file before loading credentials", async (_name, path) => {
    const fetch = vi.fn(), load = vi.fn(); vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["drafts", "create", path(), "--title", "T"], load, output)).toBe(2);
    expect(load).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(output.out).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ format_version: 1, ok: false, command: "drafts create", code: "invalid_input_file" });
  });

  it("rejects a symbolic-link Markdown file before loading credentials", async context => {
    const target = file("linked-target.md", "Hello");
    const path = join(dir, "linked.md");
    try { symlinkSync(target, path, "file"); } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { context.skip(); return; }
      throw error;
    }
    const fetch = vi.fn(), load = vi.fn(), output = io(); vi.stubGlobal("fetch", fetch);
    expect(await runOperator(["drafts", "create", path, "--title", "T"], load, output)).toBe(2);
    expect(load).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(output.out).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ code: "invalid_input_file" });
  });

  it("admits a 1 MiB file, then applies the converter's own bound before any request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["drafts", "create", file("limit.md", "x".repeat(1024 * 1024)), "--title", "T", "--allow-unsupported"], () => [credentials], output)).toBe(1);
    expect(fetch).not.toHaveBeenCalled(); expect(output.out).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toEqual({ format_version: 1, ok: false, command: "drafts create", code: "markdown_conversion_failed", write_attempts: 0, message: expect.stringContaining("No draft was written.") });
  });

  it.each([
    [["drafts", "create", "post.md"]],
    [["drafts", "create", "post.md", "--title", "   "]],
    [["drafts", "create", "post.md", "--title", "x".repeat(1001)]],
    [["drafts", "create", "post.md", "--title", "T", "--publish"]],
    [["drafts", "create", "post.md", "--title", "A", "--title", "B"]],
    [["drafts", "create", "post.md", "--title", "T", "--audience", "public"]],
    [["drafts", "create", "--title", "T"]],
    [["drafts", "create", "post.md", "extra", "--title", "T"]],
    [["posts", "search"]],
    [["posts", "search", "   "]],
    [["posts", "search", "hello", "--limit", "51"]],
    [["posts", "search", "hello", "--status", "archived"]],
    [["posts", "search", "hello", "world"]],
    [["posts", "list"]],
    [["drafts", "preflight", "0"]],
    [["drafts", "preflight", "42", "--limit", "1"]],
  ])("rejects invalid workflow arguments before reading files or credentials: %j", async args => {
    const load = vi.fn(), output = io();
    expect(await runOperator(args, load, output)).toBe(2);
    expect(load).not.toHaveBeenCalled(); expect(output.out).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ format_version: 1, ok: false, code: "invalid_arguments" });
  });

  it("requires a configured publication before creating a draft", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const path = file("select.md", "Hello");
    for (const extra of [[], ["--publication", "missing"]]) {
      const output = io();
      expect(await runOperator(["drafts", "create", path, "--title", "T", ...extra], () => [credentials, second], output)).toBe(2);
      expect(JSON.parse(output.error.mock.calls[0][0]).code).toBe("publication_required");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates on the selected publication only", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ id: 80, draft_title: "T" }));
    vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["drafts", "create", file("second.md", "Hello"), "--title", "T", "--publication", "second"], () => [credentials, second], output)).toBe(0);
    expect(new URL(String(fetch.mock.calls[0][0])).origin).toBe("https://second.substack.com");
    expect(JSON.parse(output.out.mock.calls[0][0])).toMatchObject({ publication: "second", data: { editor_url: "https://second.substack.com/publish/post/80" } });
  });

  it("reports an ambiguous create failure as unverified without retrying or printing upstream text", async () => {
    const fetch = vi.fn(async () => new Response("private-body-marker", { status: 500 })); vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["drafts", "create", file("fail.md", "Hello"), "--title", "T"], () => [credentials], output)).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1); expect(output.out).not.toHaveBeenCalled();
    const line = output.error.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toMatchObject({ format_version: 1, ok: false, command: "drafts create", code: "write_unverified", category: "upstream_unavailable", status: 500 });
    expect(JSON.parse(line).message).toContain("drafts list");
    expect(line).not.toContain("private-body-marker"); expect(line).not.toContain(credentials.sessionToken);
  });

  it("reports create configuration failures as not attempted", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["drafts", "create", file("config.md", "Hello"), "--title", "T"], () => { throw new Error("example-private-token"); }, output)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    const line = output.error.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toMatchObject({ code: "write_not_attempted", category: "configuration" });
    expect(JSON.parse(line).message).toContain("No write was attempted.");
    expect(line).not.toContain("example-private-token");
  });

  it("searches one bounded page with the shared continuation metadata", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ posts: [{ id: 5, draft_title: "Hello draft" }], total: 1 }));
    vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["posts", "search", " hello ", "--status", "drafts", "--offset", "0", "--limit", "10"], () => [credentials], output)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/post_management/drafts");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ query: "hello", offset: "0", limit: "10" });
    expect(fetch.mock.calls[0][1]?.method ?? "GET").toBe("GET");
    expect(JSON.parse(output.out.mock.calls[0][0])).toMatchObject({ format_version: 1, ok: true, command: "posts search", publication: "example",
      data: { query: "hello", status: "drafts", returned: 1, total: 1, has_more: false, next_offset: null, posts: [{ id: 5 }] } });
  });

  it("keeps read failure categories for search", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-body-marker", { status: 401 })));
    const output = io();
    expect(await runOperator(["posts", "search", "hello"], () => [credentials], output)).toBe(1);
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ code: "read_failed", category: "authentication", status: 401 });
  });

  it("preflights a draft with one read and returns the editor link", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const read = vi.spyOn(SubstackClient.prototype, "getDraft").mockResolvedValue({ id: 42, draft_title: "T", audience: "everyone",
      draft_body: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] }) } as never);
    const output = io();
    expect(await runOperator(["drafts", "preflight", "42"], () => [credentials], output)).toBe(0);
    expect(read).toHaveBeenCalledExactlyOnceWith(42); expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(output.out.mock.calls[0][0])).toMatchObject({ ok: true, command: "drafts preflight", publication: "example",
      data: { draft_id: 42, checks_passed: expect.any(Boolean), editor_url: "https://example.substack.com/publish/post/42" } });
  });

  it.each([[["drafts", "create", "--help"]], [["posts", "--help"]], [["posts", "search", "--help"]], [["drafts", "preflight", "--help"]]])("shows workflow help offline: %j", async args => {
    const load = vi.fn(), output = io();
    expect(await runOperator(args, load, output)).toBe(0);
    expect(load).not.toHaveBeenCalled();
    expect(output.out.mock.calls[0][0]).toContain("drafts create <markdown-file>");
    expect(output.out.mock.calls[0][0]).toContain("Read-only JSON");
  });
});
