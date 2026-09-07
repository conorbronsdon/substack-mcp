type Finding = { severity: "error" | "warning"; code: string; message: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const knownNodes = new Set(["doc", "paragraph", "text", "heading", "blockquote", "bullet_list", "ordered_list", "list_item", "code_block", "horizontal_rule", "hard_break", "captionedImage", "image2", "caption", "paywall"]);

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
  if (root !== undefined) {
    if (!object(root) || root.type !== "doc" || !Array.isArray(root.content)) add("error", "invalid_document", "Body must be a doc with a content array.");
    else {
      const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
      while (stack.length) {
        const { node, depth } = stack.pop()!;
        if (++nodes > 10_000 || depth > 100) { add("error", "structure_limit", "Body exceeds preflight structure limits; checks are incomplete."); break; }
        if (!object(node) || typeof node.type !== "string") { add("error", "invalid_node", "Body contains a node without a valid type."); continue; }
        if (!knownNodes.has(node.type)) add("warning", "unrecognized_nodes", "Some node types are outside this focused check; verify their rendering in Substack.");
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
      if (!textCharacters && !images) add("warning", "no_text_or_images", "No text or image content was found; inspect any embeds in the editor.");
      if (paywalls > 1) add("error", "multiple_paywalls", "Keep at most one paywall break.");
      if (root.content.length && [root.content[0], root.content.at(-1)].some(n => object(n) && n.type === "paywall")) add("warning", "paywall_at_edge", "The paywall is at the start or end of the body; check its placement.");
    }
  }
  return { draft_id: requestedId, checks_passed: !findings.some(f => f.severity === "error"),
    findings, counts: { nodes, images, paywalls, text_characters: textCharacters },
    limitations: "Read-only static checks, not a publish approval or full schema validation. Images, links, embeds, access settings and final rendering require review in Substack. Nothing was modified." };
}
