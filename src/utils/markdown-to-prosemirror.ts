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

/**
 * Build ProseMirror list nodes from a flat, ordered run of list items.
 *
 * Nesting is recovered from indentation: items at the run's minimum indent are
 * siblings; any deeper-indented items immediately following an item become a
 * nested list inside that item's `list_item` (after its paragraph). A change
 * of marker type at the same indent starts a new sibling list, matching how
 * ProseMirror models "a bullet list then a numbered list".
 */
function buildListNodes(raws: ListItemRaw[]): PMNode[] {
  const result: PMNode[] = [];
  if (raws.length === 0) return result;

  const baseIndent = Math.min(...raws.map((r) => r.indent));
  let currentList: PMNode | null = null;
  let currentOrdered: boolean | null = null;
  let idx = 0;

  while (idx < raws.length) {
    const raw = raws[idx];

    if (raw.indent === baseIndent) {
      // Start a new list when there is none yet or the marker type flipped.
      if (currentList === null || currentOrdered !== raw.ordered) {
        currentList = {
          type: raw.ordered ? "ordered_list" : "bullet_list",
          content: [],
        };
        currentOrdered = raw.ordered;
        result.push(currentList);
      }

      const item: PMNode = {
        type: "list_item",
        content: [{ type: "paragraph", content: parseInline(raw.text) }],
      };
      currentList.content!.push(item);

      // Gather the contiguous, deeper-indented items that belong under this
      // one and recurse to build the nested list(s).
      let j = idx + 1;
      while (j < raws.length && raws[j].indent > baseIndent) j++;
      if (j > idx + 1) {
        item.content!.push(...buildListNodes(raws.slice(idx + 1, j)));
      }
      idx = j;
    } else {
      // baseIndent is the minimum, so this branch is unreachable for
      // well-formed input; advance defensively to avoid a stuck loop.
      idx++;
    }
  }

  return result;
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

    // Heading
    const headingMatch = line.match(HEADING_RE);
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

    // Image (standalone line)
    const imgMatch = line.match(IMAGE_LINE_RE);
    if (imgMatch) {
      nodes.push({
        type: "captionedImage",
        attrs: {
          src: imgMatch[2],
          alt: imgMatch[1],
          title: null,
          caption: imgMatch[1] || null,
        },
      });
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
