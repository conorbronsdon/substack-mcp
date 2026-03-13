/**
 * Converts markdown to Substack's ProseMirror JSON format.
 *
 * Supports: paragraphs, headings (h1-h6), bold, italic, links, images,
 * bullet lists, ordered lists, code blocks, blockquotes, horizontal rules.
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
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      nodes.push({ type: "horizontal_rule" });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
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

    // Unordered list
    if (/^[\s]*[-*+]\s/.test(line)) {
      const items: PMNode[] = [];
      while (i < lines.length && /^[\s]*[-*+]\s/.test(lines[i])) {
        const itemText = lines[i].replace(/^[\s]*[-*+]\s/, "");
        items.push({
          type: "list_item",
          content: [
            { type: "paragraph", content: parseInline(itemText) },
          ],
        });
        i++;
      }
      nodes.push({
        type: "bullet_list",
        content: items,
      });
      continue;
    }

    // Ordered list
    if (/^[\s]*\d+\.\s/.test(line)) {
      const items: PMNode[] = [];
      while (i < lines.length && /^[\s]*\d+\.\s/.test(lines[i])) {
        const itemText = lines[i].replace(/^[\s]*\d+\.\s/, "");
        items.push({
          type: "list_item",
          content: [
            { type: "paragraph", content: parseInline(itemText) },
          ],
        });
        i++;
      }
      nodes.push({
        type: "ordered_list",
        content: items,
      });
      continue;
    }

    // Image (standalone line)
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
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

    // Default: paragraph — collect consecutive non-blank, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !lines[i].trimStart().startsWith("# ") &&
      !lines[i].trimStart().startsWith("## ") &&
      !lines[i].trimStart().startsWith("### ") &&
      !lines[i].trimStart().startsWith("> ") &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i].trim()) &&
      !/^[\s]*[-*+]\s/.test(lines[i]) &&
      !/^[\s]*\d+\.\s/.test(lines[i]) &&
      !/^!\[/.test(lines[i])
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
function parseInline(text: string): PMNode[] {
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
