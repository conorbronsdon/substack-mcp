import { describe, it, expect } from "vitest";
import { buildAnnotations, TOOL_KINDS, type ToolName } from "../annotations.js";
import { createServer } from "../server.js";
import type { SubstackClient } from "../api/client.js";

// The server only touches the client inside tool handlers, which these tests
// never invoke — a bare object is enough to register everything.
const server = createServer({} as SubstackClient);

interface RegisteredToolShape {
  description?: string;
  annotations?: Record<string, unknown>;
}

// SDK-private registry; the McpServer API has no public tool introspection.
const registered = (
  server as unknown as { _registeredTools: Record<string, RegisteredToolShape> }
)._registeredTools;

const READ_TOOLS: ToolName[] = [
  "get_subscriber_count",
  "list_published_posts",
  "list_drafts",
  "get_post",
  "get_draft",
  "get_post_comments",
  "get_sections",
  "get_post_analytics",
  "list_scheduled_posts",
];

const DRAFT_WRITE_TOOLS: ToolName[] = ["create_draft", "update_draft"];

const PUBLIC_UPLOAD_TOOLS: ToolName[] = ["upload_image"];

const PUBLISH_TOOLS: ToolName[] = ["create_note", "create_note_with_link"];

describe("buildAnnotations mapping", () => {
  it("read -> { readOnlyHint: true } and nothing else", () => {
    const a = buildAnnotations("get_post");
    expect(a).toEqual({ readOnlyHint: true });
  });

  it("draft write -> readOnlyHint:false, explicitly non-destructive and closed-world", () => {
    const a = buildAnnotations("create_draft");
    expect(a).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("public upload -> openWorldHint:true (returns a publicly-fetchable URL), non-destructive", () => {
    const a = buildAnnotations("upload_image");
    expect(a).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it("publish (Notes) -> readOnlyHint:false, openWorldHint:true, non-destructive", () => {
    const a = buildAnnotations("create_note");
    expect(a).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });
});

describe("tool annotation classifications", () => {
  it("completeness: registered tools and the classification registry match exactly", () => {
    // Every registered tool must be classified, and every classified tool
    // must exist — new tools cannot slip through unannotated, and stale
    // registry entries cannot linger.
    expect(Object.keys(registered).sort()).toEqual(
      Object.keys(TOOL_KINDS).sort(),
    );
  });

  it("every registered tool carries the annotations its classification dictates", () => {
    for (const name of Object.keys(TOOL_KINDS) as ToolName[]) {
      expect(
        registered[name].annotations,
        `${name} annotations should match buildAnnotations`,
      ).toEqual(buildAnnotations(name));
    }
  });

  it("read tools are readOnlyHint:true", () => {
    for (const name of READ_TOOLS) {
      expect(buildAnnotations(name).readOnlyHint, name).toBe(true);
    }
  });

  it("draft writes are readOnlyHint:false, explicitly non-destructive and closed-world", () => {
    for (const name of DRAFT_WRITE_TOOLS) {
      const a = buildAnnotations(name);
      expect(a.readOnlyHint, name).toBe(false);
      expect(a.destructiveHint, name).toBe(false);
      expect(a.openWorldHint, name).toBe(false);
    }
  });

  it("public uploads carry openWorldHint:true (publicly-fetchable URL), non-destructive", () => {
    for (const name of PUBLIC_UPLOAD_TOOLS) {
      const a = buildAnnotations(name);
      expect(a.readOnlyHint, name).toBe(false);
      expect(a.destructiveHint, name).toBe(false);
      expect(a.openWorldHint, name).toBe(true);
    }
  });

  it("Note tools (immediate public publish) carry openWorldHint:true", () => {
    for (const name of PUBLISH_TOOLS) {
      const a = buildAnnotations(name);
      expect(a.readOnlyHint, name).toBe(false);
      expect(a.openWorldHint, name).toBe(true);
    }
  });

  it("no write tool is destructive (this server has no deletes by design)", () => {
    // Writes set destructiveHint explicitly to false — never left to MCP's
    // unsafe default of true. Reads omit it (not meaningful for a read).
    for (const name of [
      ...DRAFT_WRITE_TOOLS,
      ...PUBLIC_UPLOAD_TOOLS,
      ...PUBLISH_TOOLS,
    ]) {
      expect(buildAnnotations(name).destructiveHint, name).toBe(false);
    }
  });

  it("Note tool descriptions say loudly that they publish immediately", () => {
    for (const name of PUBLISH_TOOLS) {
      expect(registered[name].description, name).toMatch(
        /publishes immediately/i,
      );
    }
  });

  it("the classification groups above cover the whole registry", () => {
    const grouped = [
      ...READ_TOOLS,
      ...DRAFT_WRITE_TOOLS,
      ...PUBLIC_UPLOAD_TOOLS,
      ...PUBLISH_TOOLS,
    ];
    expect(grouped.sort()).toEqual(Object.keys(TOOL_KINDS).sort());
  });
});
