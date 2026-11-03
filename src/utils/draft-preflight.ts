type Finding = { severity: "error" | "warning"; code: string; message: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const knownNodes = new Set(["doc", "paragraph", "text", "bulletList", "orderedList", "listItem", "codeBlock", "hardBreak", "horizontalRule", "heading", "blockquote", "bullet_list", "ordered_list", "list_item", "code_block", "horizontal_rule", "hard_break", "captionedImage", "image2", "caption", "paywall"]);

/** Static review aid, deliberately not a complete Substack schema validator. */
export function preflightDraft(draft: unknown, requestedId: number) {
  if (!object(draft) || draft.id !== requestedId) throw new Error("Unexpected draft response or mismatched draft ID.");
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (severity: Finding["severity"], code: string, message: string) => {
    if (!seen.has(code)) { findings.push({ severity, code, message }); seen.add(code); }
  };
  if (typeof draft.draft_title !== "string" || !draft.draft_title.trim()) add("error", "missing_title", "Add a draft title.");
  if (!["everyone", "only_paid", "founding", "only_free"].includes(String(draft.audience))) add("error", "unknown_audience", "Check the draft audience in Substack.");
  if (draft.is_published === true) add("warning", "already_published", "This draft belongs to a published post; review its current state in the editor.");
  let root: unknown;
  if (typeof draft.draft_body !== "string" || !draft.draft_body.trim()) add("error", "missing_body", "Add draft content.");
  else if (draft.draft_body.length > 2_000_000) add("error", "body_limit", "Body exceeds the two-million-character preflight limit; inspect it in the editor.");
  else {
    try { root = JSON.parse(draft.draft_body); }
    catch { add("error", "invalid_json", "Draft body is not valid ProseMirror JSON."); }
  }
  let nodes = 0, images = 0, paywalls = 0, textCharacters = 0;
  let countsComplete = false;
  const unknownTypes = new Set<string>();
  if (root !== undefined) {
    if (!object(root) || root.type !== "doc" || !Array.isArray(root.content)) add("error", "invalid_document", "Body must be a doc with a content array.");
    else {
      countsComplete = true;
      const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
      while (stack.length) {
        const { node, depth } = stack.pop()!;
        if (++nodes > 10_000 || depth > 100) { countsComplete = false; add("error", "structure_limit", "Body exceeds preflight structure limits; checks are incomplete."); break; }
        if (!object(node) || typeof node.type !== "string") { add("error", "invalid_node", "Body contains a node without a valid type."); continue; }
        if (!knownNodes.has(node.type) && unknownTypes.size < 5) unknownTypes.add(node.type.slice(0, 80));
        if (node.type === "text") {
          if (typeof node.text !== "string") add("error", "invalid_text", "A text node is missing its text.");
          else textCharacters += node.text.trim().length;
        }
        if (node.type === "paywall") paywalls++;
        if (node.type === "captionedImage" && (!Array.isArray(node.content) || !node.content.some(n => object(n) && n.type === "image2"))) add("error", "image_wrapper", "A captioned image is missing its image2 child.");
        if (node.type === "image2") {
          images++;
          const src = object(node.attrs) ? node.attrs.src : undefined;
          try {
            if (typeof src !== "string") throw new Error();
            const url = new URL(src);
            if (url.protocol !== "https:" || url.username || url.password) throw new Error();
            if (!(url.hostname === "substackcdn.com" || url.hostname.endsWith(".substackcdn.com") || url.hostname === "substack-post-media.s3.amazonaws.com")) add("warning", "external_images", "External images may not render reliably; consider upload_image and review in the editor.");
          } catch { add("error", "invalid_image_url", "An image lacks a valid HTTPS source URL."); }
        }
        if (node.content !== undefined) {
          if (!Array.isArray(node.content)) add("error", "invalid_content", "A node content field is not an array.");
          else for (const child of node.content) stack.push({ node: child, depth: depth + 1 });
        }
      }
      if (unknownTypes.size) add("warning", "unrecognized_nodes", `Node types outside this focused check (up to five shown): ${[...unknownTypes].join(", ")}. Verify their rendering in Substack.`);
      if (countsComplete) {
        if (!textCharacters && !images) add("warning", "no_text_or_images", "No text or image content was found; inspect any embeds in the editor.");
        if (paywalls > 1) add("error", "multiple_paywalls", "Keep at most one paywall break.");
        if (root.content.length && [root.content[0], root.content.at(-1)].some(n => object(n) && n.type === "paywall")) add("warning", "paywall_at_edge", "The paywall is at the start or end of the body; check its placement.");
      }
    }
  }
  return { draft_id: requestedId, checks_passed: !findings.some(f => f.severity === "error"),
    findings, counts: { complete: countsComplete, nodes, images, paywalls, text_characters: textCharacters },
    limitations: "Read-only static checks, not a publish approval or full schema validation. Images, links, embeds, access settings and final rendering require review in Substack. Nothing was modified." };
}

const MAX_SUBSTACK_ITEMS = 50;
const MAX_SUBSTACK_ITEM_CHARS = 300;

export type SubstackCheck =
  | { status: "ok"; errors: string[]; suggestions: string[]; note: string }
  | { status: "unavailable"; reason: string; note: string };

const SUBSTACK_CHECK_NOTE = "Substack's own prepublish validator, reported separately from the static findings. It is undocumented, so its absence or failure does not mean the draft is ready, and a clean result is not publish approval.";

/** Render one prepublish item (a string or an object with a message) as bounded text. */
function itemText(item: unknown): string | null {
  let value: unknown = item;
  if (object(item)) value = item.message ?? item.text ?? item.description ?? item.title ?? item.code ?? JSON.stringify(item);
  if (typeof value !== "string" || !value.trim()) return null;
  // Strip control characters so upstream text cannot break the JSON report.
  const clean = value.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return clean.length > MAX_SUBSTACK_ITEM_CHARS ? `${clean.slice(0, MAX_SUBSTACK_ITEM_CHARS - 1)}…` : clean;
}

/** Normalize the prepublish response; an unexpected shape is reported as unavailable, never guessed. */
export function normalizePrepublish(raw: unknown): SubstackCheck {
  if (!object(raw) || (!Array.isArray(raw.errors) && !Array.isArray(raw.suggestions)) ||
      (raw.errors !== undefined && !Array.isArray(raw.errors)) ||
      (raw.suggestions !== undefined && !Array.isArray(raw.suggestions))) {
    return { status: "unavailable", reason: "unexpected_response", note: SUBSTACK_CHECK_NOTE };
  }
  const list = (v: unknown) => (Array.isArray(v) ? v : []).map(itemText).filter((t): t is string => t !== null).slice(0, MAX_SUBSTACK_ITEMS);
  return { status: "ok", errors: list(raw.errors), suggestions: list(raw.suggestions), note: SUBSTACK_CHECK_NOTE };
}

/** Run the prepublish read; any failure becomes an "unavailable" result so the static preflight still returns. */
export async function runSubstackCheck(read: () => Promise<unknown>): Promise<SubstackCheck> {
  try {
    return normalizePrepublish(await read());
  } catch (error) {
    const status = typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : undefined;
    return { status: "unavailable", reason: status ? `http_${status}` : "request_failed", note: SUBSTACK_CHECK_NOTE };
  }
}
