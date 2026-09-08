import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../server.js";
import { SubstackClient } from "../api/client.js";
import { startHttpServer } from "../transport/http.js";
import { runDrafts } from "../draft-cli.js";
import { convertMarkdown, MAX_MARKDOWN_CHARS } from "../utils/markdown-to-prosemirror.js";
import type { DraftChangePlan } from "../api/draft-changes.js";

const credentials = { key: "example", label: "Example", publicationUrl: "https://example.substack.com", sessionToken: "test-only", userId: "1", source: "env" as const, missing: [] };
const nativeFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    expect(dir.startsWith(join(tmpdir(), "substack-guard-test-"))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }
});
function fixture() {
  let state = { id: 42, publication_id: 7, is_published: false, draft_title: "Before", draft_subtitle: null, draft_body: JSON.stringify(convertMarkdown("Body").document), audience: "everyone", draft_updated_at: "2026-09-07T00:00:00Z" };
  const requests: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let mode: "normal" | "conflict" | "readback_failure" = "normal", written = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return nativeFetch(input, init);
    const method = init?.method ?? "GET", body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, body });
    if (url.endsWith("/publication")) return Response.json({ id: 7, name: "Example", subdomain: "example" });
    if (method === "PUT") { state = { ...state, ...body, draft_updated_at: "2026-09-07T00:01:00Z" }; written = true; if (mode === "conflict") state.draft_title = "Editor changed it"; return Response.json(state); }
    if (written && mode === "readback_failure") return new Response("Unavailable", { status: 503 });
    return Response.json(state);
  }));
  const publications = () => [{ key: "example", label: "Example", client: new SubstackClient(credentials.publicationUrl, "test-only", "1") }];
  return { requests, publications, edit: () => { state.draft_title = "Editor changed it"; }, mode: (value: typeof mode) => { mode = value; }, title: () => state.draft_title };
}
async function withMcp(run: (client: Client) => Promise<void>, publications: ReturnType<ReturnType<typeof fixture>["publications"]>) {
  const server = createServer(publications), mcp = new Client({ name: "draft-flow-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(ct), server.connect(st)]);
  try { await run(mcp); } finally { await mcp.close(); await server.close(); }
}
function resultBody(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as { text: string }[])[0].text);
}
async function scratch() { const dir = await mkdtemp(join(tmpdir(), "substack-guard-test-")); dirs.push(dir); return dir; }
const io = () => ({ out: vi.fn(), error: vi.fn() });

describe("MCP draft plan/apply", () => {
  it("requires a receipt, rejects unknown fields, and declares output and read annotations", async () => {
    const f = fixture();
    await withMcp(async mcp => {
      const tools = (await mcp.listTools()).tools;
      expect(tools.find(t => t.name === "plan_draft_update")?.annotations?.readOnlyHint).toBe(true);
      expect(tools.find(t => t.name === "update_draft")?.inputSchema.required).toContain("receipt");
      expect(tools.find(t => t.name === "plan_draft_update")?.outputSchema).toBeDefined();
      expect((await mcp.callTool({ name: "update_draft", arguments: { draft_id: 42, title: "After" } })).isError).toBe(true);
      expect((await mcp.callTool({ name: "plan_draft_update", arguments: { draft_id: 42, title: "After", publish: true } })).isError).toBe(true);
      expect(f.requests).toEqual([]);
    }, f.publications());
  });
  it("plans and applies exact acknowledged Markdown across separate server instances", async () => {
    const f = fixture(), body = "| A | B |\n|---|---|\n| x | y |";
    const input = { draft_id: 42, title: "After", body };
    let plan: DraftChangePlan;
    await withMcp(async mcp => {
      const blocked = await mcp.callTool({ name: "plan_draft_update", arguments: input });
      expect(blocked.isError).toBe(true); expect(resultBody(blocked).code).toBe("unsupported_markdown");
      expect(f.requests).toEqual([]);
      const result = await mcp.callTool({ name: "plan_draft_update", arguments: { ...input, allow_unsupported: true } });
      expect(result.isError).toBeFalsy(); plan = resultBody(result);
      expect(result.structuredContent).toEqual(plan);
      expect(plan.unsupported_nodes[0].type).toBe("table");
      expect(f.requests.every(r => r.method === "GET")).toBe(true);
    }, f.publications());
    await withMcp(async mcp => {
      const rejected = await mcp.callTool({ name: "update_draft", arguments: { ...input, allow_unsupported: false, receipt: plan.receipt } });
      expect(rejected.isError).toBe(true);
      const result = await mcp.callTool({ name: "update_draft", arguments: { ...input, allow_unsupported: true, receipt: plan.receipt } });
      expect(resultBody(result)).toMatchObject({ status: "verified", write_attempts: 1 });
      expect(result.structuredContent).toEqual(resultBody(result));
    }, f.publications());
    const writes = f.requests.filter(r => r.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0].body?.draft_body)).content).toEqual([{ type: "code_block", content: [{ type: "text", text: body }] }]);
  });
  it("rejects stale state, changed payload and hard conversion failures before PUT", async () => {
    const f = fixture();
    await withMcp(async mcp => {
      const input = { draft_id: 42, title: "After" };
      const plan = resultBody(await mcp.callTool({ name: "plan_draft_update", arguments: input }));
      for (const body of ["x".repeat(MAX_MARKDOWN_CHARS + 1), "> ".repeat(102) + "x"]) {
        expect((await mcp.callTool({ name: "update_draft", arguments: { ...input, body, receipt: plan.receipt } })).isError).toBe(true);
      }
      expect(resultBody(await mcp.callTool({ name: "update_draft", arguments: { ...input, title: "Different", receipt: plan.receipt } })).code).toBe("payload_changed");
      f.edit();
      expect(resultBody(await mcp.callTool({ name: "update_draft", arguments: { ...input, receipt: plan.receipt } })).code).toBe("stale_draft");
      expect(f.requests.filter(r => r.method === "PUT")).toHaveLength(0);
      expect(f.title()).toBe("Editor changed it");
    }, f.publications());
  });
  it("requires explicit multi-publication selection before any API calls", async () => {
    const f = fixture(), pubs = [...f.publications(), { key: "other", label: "Other", client: new SubstackClient("https://other.substack.com", "test-only", "1") }];
    await withMcp(async mcp => {
      for (const publication of [undefined, "missing"]) expect((await mcp.callTool({ name: "plan_draft_update", arguments: { draft_id: 42, title: "After", ...(publication ? { publication } : {}) } })).isError).toBe(true);
      expect(f.requests).toEqual([]);
      expect((await mcp.callTool({ name: "plan_draft_update", arguments: { draft_id: 42, title: "After", publication: "example" } })).isError).toBeFalsy();
      expect(f.requests.every(r => r.url.startsWith(credentials.publicationUrl))).toBe(true);
    }, pubs);
  });
  it("works through stateless HTTP with a new server for each request", async () => {
    const f = fixture(), factory = vi.fn(() => createServer(f.publications()));
    const http = startHttpServer(factory, 0, "127.0.0.1");
    await new Promise<void>(resolve => http.once("listening", resolve));
    const client = new Client({ name: "draft-http-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`)));
      const input = { draft_id: 42, title: "After" };
      const plan = resultBody(await client.callTool({ name: "plan_draft_update", arguments: input }));
      const result = await client.callTool({ name: "update_draft", arguments: { ...input, receipt: plan.receipt } });
      expect(resultBody(result)).toMatchObject({ status: "verified", write_attempts: 1 });
      expect(factory.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(f.requests.filter(r => r.method === "PUT")).toHaveLength(1);
    } finally { await client.close(); await new Promise<void>(resolve => http.close(() => resolve())); }
  });
});

describe("draft CLI", () => {
  it("has offline help and rejects invalid arguments before configuration", async () => {
    const load = vi.fn(() => [credentials]), output = io();
    expect(await runDrafts(["--help"], load, output)).toBe(0);
    for (const args of [[], ["publish"], ["plan"], ["apply", "--input", "x"], ["plan", "--input", "x", "--plan", "y"], ["plan", "--input", "x", "--input", "y"]]) expect(await runDrafts(args, load, output)).toBe(2);
    expect(load).not.toHaveBeenCalled();
  });
  it.each(["not JSON", JSON.stringify({ draft_id: 42, publish: true }), "x".repeat(1024 * 1024 + 1)])("rejects invalid or oversized file input without API calls", async content => {
    const f = fixture(), dir = await scratch(), path = join(dir, "changes.json");
    await writeFile(path, content); expect(await runDrafts(["plan", "--input", path], () => [credentials], io())).toBe(2);
    expect(f.requests).toEqual([]);
  });
  it.each(["normal", "conflict", "readback_failure"] as const)("shares core logic and returns the documented %s exit", async mode => {
    const f = fixture(), dir = await scratch(), input = join(dir, "changes.json"), planPath = join(dir, "plan.json"), output = io();
    await writeFile(input, JSON.stringify({ draft_id: 42, title: "After" }));
    expect(await runDrafts(["plan", "--input", input], () => [credentials], output)).toBe(0);
    const plan = JSON.parse(output.out.mock.calls[0][0]); await writeFile(planPath, JSON.stringify(plan));
    expect(f.requests.filter(r => r.method === "PUT")).toHaveLength(0);
    f.mode(mode); output.out.mockClear();
    expect(await runDrafts(["apply", "--input", input, "--plan", planPath], () => [credentials], output)).toBe(mode === "normal" ? 0 : mode === "conflict" ? 4 : 3);
    expect(JSON.parse(output.out.mock.calls[0][0]).status).toBe(mode === "normal" ? "verified" : mode === "conflict" ? "conflict" : "unverified");
    expect(f.requests.filter(r => r.method === "PUT")).toHaveLength(1);
    expect(output.out.mock.calls[0][0]).not.toContain("test-only");
  });
  it("rejects changed files and ambiguous publication selection without writing", async () => {
    const f = fixture(), dir = await scratch(), input = join(dir, "changes.json"), planPath = join(dir, "plan.json"), output = io();
    await writeFile(input, JSON.stringify({ draft_id: 42, title: "After" }));
    expect(await runDrafts(["plan", "--input", input], () => [credentials, { ...credentials, key: "other" }], output)).toBe(1);
    expect(f.requests).toEqual([]);
    expect(await runDrafts(["plan", "--input", input], () => [credentials], output)).toBe(0);
    await writeFile(planPath, output.out.mock.calls[0][0]); await writeFile(input, JSON.stringify({ draft_id: 42, title: "Changed after review" }));
    expect(await runDrafts(["apply", "--input", input, "--plan", planPath], () => [credentials], output)).toBe(1);
    expect(JSON.parse(output.error.mock.calls.at(-1)![0]).code).toBe("payload_changed");
    expect(f.requests.filter(r => r.method === "PUT")).toHaveLength(0);
  });
});
