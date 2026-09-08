# Markdown authoring

Draft bodies use CommonMark parsing with GFM extensions. Nested formatting,
reference links, escaped punctuation, entities, lists with continuation
paragraphs, fenced and indented code, and hard line breaks are parsed as
structure. Soft line breaks become spaces. Four-space indentation at the start
of a document means code, as in CommonMark.

## Mappings

| Markdown | Substack output |
| --- | --- |
| Paragraphs and headings | `paragraph`, `heading` with level 1–6 |
| Bold, italic, inline code | `bold`, `italic`, `code` marks; nested marks combine |
| `~~strikethrough~~` | `strikethrough` mark |
| Links and reference links | `link` mark with `href` |
| Bullets and numbered lists | `bullet_list`, `ordered_list`, `list_item`; starting number in `attrs.order` |
| Blockquotes, code, rules, hard breaks | `blockquote`, `code_block`, `horizontal_rule`, `hard_break` |
| Images | `captionedImage` wrapping `image2`; alt text also supplies a plain caption |
| Linked images | Image destination in `image2.attrs.href` |
| `<!-- paywall -->` on its own block | One top-level `paywall`, in long-form drafts only |

Images occupy blocks in Substack. An image inside a paragraph or heading splits
that text block into text before the image, the image, and text after it. Image
titles are stored separately from alt text and captions. No image is fetched or
uploaded during conversion. Only an actual Substack CDN hostname supplies
filename-derived dimensions; foreign and deceptive URLs keep null dimensions.

Links require absolute HTTP, HTTPS or mailto URLs. Images require absolute HTTPS
URLs. URLs with credentials or literal whitespace/control characters produce a
diagnostic and literal fallback. Relative links need an explicit destination.

Separate a paywall marker from surrounding text with blank lines. Code spans,
code fences and escaped markers remain literal text. Multiple top-level
paywalls fail conversion. Nested markers and markers in Notes are unsupported.
Always check audience and placement with preflight and review the draft in
Substack before publishing.

## Unsupported content and write behavior

`create_draft` and `update_draft` return `isError: true` with
`code: "unsupported_markdown"` and an `unsupported_nodes` array when conversion
needs a fallback. Each diagnostic names the node type, reason, line and column.
No draft write occurs. Simplify the Markdown, or inspect the diagnostics and
explicitly retry with `allow_unsupported: true` to store the fallback in a private
draft. A successful response still includes the diagnostics.

Tables retain their exact Markdown in a code block because this converter has
no verified native table mapping. Raw HTML, footnote definitions, unused or
duplicate reference definitions, and code fences with extra metadata also
retain source as code. Footnote references and unsupported inline constructs
remain literal Markdown. Task-list items retain their source as code inside
the list. Link titles and text formatting around images produce diagnostics
because those attributes have no verified mapping here. Keep the original
Markdown when acknowledging these losses.

`create_note` and `create_note_with_link` reject all conversion diagnostics.
Validation happens before either a Note or link attachment is created. Notes
still publish immediately on a successful call; they have no fallback override.
Paywall support is for long-form drafts only.

The internal `convertMarkdown` API returns `document`, `unsupported_nodes` and
the complete `source_markdown`. Compatibility helpers return the document or
content array with literal fallbacks; write integrations must use the diagnostic
API. Arbitrary HTML embeds, native callouts and native footnotes are not
advertised as supported. An ordinary URL remains a link, not an embed.

Conversion accepts at most 200,000 JavaScript string characters, 10,000 parsed
or generated nodes, 100 nesting levels, 100 diagnostics, and 2,000,000 serialized
output characters. Exceeding a limit fails before a write. Parsing is synchronous;
these are size/structure limits, not a wall-clock deadline.

## Evidence and live checks

Parser APIs: [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown)
and [mdast-util-gfm](https://github.com/syntax-tree/mdast-util-gfm).
The [Substack editor bundle inspected September 7, 2026](https://substackcdn.com/bundle/static/js/reactPublish.0f042dbd.js)
maps legacy list names to Tiptap names, `ordered_list.attrs.order` to
`orderedList.attrs.start`, `strikethrough` to `strike`, `strong` to `bold`, and
`em` to `italic`. It defines a block-and-caption image wrapper and creates a
`paywall` node without required attributes. Existing `bold`/`italic` output is
preserved. This is source inspection, not a guarantee about future editor
versions or a live rendering assertion for every mapping.

The hand-authored rich-content fixture and MCP tests run offline. Before a
release, use a dedicated test publication to create a clearly labeled private
sample draft, read it back, compare its body with the fixture, and open the
editor to check nested numbering, combined marks, captions, image links and
paywall placement. Use a real uploaded test image for the live check; the
fixture's synthetic image URL is only for offline tests. Record the candidate
SHA, tested features, returned structure and any rendering differences without
private publication content. Leave cleanup explicit and manual; do not publish
the draft, automatically delete it, or publish Notes as a contract test.

Export and stale-edit safeguards remain tracked separately in #54 and #63.
