import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { draftTagsInput } from "../api/draft-tags.js";

const require = createRequire(import.meta.url);

describe("zod runtime", () => {
  it("is at least 4.6.6, the GHSA-mrhx-c7xc-m3w5 fix", () => {
    const { version } = JSON.parse(readFileSync(require.resolve("zod/package.json"), "utf8")) as { version: string };
    const [major, minor, patch] = version.split(".").map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(4_006_006);
  });

  it("keeps accepting tag IDs that zod 3 .uuid() accepted", () => {
    const nonRfcVariant = "123e4567-e89b-02d3-c456-426614174000";
    expect(draftTagsInput.safeParse({ draft_id: 1, add: [nonRfcVariant] }).success).toBe(true);
    expect(draftTagsInput.safeParse({ draft_id: 1, add: ["not-a-uuid"] }).success).toBe(false);
  });
});
