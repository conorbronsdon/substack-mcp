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
  /\bsessionToken["']?\s*:\s*(["'`])((?:(?!\1).)*)\1/g,
  // SUBSTACK_SESSION_TOKEN / SUBSTACK_PUB_<KEY>_SESSION_TOKEN / SUBSTACK_READER_SESSION_TOKEN: "<token>"
  /SESSION_TOKEN\s*["']?\s*:\s*(["'`])((?:(?!\1).)*)\1/gi,
  // literal cookie values in a Cookie header string
  /\b(?:connect|substack)\.sid=()([^;"'`\s$]+)/g,
  // a token-named variable passed on by identifier: const testSessionToken = "<token>"
  /\b(?:const|let|var)\s+\w*[Tt]oken\w*\s*=\s*(["'`])((?:(?!\1).)*)\1/g,
];

// A value that starts with a bare `${name}` reference takes its token from that
// variable, which the last pattern checks where it is assigned (malformed-cookie
// tests append junk such as `${token}; other=value`). Anything else that starts
// with `${`, such as a call like `${randomUUID()}`, is not an example-* value.
const IDENTIFIER_REFERENCE = /^\$\{\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\}/;

export function nonExampleCredentials(source: string): string[] {
  const found: string[] = [];
  for (const pattern of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const value = match[2];
      if (value.trim() === "" || IDENTIFIER_REFERENCE.test(value)) continue;
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
    expect(nonExampleCredentials('{"sessionToken": "abcdef"}')).toEqual(["abcdef"]);
    expect(nonExampleCredentials('{ SUBSTACK_PUB_A_SESSION_TOKEN: "FAKE-A" }')).toEqual(["FAKE-A"]);
    expect(nonExampleCredentials('{ Cookie: "connect.sid=s%3Aprivate;" }')).toEqual(["s%3Aprivate"]);
    expect(nonExampleCredentials("{ sessionToken: `${randomUUID()}` }")).toEqual(["${randomUUID()}"]);
    expect(nonExampleCredentials('const testSessionToken = "mytoken";\nconst c = { sessionToken: testSessionToken };')).toEqual(["mytoken"]);

    expect(nonExampleCredentials('new SubstackClient(origin, "example-token", "1")')).toEqual([]);
    expect(nonExampleCredentials('{ sessionToken: "example-private-token", other: "" }')).toEqual([]);
    expect(nonExampleCredentials('{ SUBSTACK_SESSION_TOKEN: "", SUBSTACK_PUB_A_SESSION_TOKEN: "   " }')).toEqual([]);
    expect(nonExampleCredentials('{ Cookie: "connect.sid=s%3Aexample-private; substack.sid=${token};" }')).toEqual([]);
    expect(nonExampleCredentials("{ sessionToken: `${testSessionToken}` }")).toEqual([]);
    expect(nonExampleCredentials("{ SUBSTACK_SESSION_TOKEN: `${testSessionToken}; other=value` }")).toEqual([]);
    expect(nonExampleCredentials("const testSessionToken = `example-${randomUUID()}`;")).toEqual([]);
  });

  it("every test and test-config file uses example-* session tokens", () => {
    const self = fileURLToPath(import.meta.url);
    const testsDir = dirname(self);
    const root = join(testsDir, "..", "..");
    // Every test source, fixture and script, whatever its extension, so a new
    // file class (a JSON session fixture, an .mjs helper) is scanned, not skipped.
    const SCANNED = /\.(?:ts|mts|cts|js|mjs|cjs|json)$/;
    const walk = (dir: string) =>
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter(file => SCANNED.test(file) && !file.split(/[\\/]/).includes("__snapshots__"))
        .map(file => join(dir, file));
    const files = [
      ...walk(testsDir),
      ...walk(join(root, "cloud", "test")),
      ...walk(join(root, "scripts")),
      join(root, "cloud", "vitest.config.ts"),
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
