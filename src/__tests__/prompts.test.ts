import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { SubstackClient } from "../api/client.js";
import { PROMPT_NAMES, PUBLICATIONS_RESOURCE_URI, intArg } from "../prompts.js";

afterEach(() => vi.unstubAllGlobals());

const SECRET = "example-session-token-SECRET";

async function connect(keys: string[]) {
  const fetchMock = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  const server = createServer(keys.map(key => ({ key, label: `Label ${key}`, client: new SubstackClient(`https://${key}.substack.com`, SECRET, "1") })));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, server, fetchMock };
}

const promptText = (r: { messages: { content: unknown }[] }) => (r.messages[0].content as { text: string }).text;

describe("prompts", () => {
  it("lists the four workflows and every tool they name is registered", async () => {
    const { client, server, fetchMock } = await connect(["a"]);
    try {
      const prompts = (await client.listPrompts()).prompts.map(p => p.name).sort();
      expect(prompts).toEqual([...PROMPT_NAMES].sort());
      const tools = new Set((await client.listTools()).tools.map(t => t.name));
      const args: Record<string, Record<string, string>> = {
        review_draft: { draft_id: "42" }, what_worked: {}, draft_from_idea: { idea: "agent memory" }, plan_notes: {},
      };
      for (const name of PROMPT_NAMES) {
        const text = promptText(await client.getPrompt({ name, arguments: args[name] }));
        // Every verb-prefixed snake_case word is a tool reference and must exist.
        const named = [...text.matchAll(/\b(?:get|list|create|update|plan|apply|export|preflight|rank|search|upload|restack|publish|delete|schedule|add|send)_[a-z_]+\b/g)].map(m => m[0]);
        expect(named.length, name).toBeGreaterThan(0);
        for (const tool of named) expect(tools.has(tool), `${name} names ${tool}`).toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it("adds a required publication argument only when several publications are configured", async () => {
    const single = await connect(["a"]);
    try {
      const review = (await single.client.listPrompts()).prompts.find(p => p.name === "review_draft")!;
      expect(review.arguments?.map(a => a.name)).toEqual(["draft_id"]);
      expect(promptText(await single.client.getPrompt({ name: "review_draft", arguments: { draft_id: "7" } }))).not.toContain("publication \"");
    } finally { await single.client.close(); await single.server.close(); }

    const multi = await connect(["a", "b"]);
    try {
      const review = (await multi.client.listPrompts()).prompts.find(p => p.name === "review_draft")!;
      expect(review.arguments?.find(a => a.name === "publication")?.required).toBe(true);
      const text = promptText(await multi.client.getPrompt({ name: "review_draft", arguments: { draft_id: "7", publication: "b" } }));
      expect(text).toContain('Pass publication "b" to every Substack tool call.');
    } finally { await multi.client.close(); await multi.server.close(); }
  });

  it("plan_notes never instructs the model to post, because Notes publish immediately", async () => {
    const { client, server } = await connect(["a"]);
    try {
      const text = promptText(await client.getPrompt({ name: "plan_notes", arguments: { count: "3" } }));
      expect(text).toContain("Do not call create_note or create_note_with_link");
      expect(text).not.toMatch(/(?<!not )\b[Cc]all create_note/);
      expect(text).toContain("Plan 3 Substack Notes");
    } finally { await client.close(); await server.close(); }
  });

  it("clamps numeric prompt arguments", () => {
    expect(intArg(undefined, 90, 365)).toBe(90);
    expect(intArg("30", 90, 365)).toBe(30);
    expect(intArg("9999", 90, 365)).toBe(365);
    expect(intArg("-4", 5, 10)).toBe(5);
    expect(intArg("2.5", 5, 10)).toBe(5);
  });
});

describe("publications resource", () => {
  it("lists configured publications from local config, with no request and no credential", async () => {
    const { client, server, fetchMock } = await connect(["a", "b"]);
    try {
      expect((await client.listResources()).resources.map(r => r.uri)).toEqual([PUBLICATIONS_RESOURCE_URI]);
      const read = await client.readResource({ uri: PUBLICATIONS_RESOURCE_URI });
      const text = (read.contents[0] as { text: string }).text;
      expect(JSON.parse(text)).toEqual({
        publication_parameter_required: true,
        publications: [
          { key: "a", label: "Label a", origin: "https://a.substack.com" },
          { key: "b", label: "Label b", origin: "https://b.substack.com" },
        ],
      });
      expect(text).not.toContain(SECRET);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });
});
