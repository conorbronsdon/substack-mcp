import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSession, loadSession } from "../auth/session-store.js";

// The stored session's key derives from the non-secret account and host names,
// so file and directory permissions are what keep the cookie from other users.
const posix = process.platform !== "win32";
const session = { publicationUrl: "https://example.substack.com", sessionToken: "example-session-not-real", userId: "42" };
let root: string, home: string;
const original = process.env.SUBSTACK_MCP_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "substack-mcp-perm-"));
  home = join(root, "home");
  process.env.SUBSTACK_MCP_HOME = home;
});

afterEach(() => {
  if (original === undefined) delete process.env.SUBSTACK_MCP_HOME;
  else process.env.SUBSTACK_MCP_HOME = original;
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!posix)("session store permissions", () => {
  it("creates the session directory 0700 and the file 0600", () => {
    const file = saveSession(session);
    expect(file).toBe(join(home, "session.json"));
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(home)).toEqual(["session.json"]);
  });

  it("replaces a session.json symlink instead of writing through it", () => {
    saveSession(session);
    const decoy = join(root, "decoy.txt");
    writeFileSync(decoy, "decoy-contents");
    chmodSync(decoy, 0o644);
    const file = join(home, "session.json");
    rmSync(file);
    symlinkSync(decoy, file);

    saveSession(session);

    expect(readFileSync(decoy, "utf8")).toBe("decoy-contents");
    expect(statSync(decoy).mode & 0o777).toBe(0o644);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it("narrows a pre-existing world-readable session file to 0600", () => {
    saveSession(session);
    const file = join(home, "session.json");
    chmodSync(file, 0o644);
    saveSession(session);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(home)).toEqual(["session.json"]);
  });

  it("still round-trips exact values and never writes the token in plaintext", () => {
    const file = saveSession(session);
    expect(readFileSync(file, "utf8")).not.toContain("example-session-not-real");
    const loaded = loadSession();
    expect(loaded?.publicationUrl).toBe("https://example.substack.com");
    expect(loaded?.sessionToken).toBe("example-session-not-real");
    expect(loaded?.userId).toBe("42");
  });
});
