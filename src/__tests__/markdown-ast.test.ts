import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { SubstackClient } from "../api/client.js";
import { convertMarkdown, MAX_MARKDOWN_CHARS } from "../utils/markdown-to-prosemirror.js";

const convert = (source: string) => convertMarkdown(source);
const content = (source: string) => convert(source).document.content;

describe("Markdown AST fidelity", () => {
  it("matches the independently authored rich-content golden fixture", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/markdown-rich.json", import.meta.url), "utf8"));
    const result = convert(fixture.markdown);
    expect(result.document).toEqual(fixture.document);
    expect(result.unsupported_nodes).toEqual([]);
    expect(result.source_markdown).toBe(fixture.markdown);
  });

  it("combines nested marks, resolves references, entities and escapes", () => {
    expect(content("[**bold *both***][x] &amp; \\*literal\\*\n\n[x]: https://example.com/a(b)")[0].content).toEqual([
      { type: "text", text: "bold ", marks: [{ type: "link", attrs: { href: "https://example.com/a(b)" } }, { type: "bold" }] },
      { type: "text", text: "both", marks: [{ type: "link", attrs: { href: "https://example.com/a(b)" } }, { type: "bold" }, { type: "italic" }] },
      { type: "text", text: " & *literal*" },
    ]);
  });

  it("keeps images between surrounding text and resolves image references", () => {
    const result = convert('before ![alt][img] after\n\n[img]: https://example.com/a.png "Title"');
    expect(result.unsupported_nodes).toEqual([]);
    expect(result.document.content.map(node => node.type)).toEqual(["paragraph", "captionedImage", "paragraph"]);
    expect(result.document.content[0].content).toEqual([{ type: "text", text: "before " }]);
    expect(result.document.content[2].content).toEqual([{ type: "text", text: " after" }]);
    expect(result.document.content[1].content?.[0].attrs).toMatchObject({ src: "https://example.com/a.png", title: "Title", alt: "alt" });
  });

  it("keeps multiple paragraphs and code in a list item", () => {
    const result = content("3. First\n\n   Second paragraph\n\n   ```js\n   run()\n   ```");
    expect(result[0].attrs).toEqual({ order: 3 });
    expect(result[0].content?.[0].content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "First" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second paragraph" }] },
      { type: "code_block", attrs: { lang: "js" }, content: [{ type: "text", text: "run()" }] },
    ]);
  });

  it("preserves hard breaks, empty code blocks and code containing paywall syntax", () => {
    expect(content("one  \ntwo\\\nthree")[0].content).toEqual([
      { type: "text", text: "one" }, { type: "hard_break" },
      { type: "text", text: "two" }, { type: "hard_break" }, { type: "text", text: "three" },
    ]);
    expect(content("~~~\n~~~")).toEqual([{ type: "code_block", content: [] }]);
    expect(content("`<!-- paywall -->`")[0].content).toEqual([{ type: "text", text: "<!-- paywall -->", marks: [{ type: "code" }] }]);
    expect(content("```\n<!-- paywall -->\n```")[0]).toEqual({ type: "code_block", content: [{ type: "text", text: "<!-- paywall -->" }] });
  });

  it.each([
    "https://substackcdn.com.evil.example/a_800x600.png",
    "https://evil.example/substackcdn.com/a_800x600.png",
    "https://evil.example/a.png?source=substackcdn.com/a_800x600.png",
    "https://substackcdn.com/a_0x600.png",
    "https://substackcdn.com/a_999999999999999999x600.png",
  ])("does not infer dimensions from deceptive or invalid CDN URLs: %s", url => {
    expect(content(`![x](${url})`)[0].content?.[0].attrs).toMatchObject({ width: null, height: null, type: null });
  });

  it.each(["javascript:alert%281%29", "data:text/html,test", "https://user:pass@example.com/a", "/relative"])("reports unsafe or unresolved link/image URLs: %s", url => {
    const input = `[link](${url}) ![alt](${url})`;
    const result = convert(input);
    expect(result.unsupported_nodes.map(node => node.type)).toEqual(["link", "image"]);
    expect(result.document.content[0].content?.some(node => node.marks?.some(mark => mark.type === "link"))).toBe(false);
    expect(result.source_markdown).toBe(input);
    expect(JSON.stringify(result.document)).toContain(url);
  });

  it.each([
    ["| A | B |\n|---|---|\n| x | y |", "table"],
    ["<iframe src=\"https://example.com\"></iframe>", "html"],
    ["ref[^1]\n\n[^1]: Footnote text", "footnoteReference"],
    ["- [x] finished", "listItem"],
    ["```js filename=test.js\ncode\n```", "code"],
    ["[unused]: https://example.com", "definition"],
    ['[link](https://example.com "title")', "link"],
    ["**![alt](https://example.com/a.png)**", "image"],
  ])("reports unsupported constructs with source locations: %s", (source, type) => {
    const result = convert(source);
    expect(result.unsupported_nodes).toEqual(expect.arrayContaining([expect.objectContaining({ type, line: expect.any(Number), column: expect.any(Number) })]));
    expect(result.source_markdown).toBe(source);
  });

  it("keeps a table's exact source, including escaped pipes", () => {
    const source = "| A | B |\n| --- | --- |\n| a\\|b | c |";
    expect(content(source)).toEqual([{ type: "code_block", content: [{ type: "text", text: source }] }]);
  });

  it.each([
    "[a][x]\n\n[x]: javascript:alert%281%29",
    "[x]: javascript:alert%281%29\n\n[a][x]",
    "- [x] [a][ref]\n\n[ref]: https://example.com",
    "| A | B |\n|---|---|\n| [a][ref] | b |\n\n[ref]: https://example.com",
  ])("retains definitions whose references were not converted: %s", source => {
    const result = convert(source);
    const definition = source.split("\n").find(line => /^\[[^\]]+\]:/.test(line))!;
    expect(JSON.stringify(result.document)).toContain(definition);
    expect(result.unsupported_nodes.some(node => node.type === "definition")).toBe(true);
  });

  it("resolves references defined before use, and preserves duplicate definitions", () => {
    const source = "[x]: https://example.com/first\n\n[a][x]\n\n[x]: https://example.com/second";
    const result = convert(source);
    expect(result.document.content[0].content?.[0].marks).toEqual([{ type: "link", attrs: { href: "https://example.com/first" } }]);
    expect(result.document.content[1].content).toEqual([{ type: "text", text: "[x]: https://example.com/second" }]);
    expect(result.unsupported_nodes.map(node => node.type)).toEqual(["definition"]);
  });

  it("retains a valid empty blockquote when its only definition was consumed elsewhere", () => {
    const result = convert("> [x]: https://example.com\n\n[a][x]");
    expect(result.document.content[0]).toEqual({ type: "blockquote", content: [{ type: "paragraph" }] });
    expect(result.unsupported_nodes).toEqual([]);
  });

  it("rejects duplicate paywalls and reports nested or Note paywalls", () => {
    expect(() => convert("<!-- paywall -->\n\n<!-- paywall -->")).toThrow("Only one paywall");
    expect(convert("> <!-- paywall -->").unsupported_nodes[0].reason).toContain("top level");
    expect(convertMarkdown("<!-- paywall -->", "note").unsupported_nodes[0].reason).toContain("long-form drafts");
    expect(convert("\\<!-- paywall -->").document.content[0].type).toBe("paragraph");
  });

  it("bounds input, tree depth, output node count and diagnostics", () => {
    expect(() => convert("x".repeat(MAX_MARKDOWN_CHARS + 1))).toThrow("characters");
    expect(() => convert("> ".repeat(102) + "x")).toThrow("100-level");
    expect(() => convert("![x](https://example.com/a.png)\n\n".repeat(2_501))).toThrow("10,000-node");
    expect(() => convert("<x>\n\n".repeat(101))).toThrow("100 unsupported");
    expect(convert("ordinary content").unsupported_nodes).toEqual([]);
  });
});

afterEach(() => vi.restoreAllMocks());

async function withMcp(run: (mcp: Client, api: SubstackClient) => Promise<void>) {
  const api = new SubstackClient("https://example.substack.com", "test-only", "1");
  const server = createServer([{ key: "example", label: "Example", client: api }]);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "markdown-test", version: "1" });
  await Promise.all([mcp.connect(ct), server.connect(st)]);
  try { await run(mcp, api); } finally { await mcp.close(); await server.close(); }
}

describe("Markdown conversion through MCP", () => {
  const table = "| A | B |\n|---|---|\n| x | y |";
  it.each(["create_draft", "update_draft", "create_note", "create_note_with_link"])("returns an MCP error for hard conversion failures without writing: %s", async name => {
    await withMcp(async (mcp, api) => {
      const writes = [vi.spyOn(api, "createDraft"), vi.spyOn(api, "updateDraft"), vi.spyOn(api, "createNote"), vi.spyOn(api, "createNoteAttachment")];
      for (const body of ["x".repeat(MAX_MARKDOWN_CHARS + 1), "> ".repeat(102) + "x"]) {
        const result = await mcp.callTool({ name, arguments: { title: "Test", draft_id: 42, body, url: "https://example.com", allow_unsupported: true } });
        expect(result.isError).toBe(true);
        expect((result.content as { text: string }[])[0].text).toMatch(/exceeds/);
      }
      for (const spy of writes) expect(spy).not.toHaveBeenCalled();
    });
  });
  it.each(["create_draft", "update_draft"])("requires explicit fallback acknowledgment for %s", async name => {
    await withMcp(async (mcp, api) => {
      const create = vi.spyOn(api, "createDraft").mockResolvedValue({ id: 42, draft_title: "Test" } as never);
      const update = vi.spyOn(api, "updateDraft").mockResolvedValue({ id: 42, draft_title: "Test" } as never);
      const args = { title: "Test", draft_id: 42, body: table };
      const result = await mcp.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ code: "unsupported_markdown", unsupported_nodes: [{ type: "table", line: 1, column: 1 }] });
      expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
      const acknowledged = await mcp.callTool({ name, arguments: { ...args, allow_unsupported: true } });
      expect(acknowledged.isError).toBeFalsy();
      expect(JSON.parse((acknowledged.content as { text: string }[])[0].text).unsupported_nodes[0].type).toBe("table");
      const written = name === "create_draft" ? create.mock.calls[0][1] : update.mock.calls[0][1].draft_body;
      expect(JSON.parse(String(written)).content).toEqual([{ type: "code_block", content: [{ type: "text", text: table }] }]);
      expect(create.mock.calls.length + update.mock.calls.length).toBe(1);
    });
  });

  it.each(["create_note", "create_note_with_link"])("validates %s before any Note or attachment write", async name => {
    await withMcp(async (mcp, api) => {
      const attachment = vi.spyOn(api, "createNoteAttachment").mockResolvedValue({ id: "attachment" } as never);
      const note = vi.spyOn(api, "createNote").mockResolvedValue({ id: 12 } as never);
      for (const body of [table, "<!-- paywall -->", "<iframe></iframe>"]) {
        const result = await mcp.callTool({ name, arguments: { body, url: "https://example.com", allow_unsupported: true } });
        expect(result.isError).toBe(true);
        expect(JSON.parse((result.content as { text: string }[])[0].text).code).toBe("unsupported_markdown");
      }
      expect(attachment).not.toHaveBeenCalled(); expect(note).not.toHaveBeenCalled();
      const result = await mcp.callTool({ name, arguments: { body: "Hello **world**", url: "https://example.com" } });
      expect(result.isError).toBeFalsy();
      expect(note).toHaveBeenCalledTimes(1);
      expect(note.mock.calls[0][0]).toEqual({ type: "doc", attrs: { schemaVersion: "v1" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world", marks: [{ type: "bold" }] }] }] });
      expect(attachment).toHaveBeenCalledTimes(name === "create_note_with_link" ? 1 : 0);
    });
  });

  it("writes supported rich content and an explicit empty body without fallback flags", async () => {
    await withMcp(async (mcp, api) => {
      const create = vi.spyOn(api, "createDraft").mockResolvedValue({ id: 42 } as never);
      const fixture = JSON.parse(readFileSync(new URL("./fixtures/markdown-rich.json", import.meta.url), "utf8"));
      const result = await mcp.callTool({ name: "create_draft", arguments: { title: "Test", body: fixture.markdown } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(create.mock.calls[0][1]!)).toEqual(fixture.document);
      await mcp.callTool({ name: "create_draft", arguments: { title: "Empty", body: "" } });
      expect(JSON.parse(create.mock.calls[1][1]!)).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    });
  });
});
