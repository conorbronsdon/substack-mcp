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
];

const ADDITIVE_WRITE_TOOLS: ToolName[] = [
  "create_draft",
  "update_draft",
  "upload_image",
];

const PUBLISH_TOOLS: ToolName[] = ["create_note", "create_note_with_link"];

describe("buildAnnotations mapping", () => {
  it("read -> { readOnlyHint: true } and nothing else", () => {
    const a = buildAnnotations("get_post");
    expect(a).toEqual({ readOnlyHint: true });
  });

  it("additive write -> { readOnlyHint: false } with no destructive or open-world hint", () => {
    const a = buildAnnotations("create_draft");
    expect(a).toEqual({ readOnlyHint: false });
    expect(a.destructiveHint).toBeUndefined();
    expect(a.openWorldHint).toBeUndefined();
  });

  it("publish (Notes) -> { readOnlyHint: false, openWorldHint: true }", () => {
    const a = buildAnnotations("create_note");
    expect(a).toEqual({ readOnlyHint: false, openWorldHint: true });
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

  it("additive writes are readOnlyHint:false with no destructive or open-world hint", () => {
    for (const name of ADDITIVE_WRITE_TOOLS) {
      const a = buildAnnotations(name);
      expect(a.readOnlyHint, name).toBe(false);
      expect(a.destructiveHint, name).toBeUndefined();
      expect(a.openWorldHint, name).toBeUndefined();
    }
  });

  it("Note tools (immediate public publish) carry openWorldHint:true", () => {
    for (const name of PUBLISH_TOOLS) {
      const a = buildAnnotations(name);
      expect(a.readOnlyHint, name).toBe(false);
      expect(a.openWorldHint, name).toBe(true);
    }
  });

  it("no tool is destructive (this server has no deletes by design)", () => {
    for (const name of Object.keys(TOOL_KINDS) as ToolName[]) {
      expect(buildAnnotations(name).destructiveHint, name).toBeUndefined();
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
    const grouped = [...READ_TOOLS, ...ADDITIVE_WRITE_TOOLS, ...PUBLISH_TOOLS];
    expect(grouped.sort()).toEqual(Object.keys(TOOL_KINDS).sort());
  });
});
