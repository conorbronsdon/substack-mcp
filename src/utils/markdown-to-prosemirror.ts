/** Markdown AST conversion. See docs/authoring.md for supported mappings and fallbacks. */
export class MarkdownConversionError extends Error {
  constructor(message: string) { super(message); this.name = "MarkdownConversionError"; }
}

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes, Definition, Root } from "mdast";

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: PMMark[];
  text?: string;
}
export interface PMMark { type: string; attrs?: Record<string, unknown> }
export interface UnsupportedMarkdownNode {
  type: string;
  reason: string;
  line: number;
  column: number;
}
export interface MarkdownConversion {
  document: PMNode & { content: PMNode[] };
  unsupported_nodes: UnsupportedMarkdownNode[];
  /** Original input, including definitions and syntax not represented by the editor. */
  source_markdown: string;
}
export const MAX_MARKDOWN_CHARS = 200_000;
const MAX_NODES = 10_000;
const MAX_DEPTH = 100;
const IMAGE_DIMENSIONS_RE = /_(\d+)x(\d+)\.(png|jpe?g|gif|webp|avif|bmp|tiff?)$/i;

function buildImageNode(alt: string, src: string, title: string | null = null, href: string | null = null): PMNode {
  const url = new URL(src);
  const host = url.hostname;
  const trusted = host === "substackcdn.com" || host.endsWith(".substackcdn.com") ||
    host === "substack-post-media.s3.amazonaws.com";
  const match = trusted ? url.pathname.match(IMAGE_DIMENSIONS_RE) : null;
  const dims = match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0 &&
    Number.isSafeInteger(Number(match[2])) && Number(match[2]) > 0 ? match : null;
  const width = dims ? parseInt(dims[1], 10) : null;
  const height = dims ? parseInt(dims[2], 10) : null;
  const ext = dims ? dims[3].toLowerCase() : null;
  const mime = ext
    ? `image/${ext === "jpg" ? "jpeg" : ext === "tif" ? "tiff" : ext}`
    : null;

  const image2: PMNode = {
    type: "image2",
    attrs: {
      src,
      srcNoWatermark: null,
      fullscreen: false,
      imageSize: "normal",
      height,
      width,
      resizeWidth: width,
      bytes: null,
      alt: alt || null,
      title,
      type: mime,
      href,
      belowTheFold: false,
      topImage: false,
      internalRedirect: null,
    },
  };

  const content: PMNode[] = [image2];
  if (alt) {
    content.push({ type: "caption", content: [{ type: "text", text: alt }] });
  }
  return { type: "captionedImage", content };
}


function textNodes(value: string, marks: PMMark[] = []): PMNode[] {
  return value ? [{ type: "text", text: value, ...(marks.length ? { marks } : {}) }] : [];
}
function safeUrl(value: string, image = false): boolean {
  if (/[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && (image
      ? url.protocol === "https:"
      : ["https:", "http:", "mailto:"].includes(url.protocol));
  } catch { return false; }
}

export function convertMarkdown(markdown: string, target: "draft" | "note" = "draft"): MarkdownConversion {
  if (markdown.length > MAX_MARKDOWN_CHARS) throw new MarkdownConversionError(`Markdown exceeds ${MAX_MARKDOWN_CHARS} characters. Split the document before converting.`);
  let root: Root;
  try {
    root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  } catch {
    throw new MarkdownConversionError("Markdown could not be parsed within the supported parser limits.");
  }
  // Check depth iteratively before recursive conversion and collect reference definitions.
  const definitions = new Map<string, Definition>();
  const usedDefinitions = new Set<Definition>();
  const literalReferences = new Set<string>();
  const pendingDefinitions = new Map<PMNode, Definition>();
  const stack: { node: Nodes; depth: number }[] = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > MAX_NODES || depth > MAX_DEPTH) throw new MarkdownConversionError("Markdown exceeds the 10,000-node or 100-level conversion limit.");
    if (node.type === "definition") {
      // Stack visits siblings in source order: CommonMark uses the first definition.
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
    }
    if ("children" in node) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1 });
    }
  }
  const unsupported_nodes: UnsupportedMarkdownNode[] = [];
  const raw = (node: Nodes): string => markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? markdown.length);
  const report = (node: Nodes, reason: string): void => {
    if (unsupported_nodes.length >= 100) throw new MarkdownConversionError("Markdown has more than 100 unsupported constructs. Simplify it before converting.");
    unsupported_nodes.push({ type: node.type, reason, line: node.position?.start.line ?? 1, column: node.position?.start.column ?? 1 });
  };
  const fallback = (node: Nodes, reason: string, inline = false, marks: PMMark[] = []): PMNode[] => {
    report(node, reason);
    const pending = [node];
    while (pending.length) {
      const child = pending.pop()!;
      if (child.type === "linkReference" || child.type === "imageReference") literalReferences.add(child.identifier);
      if ("children" in child) pending.push(...child.children);
    }
    return inline ? textNodes(raw(node), marks) : [{ type: "code_block", content: textNodes(raw(node)) }];
  };
  const inline = (nodes: Nodes[], marks: PMMark[] = []): PMNode[] => nodes.flatMap((node): PMNode[] => {
    switch (node.type) {
      case "text": return textNodes(node.value.replace(/\r?\n/g, " "), marks);
      case "break": return [{ type: "hard_break" }];
      case "inlineCode": return textNodes(node.value, [...marks, { type: "code" }]);
      case "strong": return inline(node.children, [...marks, { type: "bold" }]);
      case "emphasis": return inline(node.children, [...marks, { type: "italic" }]);
      case "delete": return inline(node.children, [...marks, { type: "strikethrough" }]);
      case "link":
      case "linkReference": {
        const link = node.type === "link" ? node : definitions.get(node.identifier);
        if (!link || !safeUrl(link.url)) return fallback(node, "Link requires an absolute HTTP(S) or mailto URL without credentials.", true, marks);
        if (link.type === "definition") usedDefinitions.add(link);
        if (link.title) report(node, "Link title is retained in source_markdown; the verified link mapping has no title attribute.");
        return inline(node.children, [...marks, { type: "link", attrs: { href: link.url } }]);
      }
      case "image":
      case "imageReference": {
        const image = node.type === "image" ? node : definitions.get(node.identifier);
        if (!image || !safeUrl(image.url, true)) return fallback(node, "Image requires an absolute HTTPS URL without credentials.", true, marks);
        if (image.type === "definition") usedDefinitions.add(image);
        const href = marks.find(mark => mark.type === "link")?.attrs?.href;
        if (marks.some(mark => mark.type !== "link")) report(node, "Text formatting around images has no verified image mapping.");
        return [buildImageNode(node.alt ?? "", image.url, image.title ?? null, typeof href === "string" ? href : null)];
      }
      default: return fallback(node, "No verified inline editor mapping; Markdown retained literally.", true, marks);
    }
  });
  // Images are block nodes in Substack. Split paragraphs/headings around them,
  // preserving surrounding text and linked-image destinations in reading order.
  const textBlocks = (node: Extract<Nodes, { type: "paragraph" | "heading" }>): PMNode[] => {
    const result: PMNode[] = [];
    let run: PMNode[] = [];
    const flush = (): void => {
      if (run.length) result.push({ type: node.type, ...(node.type === "heading" ? { attrs: { level: node.depth } } : {}), content: run });
      run = [];
    };
    for (const child of inline(node.children)) {
      if (child.type === "captionedImage") { flush(); result.push(child); }
      else run.push(child);
    }
    flush();
    return result.length ? result : [{ type: node.type, ...(node.type === "heading" ? { attrs: { level: node.depth } } : {}) }];
  };
  let paywalls = 0;
  const blocks = (nodes: Nodes[], topLevel = false): PMNode[] => nodes.flatMap((node): PMNode[] => {
    switch (node.type) {
      case "paragraph":
      case "heading": return textBlocks(node);
      case "blockquote": return [{ type: "blockquote", content: blocks(node.children) }];
      case "list": return [{ type: node.ordered ? "ordered_list" : "bullet_list", ...(node.ordered ? { attrs: { order: node.start ?? 1 } } : {}), content: blocks(node.children) }];
      case "listItem": {
        if (node.checked !== null && node.checked !== undefined) return [{ type: "list_item", content: [{ type: "paragraph" }, ...fallback(node, "Task-list checkboxes have no verified editor mapping; item source retained.")] }];
        const content = blocks(node.children);
        // The legacy list_item schema requires a leading paragraph.
        if (content[0]?.type !== "paragraph") content.unshift({ type: "paragraph" });
        return [{ type: "list_item", content }];
      }
      case "code":
        if (node.meta) return fallback(node, "Code-fence metadata has no verified editor mapping; complete fence retained.");
        return [{ type: "code_block", ...(node.lang ? { attrs: { lang: node.lang } } : {}), content: textNodes(node.value) }];
      case "thematicBreak": return [{ type: "horizontal_rule" }];
      case "definition": {
        // Resolve after every reference has been converted. A reference inside
        // a literal fallback (or with a rejected URL) does not consume its definition.
        const placeholder: PMNode = { type: "definition_placeholder" };
        pendingDefinitions.set(placeholder, node);
        return [placeholder];
      }
      case "html":
        if (node.value.trim() === "<!-- paywall -->") {
          if (target !== "draft" || !topLevel) return fallback(node, "Paywall markers are supported only at the top level of long-form drafts.");
          if (++paywalls > 1) throw new MarkdownConversionError("Only one paywall marker is allowed in a draft.");
          return [{ type: "paywall" }];
        }
        return fallback(node, "Raw HTML has no verified editor mapping; retained as code.");
      default: return fallback(node, "No verified block editor mapping; original Markdown retained as code.");
    }
  });
  const resolveDefinitions = (nodes: PMNode[]): PMNode[] => nodes.flatMap(node => {
    const definition = pendingDefinitions.get(node);
    if (definition) return usedDefinitions.has(definition) && !literalReferences.has(definition.identifier) ? [] : fallback(definition, "Unused, unconverted or duplicate reference definition retained as Markdown.");
    if (node.content) node.content = resolveDefinitions(node.content);
    if (node.type === "blockquote" && !node.content?.length) node.content = [{ type: "paragraph" }];
    return [node];
  });
  const content = resolveDefinitions(blocks(root.children, true));
  unsupported_nodes.sort((a, b) => a.line - b.line || a.column - b.column);
  const document = { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
  // AST limits do not count nodes generated by images, captions and nested marks.
  const output = [{ node: document as PMNode, depth: 0 }];
  count = 0;
  while (output.length) {
    const { node, depth } = output.pop()!;
    if (++count > MAX_NODES || depth > MAX_DEPTH) throw new MarkdownConversionError("Converted Markdown exceeds the 10,000-node or 100-level output limit.");
    if (node.content) for (const child of node.content) output.push({ node: child, depth: depth + 1 });
  }
  if (JSON.stringify(document).length > 2_000_000) throw new MarkdownConversionError("Converted Markdown exceeds the 2,000,000-character output limit.");
  return { document, unsupported_nodes, source_markdown: markdown };
}

/** Compatibility helpers preserve literal fallbacks. Write callers must inspect diagnostics. */
export function markdownToProseMirror(markdown: string): string {
  return JSON.stringify(convertMarkdown(markdown).document);
}
export function markdownToProseMirrorContent(markdown: string): PMNode[] {
  return convertMarkdown(markdown).document.content;
}
export function parseInline(markdown: string): PMNode[] {
  const conversion = convertMarkdown(markdown);
  // This compatibility helper returns inline text only. Preserve block syntax
  // literally instead of leaking a block image into an inline-only container.
  if (conversion.document.content.length === 1 && conversion.document.content[0].type === "paragraph") return conversion.document.content[0].content ?? [];
  return textNodes(markdown);
}
