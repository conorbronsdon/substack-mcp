import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { SubstackClient } from "../api/client.js";
import { normalizePrepublish, runSubstackCheck } from "../utils/draft-preflight.js";
import { objectOutputSchemas } from "../output-contracts.js";

afterEach(() => vi.unstubAllGlobals());

const body = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Content" }] }] });
const draft = { id: 42, draft_title: "A draft", audience: "everyone", draft_body: body };

async function preflight(prepublish: () => Response, args: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith("/api/v1/drafts/42/prepublish") ? prepublish() : new Response(JSON.stringify(draft)));
  vi.stubGlobal("fetch", fetchMock);
  const server = createServer([{ key: "a", label: "a", client: new SubstackClient("https://a.substack.com", "example-session-token", "1") }]);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name: "preflight_draft", arguments: { draft_id: 42, ...args } });
    const parsed = JSON.parse((result.content as { text: string }[])[0].text);
    return { result, parsed, urls: fetchMock.mock.calls.map(c => String(c[0])), methods: fetchMock.mock.calls.map(c => (c[1] as RequestInit | undefined)?.method ?? "GET") };
  } finally { await client.close(); await server.close(); }
}

describe("preflight_draft substack_check", () => {
  it("makes no prepublish request unless asked, keeping the default output unchanged", async () => {
    const { parsed, urls } = await preflight(() => new Response("{}"), {});
    expect(urls).toEqual(["https://a.substack.com/api/v1/drafts/42"]);
    expect(parsed).not.toHaveProperty("substack_check");
    expect(parsed.checks_passed).toBe(true);
  });

  it("reports Substack's errors and suggestions separately from the static findings, with reads only", async () => {
    const { result, parsed, urls, methods } = await preflight(() => new Response(JSON.stringify({
      errors: ["Add a subtitle before publishing"],
      suggestions: [{ message: "Consider adding a cover image" }, { code: "no_tags" }, "", 7],
    })), { substack_check: true });
    expect(result.isError).toBeFalsy();
    expect(urls).toEqual(["https://a.substack.com/api/v1/drafts/42", "https://a.substack.com/api/v1/drafts/42/prepublish"]);
    expect(methods).toEqual(["GET", "GET"]);
    expect(parsed.findings).toEqual([]);
    expect(parsed.checks_passed).toBe(true);
    expect(parsed.substack_check).toMatchObject({
      status: "ok",
      errors: ["Add a subtitle before publishing"],
      suggestions: ["Consider adding a cover image", "no_tags"],
    });
    expect(objectOutputSchemas.preflight_draft.safeParse(parsed).success).toBe(true);
  });

  it("degrades to unavailable when the undocumented endpoint fails, and still returns the static checks", async () => {
    const { result, parsed } = await preflight(() => new Response("not found", { status: 404 }), { substack_check: true });
    expect(result.isError).toBeFalsy();
    expect(parsed.checks_passed).toBe(true);
    expect(parsed.substack_check).toMatchObject({ status: "unavailable", reason: "http_404" });
    expect(objectOutputSchemas.preflight_draft.safeParse(parsed).success).toBe(true);
  });
});

describe("normalizePrepublish", () => {
  it("treats an unexpected shape as unavailable instead of guessing", () => {
    expect(normalizePrepublish({ ok: true })).toMatchObject({ status: "unavailable", reason: "unexpected_response" });
    expect(normalizePrepublish(null)).toMatchObject({ status: "unavailable" });
    for (const raw of [
      { errors: "example upstream error", suggestions: [] },
      { errors: [], suggestions: { message: "example suggestion" } },
      { errors: null, suggestions: [] },
      { suggestions: [] },
      { suggestions: [], validation_errors: ["example hidden error"] },
      { errors: [7] },
      { errors: [["example error"]] },
      { errors: [{ message: { text: "example error" } }] },
      { errors: ["\n\u0000"] },
    ]) expect(normalizePrepublish(raw)).toMatchObject({ status: "unavailable", reason: "unexpected_response" });
    expect(normalizePrepublish({ errors: [] })).toMatchObject({ status: "ok", errors: [], suggestions: [] });
  });

  it("bounds item count and length and strips control characters", () => {
    const long = "x".repeat(400);
    const out = normalizePrepublish({ errors: [`line\nbreak\u0000`, long, ...Array.from({ length: 60 }, (_, i) => `e${i}`)] });
    if (out.status !== "ok") throw new Error("expected ok");
    expect(out.errors[0]).toBe("line break");
    expect(out.errors[1]).toHaveLength(300);
    expect(out.errors).toHaveLength(50);
  });

  it("reports a network failure without an HTTP status as request_failed", async () => {
    expect(await runSubstackCheck(async () => { throw new Error("socket hang up"); })).toMatchObject({ status: "unavailable", reason: "request_failed" });
  });
});
