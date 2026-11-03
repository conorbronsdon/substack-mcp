import { describe, it, expect } from "vitest";
import { prosemirrorToMarkdown } from "../utils/prosemirror-to-markdown.js";
import { convertMarkdown } from "../utils/markdown-to-prosemirror.js";
import { preflightDraft } from "../utils/draft-preflight.js";

type Mark = { type: string; attrs?: { href: string } };
type Text = { type: "text"; text: string; marks?: Mark[] };

// One run of text with one mark set; adjacent runs with equal sets are one run.
const key = (marks: Mark[] = []) => marks.map(m => m.type === "link" ? `link:${m.attrs!.href}` : m.type).sort().join("|");
function runs(paragraph: { content?: Text[] }): [string, string][] {
  const out: [string, string][] = [];
  for (const node of paragraph.content ?? []) {
    const k = key(node.marks);
    if (out.length && out[out.length - 1][1] === k) out[out.length - 1][0] += node.text;
    else out.push([node.text, k]);
  }
  return out;
}
// 2,520 of 3,000 seeded cases convert exactly; per-run wrapping managed under 1,000.
const CONVERTED_FLOOR = 2000;
const paragraph = (content: Text[]) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content }] });
function roundTrip(content: Text[]) {
  const exported = prosemirrorToMarkdown(paragraph(content));
  const reimported = convertMarkdown(exported.markdown!);
  return { exported, reimported, paragraphs: reimported.document.content as { type: string; content?: Text[] }[] };
}
const t = (text: string, ...marks: (string | Mark)[]): Text => ({ type: "text", text, marks: marks.map(m => typeof m === "string" ? { type: m } : m) });

describe("export keeps marks that span adjacent text nodes", () => {
  it.each([
    ["**bold *italic* bold**", "**bold *italic* bold**"],
    ["**a *b***", "**a *b***"],
    ["**a `b`**", "**a `b`**"],
    ["~~strike `code` x~~", "~~strike `code` x~~"],
    ["**[link](https://e.com) after**", "**[link](https://e.com) after**"],
    ["[a **b** c](https://e.com)", "[a **b** c](https://e.com)"],
  ])("round-trips %s", (markdown, expected) => {
    const first = convertMarkdown(markdown);
    expect(first.unsupported_nodes).toEqual([]);
    const exported = prosemirrorToMarkdown(JSON.stringify(first.document));
    expect(exported.status).toBe("converted");
    expect(exported.markdown!.trim()).toBe(expected);
    const again = convertMarkdown(exported.markdown!);
    expect(again.document).toEqual(first.document);
  });

  it("marks plain-text URLs partial because Markdown reimport would autolink them", () => {
    const exported = prosemirrorToMarkdown(paragraph([t("see https://example.com/x and www.example.org or me@example.com")]));
    expect(exported.status).toBe("partial");
    expect(exported.unsupported_nodes).toEqual([expect.objectContaining({ type: "marks" })]);
  });

  it("does not stack a mark twice when Markdown nests the same emphasis", () => {
    for (const [markdown, type] of [["**a **b** c**", "bold"], ["*a *b* c*", "italic"], ["~~a ~~b~~ c~~", "strikethrough"]] as const) {
      const nodes = (convertMarkdown(markdown).document.content[0] as { content: Text[] }).content;
      for (const node of nodes) expect(node.marks).toEqual([{ type }]);
    }
  });

  it("round-trips random mark combinations across adjacent text nodes", () => {
    let seed = 0x5eed;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const words = ["alpha", "beta", "gamma", "delta"] as const;
    const links = ["https://example.com/a", "https://example.com/b"] as const;
    const failures: string[] = [];
    let converted = 0;
    for (let trial = 0; trial < 3000; trial++) {
      const content: Text[] = [];
      const count = 1 + Math.floor(random() * 5);
      for (let i = 0; i < count; i++) {
        const marks: Mark[] = [];
        for (const type of ["bold", "italic", "strikethrough", "code"]) if (random() < 0.4) marks.push({ type });
        if (random() < 0.3) marks.push({ type: "link", attrs: { href: pick(links) } });
        // Runs touch directly, often sharing marks with their neighbours.
        content.push(t(pick(words), ...marks.sort(() => random() - 0.5)));
      }
      const input = content;
      const { exported, reimported, paragraphs } = roundTrip(input);
      if (exported.status !== "converted") { expect(exported.status).toBe("partial"); continue; }
      converted++;
      const ok = reimported.unsupported_nodes.length === 0 && paragraphs.length === 1 &&
        JSON.stringify(runs(paragraphs[0])) === JSON.stringify(runs({ content: input }));
      if (!ok) failures.push(exported.markdown!);
    }
    // A "converted" export must reimport to the same text and marks.
    expect(failures.slice(0, 5)).toEqual([]);
    // Shared marks across runs must stay expressible; before grouping, most were not.
    expect(converted).toBeGreaterThan(CONVERTED_FLOOR);
  }, 30_000);
});

describe("preflight recognizes footnotes produced by Markdown conversion", () => {
  it("does not warn about footnote nodes", () => {
    const doc = convertMarkdown("Claim[^1].\n\n[^1]: Source.").document;
    const result = preflightDraft({ id: 7, draft_body: JSON.stringify(doc) }, 7);
    expect(JSON.stringify(result.findings)).not.toMatch(/footnote/);
  });
});
