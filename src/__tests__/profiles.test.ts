import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { loadProfile, saveProfile, migrateProfile, listProfiles, profileKey } from "../auth/profiles.js";
import { loadSession, saveSession } from "../auth/session-store.js";
import { resolvePublications } from "../auth/resolve-publications.js";
import { runProfiles } from "../profiles-cli.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});
let dir: string;
const sample = { publicationUrl: "https://example.substack.com", sessionToken: "private-test-token", userId: "42" };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "substack-profile-test-")); vi.stubEnv("SUBSTACK_MCP_HOME", dir); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); expect(dir.startsWith(join(tmpdir(), "substack-profile-test-"))).toBe(true); rmSync(dir, { recursive: true, force: true }); });
describe("named profile storage", () => {
  it("round-trips encrypted profiles without changing legacy storage", () => {
    saveSession(sample); const original = readFileSync(join(dir, "session.json"));
    migrateProfile("work");
    expect(loadProfile("work")).toMatchObject(sample);
    expect(readFileSync(join(dir, "session.json"))).toEqual(original);
    const raw = readFileSync(join(dir, "profile-work.json"), "utf8"); expect(raw).not.toContain(sample.sessionToken); expect(raw).not.toContain(sample.publicationUrl);
    expect(listProfiles()).toEqual([{ key: "work", status: "readable", origin: sample.publicationUrl, saved_at: loadProfile("work").savedAt }]);
    expect(JSON.stringify(listProfiles())).not.toContain(sample.sessionToken);
  });
  it("requires explicit replacement and preserves complete files on rejection", () => {
    saveProfile("work", sample); const original = readFileSync(join(dir, "profile-work.json"));
    const updated = { ...sample, userId: "43" };
    expect(() => saveProfile("work", updated)).toThrow();
    expect(readFileSync(join(dir, "profile-work.json"))).toEqual(original);
    saveProfile("work", updated, true); expect(loadProfile("work").userId).toBe("43");
    expect(readdirSync(dir).some(name => name.endsWith(".tmp"))).toBe(false);
  });
  it("never overwrites a profile created after the early availability check", async () => {
    const original = (await vi.importActual<typeof import("node:fs")>("node:fs")).linkSync;
    vi.mocked(fs.linkSync).mockImplementationOnce((source, target) => {
      writeFileSync(target, "concurrent-profile-bytes");
      original(source, target);
    });
    expect(() => saveProfile("work", sample)).toThrow();
    expect(readFileSync(join(dir, "profile-work.json"), "utf8")).toBe("concurrent-profile-bytes");
    expect(readdirSync(dir).some(name => name.endsWith(".tmp"))).toBe(false);
  });
  it.each(["../work", "WORK", "", "x/y", "x\\y", "x.y", "a".repeat(65), "work,other", " work"])("rejects unsafe profile key %s", key => {
    expect(() => profileKey(key)).toThrow(); expect(() => saveProfile(key, sample)).toThrow(); expect(readdirSync(dir)).toEqual([]);
  });
  it("fails closed on missing, tampered, oversized or non-file profiles", () => {
    expect(() => loadProfile("missing")).toThrow(/no fallback/);
    saveProfile("work", sample);
    const path = join(dir, "profile-work.json"), envelope = JSON.parse(readFileSync(path, "utf8"));
    const bytes = Buffer.from(envelope.data, "base64"); bytes[0] ^= 255; envelope.data = bytes.toString("base64");
    writeFileSync(path, JSON.stringify(envelope)); expect(() => loadProfile("work")).toThrow(/no fallback/);
    writeFileSync(path, "x".repeat(128 * 1024 + 1)); expect(() => loadProfile("work")).toThrow(/no fallback/);
    mkdirSync(join(dir, "profile-directory.json")); expect(() => loadProfile("directory")).toThrow(/no fallback/);
  });
  it("lists healthy and unreadable profiles without activating either", () => {
    saveProfile("work", sample); writeFileSync(join(dir, "profile-broken.json"), "invalid");
    expect(listProfiles()).toEqual([{ key: "broken", status: "unreadable" }, { key: "work", status: "readable", origin: sample.publicationUrl, saved_at: loadProfile("work").savedAt }]);
    expect(() => resolvePublications({ SUBSTACK_PROFILES: "broken" })).toThrow();
  });
  it("validates credentials before creating a profile", () => {
    expect(() => saveProfile("work", { ...sample, userId: "0" })).toThrow();
    expect(() => saveProfile("work", { ...sample, publicationUrl: "http://example.com" })).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
  it("selects profiles explicitly and can return to the untouched legacy session", () => {
    saveSession(sample); migrateProfile("work"); saveProfile("other", { ...sample, publicationUrl: "https://other.substack.com" });
    expect(resolvePublications({ SUBSTACK_PROFILES: "work,other" }).map(p => [p.key, p.publicationUrl])).toEqual([["work", sample.publicationUrl], ["other", "https://other.substack.com"]]);
    expect(resolvePublications({})[0]).toMatchObject({ key: "default", ...sample }); expect(loadSession()).toMatchObject(sample);
  });
  it.each([
    { SUBSTACK_PROFILES: "" }, { SUBSTACK_PROFILES: "work,work" }, { SUBSTACK_PROFILES: "work, other" },
    { SUBSTACK_PROFILES: "missing" }, { SUBSTACK_PROFILES: "work", SUBSTACK_PUBLICATION_URL: "" },
    { SUBSTACK_PROFILES: "work", SUBSTACK_PUB_OTHER_USER_ID: "1" },
  ])("never falls back or combines explicit profile mode with credential env vars: %j", env => {
    saveProfile("work", sample); const legacy = vi.fn(() => ({ ...sample, savedAt: new Date().toISOString() }));
    expect(() => resolvePublications(env, legacy)).toThrow(); expect(legacy).not.toHaveBeenCalled();
  });
  it("migrates through the CLI with a credential-safe result and refuses overwrite", async () => {
    saveSession(sample); const io = { out: vi.fn(), error: vi.fn() };
    expect(await runProfiles(["migrate", "--name", "work"], io)).toBe(0);
    expect(JSON.parse(io.out.mock.calls[0][0])).toMatchObject({ profile: "work", legacy_session_retained: true });
    expect(await runProfiles(["migrate", "--name", "work"], io)).toBe(1);
    expect(JSON.parse(io.error.mock.calls[0][0]).code).toBe("profile_exists");
    expect(JSON.stringify(io.out.mock.calls)).not.toContain(sample.sessionToken);
  });
});
