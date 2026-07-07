/**
 * Tool side-effect classification → MCP tool annotations.
 *
 * Mirrors the gws-mcp-server pattern: every tool declares exactly one
 * side-effect class in an exhaustive registry, and `buildAnnotations` maps
 * that class to MCP annotation hints so clients can reason about side
 * effects and render accurate consent UI. A completeness test asserts the
 * registry matches the set of tools actually registered on the server, so
 * new tools cannot ship unclassified.
 *
 * IMPORTANT — MCP hints default to the UNSAFE direction. Per the spec
 * (schema 2025-06-18), an omitted `destructiveHint` defaults to `true` and an
 * omitted `openWorldHint` defaults to `true`. So we set EVERY relevant hint
 * explicitly on writes; leaving one off would make a reversible private draft
 * edit read to a conformant client as destructive and open-world. Annotations
 * are also untrusted hints — the authoritative consent surface is the tool
 * description, so descriptions carry the load-bearing wording (e.g. that
 * `upload_image` returns a publicly-fetchable URL).
 *
 * `openWorldHint` convention used here: `true` means the tool's output enters
 * an open world of external entities — a public Substack Note, or a
 * publicly-fetchable CDN image URL. Private draft writes stay in your account
 * and are `false`.
 */

/** Side-effect classes for substack-mcp tools. */
export type ToolKind =
  /** Pure read: no side effects on the user's Substack data. */
  | "read"
  /**
   * Additive write to PRIVATE draft state. Reversible in Substack's editor;
   * nothing becomes reachable outside your account.
   */
  | "draft-write"
  /**
   * Additive write that returns a PUBLICLY FETCHABLE (but unlisted) CDN URL.
   * The image bytes are served without authentication to anyone holding the
   * URL, though the asset is not attributed or added to your feed.
   */
  | "public-upload"
  /**
   * Write with IMMEDIATE PUBLIC effect: Substack Notes publish the moment
   * the tool runs. Notes have no draft state on Substack, and this server
   * has no delete tools, so there is no undo from here.
   */
  | "publish";

/**
 * Exhaustive tool-name → kind registry.
 *
 * This server has NO destructive tools (no deletes) by design — every write
 * is additive, so all writes set `destructiveHint: false` explicitly. If a
 * destructive tool is ever added, set `destructiveHint: true` for it per the
 * MCP spec.
 */
export const TOOL_KINDS = {
  // Reads
  get_subscriber_count: "read",
  list_published_posts: "read",
  list_drafts: "read",
  get_post: "read",
  get_draft: "read",
  get_post_comments: "read",
  // Additive writes to private draft state (nothing reachable outside account)
  create_draft: "draft-write",
  update_draft: "draft-write",
  // Additive write returning a publicly-fetchable CDN URL
  upload_image: "public-upload",
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
 * Map a tool's declared kind into MCP `annotations`, setting every relevant
 * hint EXPLICITLY (never relying on MCP's unsafe-by-default omission).
 *
 * - Reads: `readOnlyHint: true` (destructive/open-world hints are not
 *   meaningful for a read).
 * - Every write is additive, so `destructiveHint: false`.
 * - `openWorldHint` is `true` only when the tool's output becomes reachable
 *   by outside parties: a public Note, or a publicly-fetchable CDN image URL.
 *   Private draft writes are `false`.
 */
export function buildAnnotations(name: ToolName): ToolAnnotationHints {
  switch (TOOL_KINDS[name]) {
    case "read":
      return { readOnlyHint: true };
    case "draft-write":
      return {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      };
    case "public-upload":
      return {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      };
    case "publish":
      return {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      };
  }
}
