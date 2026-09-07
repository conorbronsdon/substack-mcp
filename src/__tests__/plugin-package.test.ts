import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));

describe("Codex plugin package", () => {
  it("launches a pinned public npm package over stdio without embedded credentials", () => {
    const manifest = readJson(".codex-plugin/plugin.json");
    const servers = readJson(".mcp.json").mcpServers;
    expect(manifest.name).toBe("substack-mcp");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(servers).toEqual({
      substack: {
        command: "npx",
        args: ["-y", `@conorbronsdon/substack-mcp@${manifest.version}`],
        env: { MCP_TRANSPORT: "stdio" },
      },
    });
  });

  it("discloses the immediate Notes publishing boundary", () => {
    const manifest = readJson(".codex-plugin/plugin.json");
    expect(manifest.description).toContain("Notes publish immediately");
    expect(manifest.interface.longDescription).toContain("no publish, delete, or schedule tools");
    expect(manifest.interface.longDescription).toContain("Notes publish immediately");
  });
});
