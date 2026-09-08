import { toMarkdown } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import type { Root, BlockContent, DefinitionContent, PhrasingContent, ListItem } from "mdast";

export interface ExportLoss { path: string; type: string; reason: string }
export interface MarkdownExport {
  markdown: string | null;
  source_prosemirror: string;
  unsupported_nodes: ExportLoss[];
  status: "converted" | "partial" | "unavailable";
}
export const MAX_EXPORT_SOURCE_CHARS = 2_000_000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
type Block = BlockContent | DefinitionContent;
type Node = Record<string, unknown> & { type: string };
const node = (v: unknown): v is Node => object(v) && typeof v.type === "string" && v.type.length <= 128;
const aliases: Record<string, string> = {
  bulletList: "bullet_list", orderedList: "ordered_list", listItem: "list_item",
  codeBlock: "code_block", hardBreak: "hard_break", horizontalRule: "horizontal_rule",
};
const kind = (n: Node) => Object.hasOwn(aliases, n.type) ? aliases[n.type] : n.type;
const children = (n: Node): unknown[] => Array.isArray(n.content) ? n.content : [];
const attrs = (n: Node): Record<string, unknown> => object(n.attrs) ? n.attrs : {};
const literal = (value: string): PhrasingContent => ({ type: "text", value });
const safeUrl = (value: unknown, image = false): value is string => {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && (image ? url.protocol === "https:" : ["https:", "http:", "mailto:"].includes(url.protocol));
  } catch { return false; }
};

/** Read-only projection. The original serialized body is always retained exactly. */
export function prosemirrorToMarkdown(source: string): MarkdownExport {
  if (source.length > MAX_EXPORT_SOURCE_CHARS) throw new Error("Draft body exceeds the 2,000,000-character export limit.");
  const unsupported_nodes: ExportLoss[] = [];
  const report = (path: string, type: string, reason: string): void => {
    if (unsupported_nodes.length >= 100) throw new Error("Draft exceeds the 100-diagnostic export limit; retrieve its original body with get_draft.");
    unsupported_nodes.push({ path, type, reason });
  };
  const unavailable = (reason: string): MarkdownExport => {
    report("/", "invalid_document", reason);
    return { markdown: null, source_prosemirror: source, unsupported_nodes, status: "unavailable" };
  };
  let root: unknown;
  try { root = JSON.parse(source); } catch { return unavailable("Body is not valid JSON; original source retained."); }
  if (!node(root) || root.type !== "doc" || !Array.isArray(root.content)) return unavailable("Expected a doc with a content array; original source retained.");
  // Check the entire content tree, including unsupported subtrees, before recursion.
  const pending = [{ value: root as unknown, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++count > 10_000 || depth > 100) throw new Error("Draft exceeds the 10,000-node or 100-level export limit.");
    if (object(value)) {
      if (Array.isArray(value.marks) && value.marks.length > 32) throw new Error("Draft exceeds the 32-marks-per-node export limit.");
      if (Array.isArray(value.content)) for (const child of value.content) pending.push({ value: child, depth: depth + 1 });
    }
  }
  const check = (n: Node, path: string, mappedAttrs: string[] = []): void => {
    const extra = Object.keys(n).filter(key => !["type", "attrs", "content", "marks", "text"].includes(key));
    if (extra.length) report(path, n.type, "Additional node fields are retained only in source_prosemirror.");
    if (n.attrs !== undefined && !object(n.attrs)) report(path + "/attrs", n.type, "Malformed attributes are retained only in source_prosemirror.");
    else if (Object.keys(attrs(n)).some(key => !mappedAttrs.includes(key))) report(path + "/attrs", n.type, "Unmapped attributes are retained only in source_prosemirror.");
    if (n.marks !== undefined && !Array.isArray(n.marks)) report(path + "/marks", n.type, "Malformed marks are retained only in source_prosemirror.");
    if (kind(n) !== "text" && n.text !== undefined) report(path + "/text", n.type, "Unexpected text field is retained only in source_prosemirror.");
  };
  const placeholder = (path: string, type: string, reason: string): Block[] => {
    report(path, type, reason);
    // Reimport through our Markdown converter flags this HTML as unsupported.
    return [{ type: "html", value: `<!-- substack-export-unsupported: ${path} -->` }];
  };
  const inline = (values: unknown[], path: string): PhrasingContent[] => values.flatMap((value, index): PhrasingContent[] => {
    const at = `${path}/${index}`;
    if (!node(value)) {
      report(at, "invalid_node", "Malformed inline node retained in source_prosemirror.");
      return [literal(`[Unsupported inline node at ${at}]`)];
    }
    if (kind(value) === "hard_break") {
      check(value, at);
      if (value.content !== undefined || value.marks !== undefined) report(at, value.type, "Break children/marks are retained only in original source.");
      return [{ type: "break" }];
    }
    if (kind(value) !== "text" || typeof value.text !== "string") {
      report(at, value.type, "No verified inline Markdown mapping; original node retained.");
      return [literal(`[Unsupported inline node at ${at}]`)];
    }
    check(value, at);
    if (!value.text) report(at, value.type, "Empty text node has no distinct Markdown representation.");
    if (value.content !== undefined) report(at + "/content", value.type, "Text-node children are retained only in source_prosemirror.");
    if (/[\r\n]/.test(value.text)) report(at, value.type, "Text-node newlines may normalize on Markdown reimport.");
    let result: PhrasingContent = literal(value.text);
    const marks = Array.isArray(value.marks) ? value.marks : [];
    // Code is the innermost mark; other marks wrap the code span.
    if (marks.some(mark => object(mark) && mark.type === "code")) result = { type: "inlineCode", value: value.text };
    for (let i = marks.length - 1; i >= 0; i--) {
      const mark = marks[i], markPath = `${at}/marks/${i}`;
      if (!object(mark) || typeof mark.type !== "string") { report(markPath, "invalid_mark", "Malformed mark retained in original source."); continue; }
      const ma = object(mark.attrs) ? mark.attrs : {};
      if (Object.keys(mark).some(key => !["type", "attrs"].includes(key)) ||
          (mark.attrs !== undefined && !object(mark.attrs)) ||
          Object.keys(ma).some(key => !(mark.type === "link" && key === "href"))) report(markPath, mark.type, "Unmapped mark attributes/fields are retained only in source_prosemirror.");
      switch (mark.type) {
        case "bold": case "strong": result = { type: "strong", children: [result] }; break;
        case "italic": case "em": result = { type: "emphasis", children: [result] }; break;
        case "strike": case "strikethrough": result = { type: "delete", children: [result] }; break;
        case "code": break;
        case "link":
          if (!safeUrl(ma.href)) report(markPath, mark.type, "Unsafe or relative link omitted from Markdown; original source retained.");
          else if (result.type === "link") report(markPath, mark.type, "Nested links are not represented in Markdown; original source retained.");
          else result = { type: "link", url: ma.href, children: [result as Exclude<PhrasingContent, { type: "link" }>] };
          break;
        default: report(markPath, mark.type, "No verified Markdown mark mapping; original mark retained.");
      }
    }
    return value.text ? [result] : [];
  });
  let paywalls = 0;
  const blocks = (values: unknown[], path: string, topLevel = false): Block[] => values.flatMap((value, index): Block[] => {
    const at = `${path}/${index}`;
    if (!node(value)) return placeholder(at, "invalid_node", "Malformed block retained in source_prosemirror.");
    if (value.content !== undefined && !Array.isArray(value.content)) return placeholder(at, value.type, "Malformed content array retained in source_prosemirror.");
    const content = children(value), a = attrs(value), type = kind(value);
    if (Array.isArray(value.marks) && value.marks.length) report(at + "/marks", value.type, "Block marks are retained only in source_prosemirror.");
    switch (type) {
      case "paragraph":
        check(value, at);
        if (!content.length) report(at, type, "An empty paragraph has no distinct Markdown representation.");
        return [{ type: "paragraph", children: inline(content, at + "/content") }];
      case "heading":
        check(value, at, ["level"]);
        if (![1, 2, 3, 4, 5, 6].includes(Number(a.level)) || typeof a.level !== "number") return placeholder(at, type, "Invalid heading level retained in original source.");
        return [{ type: "heading", depth: a.level as 1 | 2 | 3 | 4 | 5 | 6, children: inline(content, at + "/content") }];
      case "blockquote":
        check(value, at);
        return [{ type: "blockquote", children: blocks(content, at + "/content") as Block[] }];
      case "bullet_list": case "ordered_list": {
        check(value, at, type === "ordered_list" ? [value.type === "orderedList" ? "start" : "order"] : []);
        const start = (value.type === "orderedList" ? a.start : a.order) ?? 1;
        if (type === "ordered_list" && (!Number.isSafeInteger(start) || Number(start) < 0 || Number(start) > 999_999_999)) return placeholder(at, type, "List starting number cannot be represented in CommonMark.");
        if (!content.length || content.some(child => !node(child) || kind(child) !== "list_item")) return placeholder(at, type, "Invalid list structure retained in original source.");
        const items: ListItem[] = content.map((child, i) => {
          const item = child as Node, itemPath = `${at}/content/${i}`;
          check(item, itemPath);
          if (item.marks !== undefined) report(itemPath + "/marks", item.type, "List-item marks are retained only in original source.");
          if (item.content !== undefined && !Array.isArray(item.content)) report(itemPath, item.type, "Malformed list-item content retained in original source.");
          return { type: "listItem", spread: true, children: blocks(children(item), itemPath + "/content") as ListItem["children"] };
        });
        return [{ type: "list", ordered: type === "ordered_list", ...(type === "ordered_list" ? { start: Number(start) } : {}), spread: true, children: items }];
      }
      case "code_block": {
        const languageKey = value.type === "codeBlock" ? "language" : "lang";
        check(value, at, [languageKey]);
        if (content.some(child => !node(child) || child.type !== "text" || typeof child.text !== "string")) return placeholder(at, type, "Non-text code-block children retained in original source.");
        for (let i = 0; i < content.length; i++) {
          const child = content[i] as Node;
          check(child, `${at}/content/${i}`);
          if (child.marks !== undefined || child.content !== undefined) report(`${at}/content/${i}`, child.type, "Code text marks/children are retained only in original source.");
        }
        const lang = a[languageKey];
        if (lang !== undefined && lang !== null && (typeof lang !== "string" || /[\s`~]/.test(lang))) report(at + "/attrs", type, "Code language cannot be represented safely; retained in original source.");
        return [{ type: "code", lang: typeof lang === "string" && !/[\s`~]/.test(lang) ? lang : null, value: content.map(child => (child as Node).text).join("") }];
      }
      case "horizontal_rule": check(value, at); if (content.length) report(at, type, "Rule children retained only in original source."); return [{ type: "thematicBreak" }];
      case "paywall":
        check(value, at);
        if (!topLevel || ++paywalls > 1 || content.length) return placeholder(at, type, "Only one top-level empty paywall is supported for Markdown reimport.");
        return [{ type: "html", value: "<!-- paywall -->" }];
      case "captionedImage": {
        check(value, at);
        if (!node(content[0]) || content[0].type !== "image2" || content.slice(1).some(child => !node(child) || child.type !== "caption")) return placeholder(at, type, "Unrecognized image wrapper retained in original source.");
        const image = content[0], ia = attrs(image);
        check(image, at + "/content/0", ["src", "alt", "title", "href"]);
        if (image.content !== undefined || image.marks !== undefined) report(at + "/content/0", image.type, "Image children/marks are retained only in original source.");
        if (!safeUrl(ia.src, true)) return placeholder(at, type, "Image has no safe absolute HTTPS source; original retained.");
        const alt = typeof ia.alt === "string" ? ia.alt : "";
        if (ia.alt != null && typeof ia.alt !== "string") report(at + "/content/0/attrs", image.type, "Non-string alt text retained in source.");
        if (ia.title != null && typeof ia.title !== "string") report(at + "/content/0/attrs", image.type, "Non-string image title retained in source.");
        let result: PhrasingContent = { type: "image", url: ia.src, alt, title: typeof ia.title === "string" ? ia.title : null };
        if (ia.href != null) {
          if (safeUrl(ia.href)) result = { type: "link", url: ia.href, children: [result] };
          else report(at + "/content/0/attrs", image.type, "Unsafe image link retained only in original source.");
        }
        const output: Block[] = [{ type: "paragraph", children: [result] }];
        const captions = content.slice(1) as Node[];
        const captionText = captions.length === 1 && children(captions[0]).length === 1 ? children(captions[0])[0] : undefined;
        const equivalentCaption = node(captionText) && captionText.type === "text" && captionText.text === alt &&
          (captionText.marks === undefined || (Array.isArray(captionText.marks) && captionText.marks.length === 0));
        if ((!alt && captions.length) || (alt && !equivalentCaption)) report(at, type, "Caption differs from image alt text; Markdown reimport cannot preserve their independence.");
        for (let i = 0; i < captions.length; i++) {
          const caption = captions[i]; check(caption, `${at}/content/${i + 1}`);
          if (caption.marks !== undefined || (caption.content !== undefined && !Array.isArray(caption.content))) report(`${at}/content/${i + 1}`, caption.type, "Caption marks or malformed children are retained only in original source.");
          const captionInline = inline(children(caption), `${at}/content/${i + 1}/content`);
          if (!equivalentCaption) output.push({ type: "paragraph", children: captionInline });
        }
        return output;
      }
      default: return placeholder(at, value.type, "No verified Markdown block mapping; original node retained in source_prosemirror.");
    }
  });
  check(root, "/");
  if (root.marks !== undefined) report("/marks", "doc", "Document marks are retained only in original source.");
  const tree: Root = { type: "root", children: blocks(root.content, "/content", true) };
  let markdown: string;
  try { markdown = toMarkdown(tree, { extensions: [gfmToMarkdown()], bullet: "-", emphasis: "*", strong: "*", fences: true }); }
  catch { return unavailable("Markdown serialization failed; original source retained."); }
  if (unsupported_nodes.length) markdown = "<!-- substack-export-partial: inspect unsupported_nodes and source_prosemirror before reuse -->\n\n" + markdown;
  if (markdown.length > 2_000_000) throw new Error("Markdown exceeds the 2,000,000-character export output limit.");
  return { markdown, source_prosemirror: source, unsupported_nodes, status: unsupported_nodes.length ? "partial" : "converted" };
}
