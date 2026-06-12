/**
 * Tool side-effect classification → MCP tool annotations.
 *
 * Mirrors the gws-mcp-server pattern: every tool declares exactly one
 * side-effect class in an exhaustive registry, and `buildAnnotations` maps
 * that class to MCP annotation hints so clients can reason about side
 * effects and render accurate consent UI. A completeness test asserts the
 * registry matches the set of tools actually registered on the server, so
 * new tools cannot ship unclassified.
 */

/** Side-effect classes for substack-mcp tools. */
export type ToolKind =
  /** Pure read: no side effects on the user's Substack data. */
  | "read"
  /**
   * Additive write to PRIVATE state (drafts, CDN image uploads). Reversible
   * in Substack's editor; nothing becomes public from these tools.
   */
  | "additive-write"
  /**
   * Write with IMMEDIATE PUBLIC effect: Substack Notes publish the moment
   * the tool runs. Notes have no draft state on Substack, and this server
   * has no delete tools, so there is no undo from here.
   */
  | "publish";

/**
 * Exhaustive tool-name → kind registry.
 *
 * This server has NO destructive tools (no deletes) by design. If one is
 * ever added, introduce a "destructive" kind mapping to
 * `{ readOnlyHint: false, destructiveHint: true }` per the MCP spec.
 */
export const TOOL_KINDS = {
  // Reads
  get_subscriber_count: "read",
  list_published_posts: "read",
  list_drafts: "read",
  get_post: "read",
  get_draft: "read",
  get_post_comments: "read",
  // Additive writes (private: drafts and uploads — nothing goes public)
  create_draft: "additive-write",
  update_draft: "additive-write",
  upload_image: "additive-write",
  // Immediate public publishes (Substack Notes)
  create_note: "publish",
  create_note_with_link: "publish",
} as const satisfies Record<string, ToolKind>;

export type ToolName = keyof typeof TOOL_KINDS;

/** MCP tool annotations derived from a tool's side-effect class. */
export interface ToolAnnotationHints {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Map a tool's declared kind into MCP `annotations`.
 *
 * Every tool gets an explicit `readOnlyHint` (true for reads, false for any
 * write) so clients always know the side-effect class. Additive writes carry
 * `readOnlyHint: false` and no destructive hint (matching gws-mcp-server:
 * they create or update reversible private state, never remove data). The
 * Note tools additionally carry `openWorldHint: true` because they publish
 * public content immediately — clients should not treat them as low-stakes
 * writes.
 */
export function buildAnnotations(name: ToolName): ToolAnnotationHints {
  switch (TOOL_KINDS[name]) {
    case "read":
      return { readOnlyHint: true };
    case "additive-write":
      return { readOnlyHint: false };
    case "publish":
      return { readOnlyHint: false, openWorldHint: true };
  }
}
