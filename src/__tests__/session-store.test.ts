import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveSession,
  loadSession,
  clearSession,
  sessionDir,
} from "../auth/session-store.js";

let dir: string;
const original = process.env.SUBSTACK_MCP_HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "substack-mcp-test-"));
  process.env.SUBSTACK_MCP_HOME = dir;
});

afterEach(() => {
  if (original === undefined) delete process.env.SUBSTACK_MCP_HOME;
  else process.env.SUBSTACK_MCP_HOME = original;
  rmSync(dir, { recursive: true, force: true });
});

describe("session store", () => {
  it("round-trips a saved session", () => {
    saveSession({
      publicationUrl: "https://x.substack.com",
      sessionToken: "tok",
      userId: "42",
    });
    const loaded = loadSession();
    expect(loaded?.publicationUrl).toBe("https://x.substack.com");
    expect(loaded?.sessionToken).toBe("tok");
    expect(loaded?.userId).toBe("42");
    expect(typeof loaded?.savedAt).toBe("string");
  });

  it("returns null when no session file exists", () => {
    expect(loadSession()).toBeNull();
  });

  it("does not write the token or URL in plaintext", () => {
    saveSession({
      publicationUrl: "https://secret.substack.com",
      sessionToken: "SUPERSECRET",
      userId: "1",
    });
    const raw = readFileSync(join(dir, "session.json"), "utf8");
    expect(raw).not.toContain("SUPERSECRET");
    expect(raw).not.toContain("secret.substack.com");
  });

  it("returns null when the ciphertext is tampered (GCM auth fails)", () => {
    saveSession({
      publicationUrl: "https://x.substack.com",
      sessionToken: "tok",
      userId: "1",
    });
    const file = join(dir, "session.json");
    const env = JSON.parse(readFileSync(file, "utf8"));
    const buf = Buffer.from(env.data, "base64");
    buf[0] ^= 0xff; // flip a byte in the ciphertext
    env.data = buf.toString("base64");
    writeFileSync(file, JSON.stringify(env));
    expect(loadSession()).toBeNull();
  });

  it("returns null for a corrupt, non-JSON file", () => {
    writeFileSync(join(dir, "session.json"), "not json at all");
    expect(loadSession()).toBeNull();
  });

  it("returns null for an unknown envelope version", () => {
    writeFileSync(
      join(dir, "session.json"),
      JSON.stringify({ v: 2, salt: "", iv: "", tag: "", data: "" }),
    );
    expect(loadSession()).toBeNull();
  });

  it("clearSession removes the file", () => {
    saveSession({ publicationUrl: "u", sessionToken: "t", userId: "1" });
    expect(existsSync(join(dir, "session.json"))).toBe(true);
    clearSession();
    expect(existsSync(join(dir, "session.json"))).toBe(false);
    expect(loadSession()).toBeNull();
  });

  it("clearSession is a no-op when nothing is stored", () => {
    expect(() => clearSession()).not.toThrow();
  });

  it("sessionDir honors SUBSTACK_MCP_HOME", () => {
    expect(sessionDir()).toBe(dir);
  });
});
