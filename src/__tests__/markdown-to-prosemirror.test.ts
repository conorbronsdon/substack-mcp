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
