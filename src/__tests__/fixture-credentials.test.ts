import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// AGENTS.md: synthetic credential fixtures must be clearly `example-*`-prefixed,
// so a reviewer (or a secret scanner) can tell a fixture from a pasted session.
// This guard covers the literal shapes the suites use to pass a session token.
// Empty and whitespace-only values are allowed: they test missing credentials.

const PATTERNS: RegExp[] = [
  // new SubstackClient(origin, "<token>", ...)
  /new SubstackClient\(\s*[^,]+,\s*(["'`])((?:(?!\1).)*)\1/g,
  // sessionToken: "<token>"
  /\bsessionToken\s*:\s*(["'`])((?:(?!\1).)*)\1/g,
  // SUBSTACK_SESSION_TOKEN / SUBSTACK_PUB_<KEY>_SESSION_TOKEN / SUBSTACK_READER_SESSION_TOKEN: "<token>"
  /SESSION_TOKEN\s*["']?\s*:\s*(["'`])((?:(?!\1).)*)\1/gi,
  // literal cookie values in a Cookie header string
  /\b(?:connect|substack)\.sid=()([^;"'`\s$]+)/g,
];

export function nonExampleCredentials(source: string): string[] {
  const found: string[] = [];
  for (const pattern of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const value = match[2];
      if (value.trim() === "" || value.startsWith("${")) continue;
      // A URL-encoded signed cookie keeps its `s%3A` / `s:` prefix before the name.
      const name = value.replace(/^s(?:%3A|:)/i, "");
      if (!name.startsWith("example-")) found.push(value);
    }
  }
  return found;
}

describe("synthetic credential fixtures", () => {
  it("flags non-example session tokens and accepts example-* ones", () => {
    expect(nonExampleCredentials('new SubstackClient("https://example.substack.com", "tok", "1")')).toEqual(["tok"]);
    expect(nonExampleCredentials('{ sessionToken: "mytoken" }')).toEqual(["mytoken"]);
    expect(nonExampleCredentials('{ SUBSTACK_PUB_A_SESSION_TOKEN: "FAKE-A" }')).toEqual(["FAKE-A"]);
    expect(nonExampleCredentials('{ Cookie: "connect.sid=s%3Aprivate;" }')).toEqual(["s%3Aprivate"]);

    expect(nonExampleCredentials('new SubstackClient(origin, "example-token", "1")')).toEqual([]);
    expect(nonExampleCredentials('{ sessionToken: "example-private-token", other: "" }')).toEqual([]);
    expect(nonExampleCredentials('{ SUBSTACK_SESSION_TOKEN: "", SUBSTACK_PUB_A_SESSION_TOKEN: "   " }')).toEqual([]);
    expect(nonExampleCredentials('{ Cookie: "connect.sid=s%3Aexample-private; substack.sid=${token};" }')).toEqual([]);
  });

  it("every test and test-config file uses example-* session tokens", () => {
    const self = fileURLToPath(import.meta.url);
    const testsDir = dirname(self);
    const root = join(testsDir, "..", "..");
    const cloudTests = join(root, "cloud", "test");
    const files = [
      ...readdirSync(testsDir).filter(file => file.endsWith(".ts")).map(file => join(testsDir, file)),
      ...readdirSync(cloudTests).filter(file => file.endsWith(".ts")).map(file => join(cloudTests, file)),
      join(root, "cloud", "vitest.config.ts"),
      join(root, "scripts", "test-package.mjs"),
    ].filter(file => file !== self);
    // The scan must reach the cloud worker suite and the package test, not only this directory.
    expect(files.map(file => relative(root, file).split(sep).join("/"))).toEqual(
      expect.arrayContaining(["cloud/test/worker.test.ts", "cloud/vitest.config.ts", "scripts/test-package.mjs"]),
    );
    const offenders = files.flatMap(file =>
      nonExampleCredentials(readFileSync(file, "utf8")).map(value => `${relative(root, file).split(sep).join("/")}: ${value}`),
    );
    expect(offenders).toEqual([]);
  });
});
