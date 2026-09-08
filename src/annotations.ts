/**
 * Tool side-effect classification → MCP tool annotations.
 *
 * Mirrors the gws-mcp-server pattern: every tool declares exactly one
 * side-effect class in an exhaustive registry, and `buildAnnotations` maps
 * that class to MCP side-effect hints so clients can reason about side
 * effects and render accurate consent UI. A completeness test asserts the
 * registry matches the set of tools actually registered on the server, so
 * new tools cannot ship unclassified.
 *
 * IMPORTANT — MCP hints default to the UNSAFE direction. Per the spec
 * (schema 2025-06-18), an omitted `destructiveHint` defaults to `true` and an
 * omitted `openWorldHint` defaults to `true`. So we set readOnlyHint, destructiveHint, and openWorldHint
 * explicitly on writes, distinguishing replacement from creation. Annotations
 * are also untrusted hints — the authoritative consent surface is the tool
 * description, so descriptions carry the load-bearing wording (e.g. that
 * `upload_image` returns a publicly-fetchable URL).
 *
 * `openWorldHint` convention used here: `true` means the tool's output enters
 * an open world of external entities — a public Substack Note, or a
 * publicly-fetchable CDN image URL, or a change to newsletter recipients.
 * Private draft writes stay in your account
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
  /** Replaces existing private draft fields. */
  | "draft-update"
  /**
   * Additive write that returns a PUBLICLY FETCHABLE (but unlisted) CDN URL.
   * The image bytes are served without authentication to anyone holding the
   * URL, though the asset is not attributed or added to your feed.
   */
  | "public-upload"
  /** Changes who receives future newsletter emails. */
  | "subscriber-write"
  /**
   * Write with IMMEDIATE PUBLIC effect: Substack Notes publish the moment
   * the tool runs. Notes have no draft state on Substack, and this server
   * has no delete tools, so there is no undo from here.
   */
  | "publish";

/**
 * Exhaustive tool-name → kind registry.
 *
 * Updating a draft replaces existing data and carries destructiveHint:true.
 * Creation and additive operations carry destructiveHint:false. No delete or
 * long-form publish tools are exposed.
 */
export const TOOL_KINDS = {
  // Reads
  export_draft: "read",
  list_publication_tags: "read",
  get_post_tags: "read",
  get_publication: "read",
  search_posts: "read",
  preflight_draft: "read",
  plan_draft_update: "read",
  get_subscriber_count: "read",
  list_subscribers: "read",
  get_subscriber: "read",
  add_free_subscriber: "subscriber-write",
  list_published_posts: "read",
  list_drafts: "read",
  get_post: "read",
  get_draft: "read",
  get_post_comments: "read",
  get_sections: "read",
  get_post_analytics: "read",
  list_scheduled_posts: "read",
  // Additive writes to private draft state (nothing reachable outside account)
  create_draft: "draft-write",
  update_draft: "draft-update",
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
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Map a tool's declared kind into MCP `annotations`, setting the read/destructive/open-world
 * hints EXPLICITLY (never relying on MCP's unsafe-by-default omission).
 *
 * - Reads: `readOnlyHint: true` (destructive/open-world hints are not
 *   meaningful for a read).
 * - Draft updates replace data; other current writes are additive.
 * - `openWorldHint` is `true` only when the tool's output becomes reachable
 *   by outside parties: a public Note, or a publicly-fetchable CDN image URL.
 *   Private draft writes are `false`.
 */
export function buildAnnotations(name: ToolName): ToolAnnotationHints {
  switch (TOOL_KINDS[name]) {
    case "read":
      return { readOnlyHint: true };
    case "draft-update":
      return { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false };
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
    case "subscriber-write":
      return { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false };
    case "publish":
      return {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      };
  }
}
