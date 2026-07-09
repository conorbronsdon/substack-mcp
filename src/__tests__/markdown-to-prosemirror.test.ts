import { describe, it, expect } from "vitest";
import {
  markdownToProseMirror,
  markdownToProseMirrorContent,
  parseInline,
} from "../utils/markdown-to-prosemirror.js";

/** Helper: parse markdown and return the doc object */
function parse(md: string) {
  return JSON.parse(markdownToProseMirror(md));
}

describe("markdownToProseMirror", () => {
  describe("paragraphs", () => {
    it("converts plain text to a paragraph node", () => {
      const doc = parse("Hello world");
      expect(doc.type).toBe("doc");
      expect(doc.content).toHaveLength(1);
      expect(doc.content[0].type).toBe("paragraph");
      expect(doc.content[0].content[0]).toEqual({
        type: "text",
        text: "Hello world",
      });
    });

    it("returns an empty paragraph for blank input", () => {
      const doc = parse("");
      expect(doc.content).toEqual([{ type: "paragraph" }]);
    });
  });

  describe("headings", () => {
    it.each([1, 2, 3, 4, 5, 6])("converts h%i heading", (level) => {
      const hashes = "#".repeat(level);
      const doc = parse(`${hashes} Heading ${level}`);
      const node = doc.content[0];
      expect(node.type).toBe("heading");
      expect(node.attrs.level).toBe(level);
      expect(node.content[0].text).toBe(`Heading ${level}`);
    });
  });

  describe("code blocks", () => {
    it("converts fenced code block with language", () => {
      const md = "```typescript\nconst x = 1;\n```";
      const doc = parse(md);
      const node = doc.content[0];
      expect(node.type).toBe("code_block");
      expect(node.attrs).toEqual({ lang: "typescript" });
      expect(node.content[0].text).toBe("const x = 1;");
    });

    it("converts fenced code block without language", () => {
      const md = "```\nsome code\n```";
      const doc = parse(md);
      const node = doc.content[0];
      expect(node.type).toBe("code_block");
      expect(node.attrs).toBeUndefined();
      expect(node.content[0].text).toBe("some code");
    });
  });

  describe("blockquotes", () => {
    it("converts > lines to a blockquote node", () => {
      const doc = parse("> This is a quote");
      const node = doc.content[0];
      expect(node.type).toBe("blockquote");
      expect(node.content[0].type).toBe("paragraph");
      expect(node.content[0].content[0].text).toBe("This is a quote");
    });

    it("joins consecutive > lines", () => {
      const doc = parse("> Line one\n> Line two");
      const text = doc.content[0].content[0].content[0].text;
      expect(text).toBe("Line one Line two");
    });
  });

  describe("ordered lists", () => {
    it("converts numbered items to ordered_list with list_items", () => {
      const md = "1. First\n2. Second\n3. Third";
      const doc = parse(md);
      const node = doc.content[0];
      expect(node.type).toBe("ordered_list");
      expect(node.content).toHaveLength(3);
      node.content.forEach((item: any) => {
        expect(item.type).toBe("list_item");
        expect(item.content[0].type).toBe("paragraph");
      });
      expect(node.content[0].content[0].content[0].text).toBe("First");
      expect(node.content[2].content[0].content[0].text).toBe("Third");
    });
  });

  describe("unordered lists", () => {
    it("converts - items to bullet_list with list_items", () => {
      const md = "- Alpha\n- Beta";
      const doc = parse(md);
      const node = doc.content[0];
      expect(node.type).toBe("bullet_list");
      expect(node.content).toHaveLength(2);
      expect(node.content[0].type).toBe("list_item");
      expect(node.content[0].content[0].content[0].text).toBe("Alpha");
    });
  });

  describe("nested lists", () => {
    it("nests a deeper-indented bullet inside the parent list_item", () => {
      const md = "- Parent\n  - Child\n- Sibling";
      const doc = parse(md);
      const list = doc.content[0];
      expect(doc.content).toHaveLength(1);
      expect(list.type).toBe("bullet_list");
      expect(list.content).toHaveLength(2); // Parent, Sibling

      const parent = list.content[0];
      expect(parent.content[0].content[0].text).toBe("Parent");
      // Parent's second child is the nested list
      const nested = parent.content[1];
      expect(nested.type).toBe("bullet_list");
      expect(nested.content).toHaveLength(1);
      expect(nested.content[0].content[0].content[0].text).toBe("Child");

      // Sibling stays at the top level, no nested list
      expect(list.content[1].content[0].content[0].text).toBe("Sibling");
      expect(list.content[1].content).toHaveLength(1);
    });

    it("nests to arbitrary depth", () => {
      const md = "- L1\n  - L2\n    - L3";
      const doc = parse(md);
      const l1Item = doc.content[0].content[0];
      const l2 = l1Item.content[1];
      expect(l2.type).toBe("bullet_list");
      const l2Item = l2.content[0];
      const l3 = l2Item.content[1];
      expect(l3.type).toBe("bullet_list");
      expect(l3.content[0].content[0].content[0].text).toBe("L3");
    });

    it("nests an ordered list inside a bullet item (mixed types)", () => {
      const md = "- Bullet\n  1. One\n  2. Two";
      const doc = parse(md);
      const bulletItem = doc.content[0].content[0];
      const nested = bulletItem.content[1];
      expect(nested.type).toBe("ordered_list");
      expect(nested.content).toHaveLength(2);
      expect(nested.content[1].content[0].content[0].text).toBe("Two");
    });

    it("starts a new sibling list when the marker type flips at the same level", () => {
      const md = "- Bullet\n1. Number";
      const doc = parse(md);
      expect(doc.content).toHaveLength(2);
      expect(doc.content[0].type).toBe("bullet_list");
      expect(doc.content[1].type).toBe("ordered_list");
    });

    it("treats 4-space indentation as one nesting level", () => {
      const md = "- Parent\n    - Child";
      const doc = parse(md);
      const parent = doc.content[0].content[0];
      expect(parent.content[1].type).toBe("bullet_list");
      expect(parent.content[1].content[0].content[0].content[0].text).toBe(
        "Child",
      );
    });
  });

  describe("tables (Substack has no table node — code_block fallback)", () => {
    it("preserves a GFM table verbatim inside a code_block", () => {
      const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
      const doc = parse(md);
      expect(doc.content).toHaveLength(1);
      const node = doc.content[0];
      expect(node.type).toBe("code_block");
      expect(node.content[0].text).toBe(md);
    });

    it("supports alignment colons in the delimiter row", () => {
      const md = "| L | R |\n|:---|---:|\n| a | b |";
      const doc = parse(md);
      expect(doc.content[0].type).toBe("code_block");
      expect(doc.content[0].content[0].text).toContain(":---");
    });

    it("separates a preceding paragraph from the table", () => {
      const doc = parse("Intro line\n| A | B |\n| --- | --- |\n| 1 | 2 |");
      expect(doc.content).toHaveLength(2);
      expect(doc.content[0].type).toBe("paragraph");
      expect(doc.content[0].content[0].text).toBe("Intro line");
      expect(doc.content[1].type).toBe("code_block");
    });

    it("does not treat a paragraph containing a lone pipe as a table", () => {
      const doc = parse("a | b is just prose");
      expect(doc.content[0].type).toBe("paragraph");
    });
  });

  describe("paragraph termination", () => {
    it("does not swallow a following h4-h6 heading into the paragraph", () => {
      const doc = parse("Some text\n#### Deep heading");
      expect(doc.content).toHaveLength(2);
      expect(doc.content[0].type).toBe("paragraph");
      expect(doc.content[0].content[0].text).toBe("Some text");
      expect(doc.content[1].type).toBe("heading");
      expect(doc.content[1].attrs.level).toBe(4);
    });
  });

  describe("horizontal rules", () => {
    it("converts --- to horizontal_rule", () => {
      const doc = parse("---");
      expect(doc.content[0]).toEqual({ type: "horizontal_rule" });
    });
  });

  describe("images", () => {
    it("converts standalone image to captionedImage node", () => {
      const doc = parse("![Alt text](https://example.com/img.png)");
      const node = doc.content[0];
      expect(node.type).toBe("captionedImage");
      expect(node.attrs.src).toBe("https://example.com/img.png");
      expect(node.attrs.alt).toBe("Alt text");
      expect(node.attrs.caption).toBe("Alt text");
    });

    it("handles image with empty alt text", () => {
      const doc = parse("![](https://example.com/img.png)");
      const node = doc.content[0];
      expect(node.attrs.alt).toBe("");
      expect(node.attrs.caption).toBeNull();
    });
  });
});

describe("parseInline", () => {
  it("parses bold text", () => {
    const nodes = parseInline("**bold**");
    expect(nodes).toEqual([
      { type: "text", text: "bold", marks: [{ type: "bold" }] },
    ]);
  });

  it("parses italic text", () => {
    const nodes = parseInline("*italic*");
    expect(nodes).toEqual([
      { type: "text", text: "italic", marks: [{ type: "italic" }] },
    ]);
  });

  it("parses inline code", () => {
    const nodes = parseInline("`code`");
    expect(nodes).toEqual([
      { type: "text", text: "code", marks: [{ type: "code" }] },
    ]);
  });

  it("parses links", () => {
    const nodes = parseInline("[click](https://example.com)");
    expect(nodes).toEqual([
      {
        type: "text",
        text: "click",
        marks: [{ type: "link", attrs: { href: "https://example.com" } }],
      },
    ]);
  });

  it("parses mixed inline: bold + italic + link", () => {
    const nodes = parseInline(
      "Hello **bold** and *italic* and [link](https://x.com)"
    );
    expect(nodes[0]).toEqual({ type: "text", text: "Hello " });
    expect(nodes[1]).toEqual({
      type: "text",
      text: "bold",
      marks: [{ type: "bold" }],
    });
    expect(nodes[2]).toEqual({ type: "text", text: " and " });
    expect(nodes[3]).toEqual({
      type: "text",
      text: "italic",
      marks: [{ type: "italic" }],
    });
    expect(nodes[4]).toEqual({ type: "text", text: " and " });
    expect(nodes[5]).toEqual({
      type: "text",
      text: "link",
      marks: [{ type: "link", attrs: { href: "https://x.com" } }],
    });
  });

  it("returns plain text node for text with no formatting", () => {
    const nodes = parseInline("just plain text");
    expect(nodes).toEqual([{ type: "text", text: "just plain text" }]);
  });
});

describe("markdownToProseMirrorContent", () => {
  it("returns just the content array without doc wrapper", () => {
    const content = markdownToProseMirrorContent("Hello world");
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("paragraph");
  });
});
