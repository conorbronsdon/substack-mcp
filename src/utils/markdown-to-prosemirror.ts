/**
 * Converts markdown to Substack's ProseMirror JSON format.
 *
 * Supports: paragraphs, headings (h1-h6), bold, italic, links, images,
 * bullet lists, ordered lists, NESTED lists (arbitrary depth, mixed
 * ordered/unordered), code blocks, blockquotes, horizontal rules.
 *
 * Tables: Substack's post schema has NO table node (its editor never
 * integrated prosemirror-tables), so a GFM table cannot be represented
 * natively. Rather than let the pipes collapse into a mangled paragraph, a
 * detected table is preserved verbatim inside a `code_block` — monospace
 * keeps the columns aligned and the content survives round-trip so the author
 * can reformat it (as an image/embed) in Substack's editor.
 */

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: PMMark[];
  text?: string;
}

interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/** A single markdown list item, flattened with its indentation depth. */
interface ListItemRaw {
  /** Leading-whitespace width, tabs counted as 4 columns. */
  indent: number;
  ordered: boolean;
  text: string;
}

// A list item: optional leading whitespace, a bullet (-, *, +) or an ordered
// marker (`1.`), one or more spaces, then the item text. The capture groups
// are used to recover indentation, list type, and content.
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
// Substack CDN uploads encode the pixel dimensions in the filename, e.g.
// `..._1265x5808.png`. We parse them so the editor can lay the image out; the
// same suffix also tells us the MIME type. Non-CDN URLs simply yield nulls.
const IMAGE_DIMENSIONS_RE =
  /_(\d+)x(\d+)\.(png|jpe?g|gif|webp|avif|bmp|tiff?)(?:$|[?#])/i;
// The `_WxH_` suffix is a Substack CDN convention, so only trust it on
// Substack-hosted URLs. A foreign URL like `hero_16x9.jpg` uses that shape as
// an aspect-ratio label, not pixel dimensions — parsing it would emit a bogus
// 16x9-pixel layout. Those fall through to null, which the editor tolerates.
const SUBSTACK_CDN_RE = /(?:substackcdn\.com|substack-post-media\.s3\.amazonaws\.com)/i;

// Build a Substack image node. Substack renders an image as a `captionedImage`
// that WRAPS an `image2` child — the `src` and dimensions live on that child,
// not on the wrapper. Emitting a flat `{type:"captionedImage", attrs:{src}}`
// node is accepted by the drafts API but crashes Substack's editor when it
// tries to render the (missing) child, so we always nest an `image2` here and
// attach a `caption` node when alt text is present.
function buildImageNode(alt: string, src: string): PMNode {
  const dims = SUBSTACK_CDN_RE.test(src) ? src.match(IMAGE_DIMENSIONS_RE) : null;
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
      title: null,
      type: mime,
      href: null,
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

/**
 * True for a GFM table delimiter row — the `|---|:--:|` line under the header.
 * Every pipe-separated cell must be dashes with optional alignment colons.
 */
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

/** A line that could be a table row: non-blank and containing a pipe. */
function looksLikeTableRow(line: string): boolean {
  return line.trim().length > 0 && line.includes("|");
}

/**
 * True when a GFM table starts at `lines[idx]`: a pipe row immediately
 * followed by a delimiter row. Requires the two-line lookahead so an ordinary
 * paragraph that merely contains a pipe is not misread as a table.
 */
function startsTable(lines: string[], idx: number): boolean {
  return (
    looksLikeTableRow(lines[idx]) &&
    idx + 1 < lines.length &&
    isTableDelimiter(lines[idx + 1])
  );
}

/** Width of a leading-whitespace run, counting each tab as 4 columns. */
function indentWidth(whitespace: string): number {
  let width = 0;
  for (const ch of whitespace) width += ch === "\t" ? 4 : 1;
  return width;
}

/**
 * True when a line begins a block that is NOT a plain paragraph — used to
 * terminate paragraph accumulation. Kept in sync with the block handlers in
 * the main loop so a paragraph never swallows a following heading (h1-h6),
 * list, blockquote, code fence, rule, or standalone image.
 */
function startsBlock(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed === "" ||
    trimmed.startsWith("```") ||
    HEADING_RE.test(trimmed) ||
    trimmed.startsWith("> ") ||
    HR_RE.test(line.trim()) ||
    LIST_ITEM_RE.test(line) ||
    IMAGE_LINE_RE.test(trimmed)
  );
}

/** A live nesting level while lists are being assembled. */
interface ListFrame {
  indent: number;
  ordered: boolean;
  list: PMNode;
  lastItem: PMNode | null;
}

/**
 * Build ProseMirror list nodes from a flat, ordered run of list items.
 *
 * A stack tracks the open nesting levels. A deeper indent opens a nested list
 * inside the current item; a shallower indent closes levels; a marker-type
 * flip at the same indent starts a sibling list of the other kind. The design
 * goal is that NO item is ever dropped — a leading over-indented item with no
 * parent simply becomes its own top-level list rather than being discarded, so
 * even malformed indentation round-trips its content.
 */
function buildListNodes(raws: ListItemRaw[]): PMNode[] {
  const root: PMNode[] = [];
  const stack: ListFrame[] = [];

  const openList = (ordered: boolean): PMNode => ({
    type: ordered ? "ordered_list" : "bullet_list",
    content: [],
  });

  for (const raw of raws) {
    // Close any levels deeper than this item.
    while (stack.length && raw.indent < stack[stack.length - 1].indent) {
      stack.pop();
    }

    let top: ListFrame | undefined = stack[stack.length - 1];

    if (!top || raw.indent > top.indent) {
      // Open a nested list under the current item, or a new root list when
      // there is no enclosing item (including a leading over-indented item).
      const list = openList(raw.ordered);
      if (top && top.lastItem) {
        top.lastItem.content!.push(list);
      } else {
        root.push(list);
      }
      top = { indent: raw.indent, ordered: raw.ordered, list, lastItem: null };
      stack.push(top);
    } else if (raw.ordered !== top.ordered) {
      // Same level, different marker → a sibling list of the other kind,
      // attached wherever the current list lives (parent item, or root).
      const list = openList(raw.ordered);
      const parent = stack[stack.length - 2];
      if (parent && parent.lastItem) {
        parent.lastItem.content!.push(list);
      } else {
        root.push(list);
      }
      stack.pop();
      top = { indent: raw.indent, ordered: raw.ordered, list, lastItem: null };
      stack.push(top);
    }

    const item: PMNode = {
      type: "list_item",
      content: [{ type: "paragraph", content: parseInline(raw.text) }],
    };
    top.list.content!.push(item);
    top.lastItem = item;
  }

  return root;
}

export function markdownToProseMirror(markdown: string): string {
  const lines = markdown.split("\n");
  const nodes: PMNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      nodes.push({
        type: "code_block",
        ...(lang ? { attrs: { lang } } : {}),
        content: [{ type: "text", text: codeLines.join("\n") }],
      });
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(line.trim())) {
      nodes.push({ type: "horizontal_rule" });
      i++;
      continue;
    }

    // Heading. Match the left-trimmed line so an indented `  # h` (valid up to
    // 3 leading spaces in CommonMark) is consumed here — this MUST agree with
    // startsBlock's trimmed test, or such a line would be flagged as a block
    // start yet consumed by nothing, stalling the loop.
    const headingMatch = line.trimStart().match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1].length;
      nodes.push({
        type: "heading",
        attrs: { level },
        content: parseInline(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("> ")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      nodes.push({
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: parseInline(quoteLines.join(" ")),
          },
        ],
      });
      continue;
    }

    // List (ordered, unordered, and nested — one contiguous run)
    if (LIST_ITEM_RE.test(line)) {
      const raws: ListItemRaw[] = [];
      while (i < lines.length && LIST_ITEM_RE.test(lines[i])) {
        const m = lines[i].match(LIST_ITEM_RE)!;
        raws.push({
          indent: indentWidth(m[1]),
          ordered: /\d/.test(m[2]),
          text: m[3],
        });
        i++;
      }
      nodes.push(...buildListNodes(raws));
      continue;
    }

    // Table (GFM) — Substack has no table node, so preserve it verbatim in a
    // code_block instead of mangling the pipes into a paragraph.
    if (startsTable(lines, i)) {
      const tableLines: string[] = [];
      while (i < lines.length && looksLikeTableRow(lines[i])) {
        tableLines.push(lines[i].replace(/\s+$/, ""));
        i++;
      }
      nodes.push({
        type: "code_block",
        content: [{ type: "text", text: tableLines.join("\n") }],
      });
      continue;
    }

    // Image (standalone line). Left-trimmed for the same reason as headings:
    // it must agree with startsBlock so an indented image line is consumed.
    const imgMatch = line.trimStart().match(IMAGE_LINE_RE);
    if (imgMatch) {
      nodes.push(buildImageNode(imgMatch[1], imgMatch[2]));
      i++;
      continue;
    }

    // Default: paragraph — collect consecutive lines until the next block.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      !startsBlock(lines[i]) &&
      !startsTable(lines, i)
    ) {
      paraLines.push(lines[i]);
      i++;
    }

    if (paraLines.length > 0) {
      const text = paraLines.join(" ");
      const inlineContent = parseInline(text);
      if (inlineContent.length > 0) {
        nodes.push({
          type: "paragraph",
          content: inlineContent,
        });
      }
    } else {
      // Safety net: a line was flagged as a block start (startsBlock/startsTable)
      // but no dispatch branch above consumed it. Advance unconditionally so
      // the main loop can never stall, whatever future edits do to the two
      // sets of predicates.
      i++;
    }
  }

  const doc: PMNode = {
    type: "doc",
    content: nodes.length > 0 ? nodes : [{ type: "paragraph" }],
  };

  return JSON.stringify(doc);
}

/**
 * Returns the raw ProseMirror content array (for Notes, which wrap it in their own doc envelope).
 */
export function markdownToProseMirrorContent(markdown: string): PMNode[] {
  const doc = JSON.parse(markdownToProseMirror(markdown));
  return doc.content;
}

/**
 * Parse inline markdown (bold, italic, links, inline code) into ProseMirror text nodes with marks.
 */
export function parseInline(text: string): PMNode[] {
  const nodes: PMNode[] = [];

  // Regex for inline patterns: bold, italic, links, inline code, images
  const inlineRegex =
    /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)|(!?\[([^\]]*)\]\(([^)]+)\))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index);
      if (before) nodes.push({ type: "text", text: before });
    }

    if (match[1]) {
      // Bold: **text**
      nodes.push({
        type: "text",
        text: match[2],
        marks: [{ type: "bold" }],
      });
    } else if (match[3]) {
      // Italic: *text*
      nodes.push({
        type: "text",
        text: match[4],
        marks: [{ type: "italic" }],
      });
    } else if (match[5] && !match[5].startsWith("!")) {
      // Link: [text](url)
      nodes.push({
        type: "text",
        text: match[6],
        marks: [{ type: "link", attrs: { href: match[7] } }],
      });
    } else if (match[8]) {
      // Inline code: `code`
      nodes.push({
        type: "text",
        text: match[9],
        marks: [{ type: "code" }],
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    if (remaining) nodes.push({ type: "text", text: remaining });
  }

  return nodes;
}
