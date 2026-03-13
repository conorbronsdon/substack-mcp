import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SubstackClient } from "./api/client.js";
import { markdownToProseMirror, markdownToProseMirrorContent } from "./utils/markdown-to-prosemirror.js";

export function createServer(client: SubstackClient): McpServer {
  const server = new McpServer({
    name: "substack-mcp",
    version: "0.2.0",
  });

  // --- Read tools ---

  server.tool(
    "get_subscriber_count",
    "Get the current subscriber count for your Substack publication",
    {},
    async () => {
      const result = await client.getSubscriberCount();
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "list_published_posts",
    "List published posts with pagination. Returns title, date, slug, and URL for each post.",
    {
      offset: z.number().optional().default(0).describe("Number of posts to skip"),
      limit: z.number().optional().default(25).describe("Max posts to return (1-100)"),
    },
    async ({ offset, limit }) => {
      const { posts, total } = await client.getPublishedPosts(offset, Math.min(limit, 100));
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

  server.tool(
    "list_drafts",
    "List draft posts. Returns title, creation date, and audience for each draft.",
    {
      offset: z.number().optional().default(0).describe("Number of drafts to skip"),
      limit: z.number().optional().default(25).describe("Max drafts to return (1-100)"),
    },
    async ({ offset, limit }) => {
      const drafts = await client.getDrafts(offset, Math.min(limit, 100));
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

  server.tool(
    "get_post",
    "Get the full content of a published post by ID. Returns title, body HTML, metadata.",
    {
      post_id: z.number().describe("The post ID to retrieve"),
    },
    async ({ post_id }) => {
      const post = await client.getPost(post_id);
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

  server.tool(
    "get_draft",
    "Get the full content of a draft post by ID. Returns title, body, metadata.",
    {
      draft_id: z.number().describe("The draft ID to retrieve"),
    },
    async ({ draft_id }) => {
      const draft = await client.getDraft(draft_id);
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

  server.tool(
    "get_post_comments",
    "Get comments on a published post. Returns commenter name, comment body, date, and reaction counts.",
    {
      post_id: z.number().describe("The post ID to get comments for"),
      limit: z.number().optional().default(20).describe("Max comments to return (default 20)"),
    },
    async ({ post_id, limit }) => {
      const comments = await client.getPostComments(post_id, limit);
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

  // --- Write tools ---

  server.tool(
    "create_draft",
    "Create a new draft post. Accepts markdown body which is converted to Substack's format. Does NOT publish — creates a draft only.",
    {
      title: z.string().describe("Post title"),
      body: z.string().optional().describe("Post body in markdown format"),
      subtitle: z.string().optional().describe("Post subtitle"),
      audience: z
        .enum(["everyone", "only_paid", "founding", "only_free"])
        .optional()
        .default("everyone")
        .describe("Who can see this post"),
    },
    async ({ title, body, subtitle, audience }) => {
      const prosemirrorBody = body ? markdownToProseMirror(body) : undefined;
      const draft = await client.createDraft(
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

  server.tool(
    "update_draft",
    "Update an existing draft post. Only works on unpublished drafts. Accepts markdown body.",
    {
      draft_id: z.number().describe("The draft ID to update"),
      title: z.string().optional().describe("New title"),
      subtitle: z.string().optional().describe("New subtitle"),
      body: z.string().optional().describe("New body in markdown format"),
      audience: z
        .enum(["everyone", "only_paid", "founding", "only_free"])
        .optional()
        .describe("Who can see this post"),
    },
    async ({ draft_id, title, subtitle, body, audience }) => {
      const updates: Record<string, unknown> = {};
      if (title !== undefined) updates.draft_title = title;
      if (subtitle !== undefined) updates.draft_subtitle = subtitle;
      if (body !== undefined) updates.draft_body = markdownToProseMirror(body);
      if (audience !== undefined) updates.audience = audience;

      const draft = await client.updateDraft(draft_id, updates);
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

  server.tool(
    "upload_image",
    "Upload a base64-encoded image to Substack's CDN. Returns the hosted image URL.",
    {
      image_base64: z
        .string()
        .describe(
          'Base64-encoded image with data URI prefix (e.g., "data:image/png;base64,...")',
        ),
    },
    async ({ image_base64 }) => {
      const result = await client.uploadImage(image_base64);
      return {
        content: [
          { type: "text", text: JSON.stringify({ image_url: result.url }) },
        ],
      };
    },
  );

  server.tool(
    "create_note",
    "Create a Substack Note (short-form content). Accepts markdown text. Publishes immediately — there is no draft state for notes.",
    {
      body: z.string().describe("Note content in markdown format"),
    },
    async ({ body }) => {
      const bodyJson = {
        type: "doc" as const,
        attrs: { schemaVersion: "v1" as const },
        content: markdownToProseMirrorContent(body),
      };
      const note = await client.createNote(bodyJson);
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

  server.tool(
    "create_note_with_link",
    "Create a Substack Note with a link attachment. The link is displayed as a rich card below the note text. Publishes immediately.",
    {
      body: z.string().describe("Note content in markdown format"),
      url: z.string().url().describe("URL to attach as a link card"),
    },
    async ({ body, url }) => {
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
