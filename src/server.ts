import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  SubstackClient,
  MAX_PAGE_SIZE,
  ANALYTICS_SCAN_DEPTH,
} from "./api/client.js";
import { buildAnnotations } from "./annotations.js";
import { markdownToProseMirror, markdownToProseMirrorContent } from "./utils/markdown-to-prosemirror.js";
import { fileToDataUri } from "./utils/image.js";

export interface PublicationConfig {
  /** Tool-facing `publication` enum value, e.g. "kevin-muldoon". */
  key: string;
  /** Human-readable label, e.g. "Kevin Muldoon" — used in descriptions/errors only. */
  label: string;
  client: SubstackClient;
}

export function createServer(publications: PublicationConfig[]): McpServer {
  if (publications.length === 0) {
    throw new Error("createServer requires at least one publication configuration.");
  }

  const server = new McpServer({
    name: "substack-mcp",
    version: "0.6.1",
  });

  const multi = publications.length > 1;
  const pubKeys = publications.map((p) => p.key) as [string, ...string[]];

  // With exactly one publication configured, every tool's schema is left
  // untouched — no `publication` field at all — so single-publication
  // deployments (the common case) see zero change. With 2+, every tool gains
  // a *required* enum field: Zod itself then rejects an unconfigured or
  // missing value before any handler (and therefore any Substack API call)
  // runs, so a write tool can never silently land on the wrong publication.
  function publicationField(): Record<string, z.ZodTypeAny> {
    if (!multi) return {};
    const options = publications.map((p) => `${p.key} (${p.label})`).join(", ");
    return {
      publication: z.enum(pubKeys).describe(`Which publication to operate on. One of: ${options}.`),
    };
  }

  // Unreachable in practice when multi (see publicationField above) — this
  // is a defensive fallback, not the primary validation path.
  function clientFor(publication?: string): SubstackClient {
    if (!multi) return publications[0].client;
    const found = publications.find((p) => p.key === publication);
    if (!found) {
      throw new Error(`Unknown publication "${publication}". Configured: ${pubKeys.join(", ")}.`);
    }
    return found.client;
  }

  // Every tool is registered with MCP annotations derived from its declared
  // side-effect class (see annotations.ts) so clients can render accurate
  // consent UI. Reads are readOnlyHint:true; draft/upload writes are
  // additive; the Note tools publish public content immediately.

  // --- Read tools ---

  server.registerTool("list_subscribers", {
    description: "Read a page of private subscriber email addresses and subscription IDs. Dashboard data may lag recent changes. Use get_subscriber for exact membership checks.",
    inputSchema: { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(10), ...publicationField() },
    annotations: buildAnnotations("list_subscribers"),
  }, async ({ offset, limit, publication }: { offset: number; limit: number; publication?: string }) => ({
    content: [{ type: "text", text: JSON.stringify(await clientFor(publication).subscribers.list(offset, limit)) }],
  }));

  server.registerTool("get_subscriber", {
    description: "Look up a subscriber by exact email address. A listed free subscriber is a member even without paid access. Absence does not prove the address is eligible: Substack may suppress previous unsubscribes, and dashboard data can lag. Read-only; use to reconcile uncertain adds.",
    inputSchema: { email: z.string().trim().email().max(254), ...publicationField() },
    annotations: buildAnnotations("get_subscriber"),
  }, async ({ email, publication }: { email: string; publication?: string }) => ({
    content: [{ type: "text", text: JSON.stringify(await clientFor(publication).subscribers.get(email)) }],
  }));

  server.registerTool("add_free_subscriber", {
    description: "Add one explicitly opted-in reader to this publication's free newsletter. Changes email distribution: future newsletter emails may be delivered. Requires verified newsletter consent; never infer consent from a meeting alone. Dry-run by default; set dry_run=false to write. Never sends a welcome email, grants paid access, or overrides suppression. Existing members are skipped. An unverified result MUST be reconciled using get_subscriber, not automatically retried. Automated callers must persist an attempt ledger BEFORE invoking this tool; in-memory duplicate protection does not survive restarts or separate HTTP sessions.",
    inputSchema: { email: z.string().trim().email().max(254), consent_confirmed: z.literal(true), dry_run: z.boolean().default(true), ...publicationField() },
    annotations: buildAnnotations("add_free_subscriber"),
  }, async ({ email, consent_confirmed, dry_run, publication }: { email: string; consent_confirmed: true; dry_run: boolean; publication?: string }) => ({
    content: [{ type: "text", text: JSON.stringify(await clientFor(publication).subscribers.add(email, consent_confirmed, dry_run)) }],
  }));

  server.registerTool(
    "get_subscriber_count",
    {
      description:
        "Get the current subscriber count for your Substack publication. Returns `precision`: " +
        "'exact' when the API reports a true count, 'approximate' when only Substack's rounded " +
        "value is available (the real number is that or higher — render it hedged, e.g. '1,000+'), " +
        "or 'unavailable' with count -1. Never treat an approximate value as exact.",
      inputSchema: { ...publicationField() },
      annotations: buildAnnotations("get_subscriber_count"),
    },
    async ({ publication }: { publication?: string }) => {
      const result = await clientFor(publication).getSubscriberCount();
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "list_published_posts",
    {
      description: "List published posts with pagination. Returns title, date, slug, and URL for each post.",
      inputSchema: {
        offset: z.number().optional().default(0).describe("Number of posts to skip"),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe(
            `Max posts to return (1-${MAX_PAGE_SIZE}; Substack rejects anything higher, so larger values are clamped)`,
          ),
        ...publicationField(),
      },
      annotations: buildAnnotations("list_published_posts"),
    },
    async ({ offset, limit, publication }: { offset: number; limit: number; publication?: string }) => {
      const { posts, total } = await clientFor(publication).getPublishedPosts(offset, Math.min(limit, MAX_PAGE_SIZE));
      const summary = posts.map((p) => ({
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        slug: p.slug,
        post_date: p.post_date,
        audience: p.audience,
        word_count: p.word_count,
        url: p.canonical_url,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ total, posts: summary }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "list_drafts",
    {
      description: "List draft posts. Returns title, creation date, and audience for each draft.",
      inputSchema: {
        offset: z.number().optional().default(0).describe("Number of drafts to skip"),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe(
            `Max drafts to return (1-${MAX_PAGE_SIZE}; Substack rejects anything higher, so larger values are clamped)`,
          ),
        ...publicationField(),
      },
      annotations: buildAnnotations("list_drafts"),
    },
    async ({ offset, limit, publication }: { offset: number; limit: number; publication?: string }) => {
      const drafts = await clientFor(publication).getDrafts(offset, Math.min(limit, MAX_PAGE_SIZE));
      const summary = drafts.map((d) => ({
        id: d.id,
        title: d.draft_title,
        subtitle: d.draft_subtitle,
        audience: d.audience,
        word_count: d.word_count,
        created_at: d.draft_created_at,
        updated_at: d.draft_updated_at,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_post",
    {
      description: "Get the full content of a published post by ID. Returns title, body HTML, metadata.",
      inputSchema: {
        post_id: z.number().describe("The post ID to retrieve"),
        ...publicationField(),
      },
      annotations: buildAnnotations("get_post"),
    },
    async ({ post_id, publication }: { post_id: number; publication?: string }) => {
      const post = await clientFor(publication).getPost(post_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: post.id,
                title: post.title,
                subtitle: post.subtitle,
                slug: post.slug,
                post_date: post.post_date,
                audience: post.audience,
                word_count: post.word_count,
                body_html: post.body_html,
                url: post.canonical_url,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_draft",
    {
      description: "Get the full content of a draft post by ID. Returns title, body, metadata.",
      inputSchema: {
        draft_id: z.number().describe("The draft ID to retrieve"),
        ...publicationField(),
      },
      annotations: buildAnnotations("get_draft"),
    },
    async ({ draft_id, publication }: { draft_id: number; publication?: string }) => {
      const draft = await clientFor(publication).getDraft(draft_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: draft.id,
                title: draft.draft_title,
                subtitle: draft.draft_subtitle,
                body: draft.draft_body,
                audience: draft.audience,
                word_count: draft.word_count,
                created_at: draft.draft_created_at,
                updated_at: draft.draft_updated_at,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_post_comments",
    {
      description: "Get comments on a published post. Returns commenter name, comment body, date, and reaction counts.",
      inputSchema: {
        post_id: z.number().describe("The post ID to get comments for"),
        limit: z.number().optional().default(20).describe("Max comments to return (default 20)"),
        ...publicationField(),
      },
      annotations: buildAnnotations("get_post_comments"),
    },
    async ({ post_id, limit, publication }: { post_id: number; limit: number; publication?: string }) => {
      const comments = await clientFor(publication).getPostComments(post_id, limit);
      const summary = comments.map((c) => ({
        id: c.id,
        name: c.name,
        body: c.body,
        date: c.date,
        reactions: c.reactions,
        replies: c.children_count,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_sections",
    {
      description:
        "List your publication's sections (categories). Returns each section's id and name. Use a section id as `section_id` when creating or updating a draft to file it under that section.",
      inputSchema: { ...publicationField() },
      annotations: buildAnnotations("get_sections"),
    },
    async ({ publication }: { publication?: string }) => {
      const sections = await clientFor(publication).getSections();
      const summary = sections.map((s) => ({ id: s.id, name: s.name }));
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_post_analytics",
    {
      description:
        "Get performance stats (views, emails sent/delivered/opened, signups, subscribes, estimated value, comments, reactions) for a published post by ID. " +
        `Substack has no per-post stats endpoint, so this searches your ${ANALYTICS_SCAN_DEPTH} most recent published posts for the ID; returns a not-found note if it isn't among them.`,
      inputSchema: {
        post_id: z.number().describe("The published post ID to get stats for"),
        ...publicationField(),
      },
      annotations: buildAnnotations("get_post_analytics"),
    },
    async ({ post_id, publication }: { post_id: number; publication?: string }) => {
      const post = await clientFor(publication).getPostAnalytics(post_id);
      if (!post) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  found: false,
                  post_id,
                  note: `Post not found among the ${ANALYTICS_SCAN_DEPTH} most recent published posts. Check the ID with list_published_posts.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const stats = post.stats ?? {};
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                found: true,
                id: post.id,
                title: post.title,
                post_date: post.post_date,
                views: stats.views ?? null,
                sent: stats.sent ?? null,
                delivered: stats.delivered ?? null,
                opened: stats.opened ?? null,
                signups: stats.signups ?? null,
                subscribes: stats.subscribes ?? null,
                estimated_value: stats.estimated_value ?? null,
                comment_count: post.comment_count ?? null,
                reaction_count: post.reaction_count ?? null,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_scheduled_posts",
    {
      description:
        "List posts scheduled for future publication, soonest first. Read-only visibility into what's queued — scheduling itself is done in Substack's editor (this server does not schedule, publish, or delete long-form posts). Returns id, title, audience, and scheduled time (`trigger_at`).",
      inputSchema: {
        offset: z.number().optional().default(0).describe("Number of posts to skip"),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe(
            `Max posts to return (1-${MAX_PAGE_SIZE}; Substack rejects anything higher, so larger values are clamped)`,
          ),
        ...publicationField(),
      },
      annotations: buildAnnotations("list_scheduled_posts"),
    },
    async ({ offset, limit, publication }: { offset: number; limit: number; publication?: string }) => {
      const posts = await clientFor(publication).getScheduledPosts(offset, Math.min(limit, MAX_PAGE_SIZE));
      const summary = posts.map((p) => ({
        id: p.id,
        title: p.draft_title ?? p.title ?? null,
        audience: p.audience,
        scheduled_at: p.trigger_at,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  // --- Write tools (additive: private drafts + a public-URL image upload) ---

  server.registerTool(
    "create_draft",
    {
      description: "Create a new draft post. Accepts markdown body which is converted to Substack's format. Does NOT publish — creates a draft only.",
      inputSchema: {
        title: z.string().describe("Post title"),
        body: z.string().optional().describe("Post body in markdown format"),
        subtitle: z.string().optional().describe("Post subtitle"),
        audience: z
          .enum(["everyone", "only_paid", "founding", "only_free"])
          .optional()
          .default("everyone")
          .describe("Who can see this post"),
        ...publicationField(),
      },
      annotations: buildAnnotations("create_draft"),
    },
    async ({
      title,
      body,
      subtitle,
      audience,
      publication,
    }: {
      title: string;
      body?: string;
      subtitle?: string;
      audience: "everyone" | "only_paid" | "founding" | "only_free";
      publication?: string;
    }) => {
      const prosemirrorBody = body ? markdownToProseMirror(body) : undefined;
      const draft = await clientFor(publication).createDraft(
        title,
        prosemirrorBody,
        subtitle,
        audience,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: draft.id,
                title: draft.draft_title,
                message: "Draft created successfully. Open Substack to review and publish.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "update_draft",
    {
      description: "Update an existing draft post. Only works on unpublished drafts. Accepts markdown body.",
      inputSchema: {
        draft_id: z.number().describe("The draft ID to update"),
        title: z.string().optional().describe("New title"),
        subtitle: z.string().optional().describe("New subtitle"),
        body: z.string().optional().describe("New body in markdown format"),
        audience: z
          .enum(["everyone", "only_paid", "founding", "only_free"])
          .optional()
          .describe("Who can see this post"),
        ...publicationField(),
      },
      annotations: buildAnnotations("update_draft"),
    },
    async ({
      draft_id,
      title,
      subtitle,
      body,
      audience,
      publication,
    }: {
      draft_id: number;
      title?: string;
      subtitle?: string;
      body?: string;
      audience?: "everyone" | "only_paid" | "founding" | "only_free";
      publication?: string;
    }) => {
      const updates: Record<string, unknown> = {};
      if (title !== undefined) updates.draft_title = title;
      if (subtitle !== undefined) updates.draft_subtitle = subtitle;
      if (body !== undefined) updates.draft_body = markdownToProseMirror(body);
      if (audience !== undefined) updates.audience = audience;

      const draft = await clientFor(publication).updateDraft(draft_id, updates);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: draft.id,
                title: draft.draft_title,
                message: "Draft updated successfully.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "upload_image",
    {
      description:
        "Upload an image to Substack's CDN. Provide exactly one of `image_base64` (a base64 data URI) or `image_path` (a local file path). Returns a hosted image URL that is publicly fetchable by anyone with the link (an unlisted asset — not attributed to you or added to your feed).",
      inputSchema: {
        image_base64: z
          .string()
          .optional()
          .describe(
            'Base64-encoded image with data URI prefix (e.g., "data:image/png;base64,..."). Mutually exclusive with image_path.',
          ),
        image_path: z
          .string()
          .optional()
          .describe(
            'Absolute path to a local image file (e.g., "/Users/me/pic.png"). Read and encoded automatically; MIME type inferred from the extension. Mutually exclusive with image_base64.',
          ),
        ...publicationField(),
      },
      annotations: buildAnnotations("upload_image"),
    },
    async ({
      image_base64,
      image_path,
      publication,
    }: {
      image_base64?: string;
      image_path?: string;
      publication?: string;
    }) => {
      if (!image_base64 === !image_path) {
        throw new Error(
          "Provide exactly one of `image_base64` or `image_path`.",
        );
      }
      const dataUri = image_path
        ? await fileToDataUri(image_path)
        : (image_base64 as string);
      const result = await clientFor(publication).uploadImage(dataUri);
      return {
        content: [
          { type: "text", text: JSON.stringify({ image_url: result.url }) },
        ],
      };
    },
  );

  // --- Note tools (PUBLISH IMMEDIATELY — public the moment they run) ---

  server.registerTool(
    "create_note",
    {
      description: "Create a Substack Note (short-form content). Accepts markdown text. PUBLISHES IMMEDIATELY to your public Notes feed — Notes have no draft state on Substack, and this server has no delete tools, so there is no undo from here.",
      inputSchema: {
        body: z.string().describe("Note content in markdown format"),
        ...publicationField(),
      },
      annotations: buildAnnotations("create_note"),
    },
    async ({ body, publication }: { body: string; publication?: string }) => {
      const bodyJson = {
        type: "doc" as const,
        attrs: { schemaVersion: "v1" as const },
        content: markdownToProseMirrorContent(body),
      };
      const note = await clientFor(publication).createNote(bodyJson);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: note.id,
                body: note.body,
                date: note.date,
                message: "Note published successfully.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "create_note_with_link",
    {
      description: "Create a Substack Note with a link attachment, displayed as a rich card below the note text. PUBLISHES IMMEDIATELY to your public Notes feed — same caveats as create_note: no draft state, no undo from this server.",
      inputSchema: {
        body: z.string().describe("Note content in markdown format"),
        url: z.string().url().describe("URL to attach as a link card"),
        ...publicationField(),
      },
      annotations: buildAnnotations("create_note_with_link"),
    },
    async ({ body, url, publication }: { body: string; url: string; publication?: string }) => {
      const client = clientFor(publication);
      const attachment = await client.createNoteAttachment(url);
      const bodyJson = {
        type: "doc" as const,
        attrs: { schemaVersion: "v1" as const },
        content: markdownToProseMirrorContent(body),
      };
      const note = await client.createNote(bodyJson, [attachment.id]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: note.id,
                body: note.body,
                date: note.date,
                attachment_id: attachment.id,
                message: "Note with link published successfully.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}
