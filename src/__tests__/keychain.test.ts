import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeychain, credentialStore, CredentialStoreError, type KeychainRunner } from "../auth/keychain.js";
import { resolveSelectedPublications } from "../auth/resolve-publications.js";
import { saveSession } from "../auth/session-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../doctor.js";

const sample = { publicationUrl: "https://example.substack.com", sessionToken: "example-keychain-token", userId: "42" };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function fake(platform: NodeJS.Platform) {
  const entries = new Map<string, string>();
  const calls: { file: string; args: string[]; input: string }[] = [];
  const run: KeychainRunner = async (file, args, input) => {
    calls.push({ file, args, input });
    const operation = platform === "linux" ? args[0] === "store" ? "write" : args[0] === "lookup" ? "read" : "delete"
      : platform === "darwin" ? args[0] === "-i" ? "write" : args[0] === "find-generic-password" ? "read" : "delete"
      : input.includes("$v.Add(") ? "write" : input.includes("$v.Remove($c)") ? "delete" : "read";
    const account = platform === "win32" ? Buffer.from(/\$a=.*?FromBase64String\('([^']+)'\)/.exec(input)![1], "base64").toString() : platform === "darwin" ? operation === "write" ? / -a ([^ ]+)/.exec(input)![1] : args[args.indexOf("-a") + 1] : args.at(-1)!;
    if (operation === "write") {
      entries.set(account, platform === "win32" ? Buffer.from(/\$s=.*?FromBase64String\('([^']+)'\)/.exec(input)![1], "base64").toString() : platform === "darwin" ? JSON.parse(input.slice(input.indexOf(" -w ") + 4).trim()) : input.trim());
      return { code: 0, stdout: "", stderr: "" };
    }
    if (operation === "delete") { entries.delete(account); return { code: 0, stdout: "", stderr: "" }; }
    const value = entries.get(account);
    return value ? { code: 0, stdout: value, stderr: "" } : { code: platform === "darwin" ? 44 : platform === "win32" ? 3 : 1, stdout: "", stderr: "" };
  };
  return { entries, calls, keychain: createKeychain(platform, run) };
}

describe("opt-in keychain", () => {
  it.each(["linux", "darwin", "win32"] as NodeJS.Platform[])("round trips %s with secret only on stdin", async platform => {
    const { keychain, calls } = fake(platform);
    await keychain.write("work", sample);
    expect(JSON.stringify(calls.at(-1)!.args)).not.toContain(sample.sessionToken);
    expect(await keychain.read("work")).toMatchObject(sample);
    await expect(keychain.write("work", sample)).rejects.toMatchObject({ code: "profile_exists" });
    await keychain.delete("work"); expect(await keychain.read("work")).toBeNull();
    for (const call of calls) {
      expect(JSON.stringify(call.args)).not.toContain(sample.sessionToken);
      expect(call.input.includes(sample.sessionToken) || call.input.includes(Buffer.from(sample.sessionToken).toString("base64")) || !call.input.includes("savedAt")).toBe(true);
    }
    const write = calls.find(c => c.input.includes("savedAt") || c.input.includes("$v.Add("))!;
    expect(write.file).toBe(platform === "darwin" ? "/usr/bin/security" : platform === "linux" ? "secret-tool" : "powershell.exe");
    expect(write.args).toEqual(platform === "darwin" ? ["-i"] : platform === "linux" ? ["store", "--label=substack-mcp", "service", "substack-mcp", "account", "work"] : ["-NoProfile", "-NonInteractive", "-Command", "-"]);
    if (platform === "win32") {
      expect(write.input).toContain("PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime");
      expect(calls.find(c => c.input.includes("$v.Retrieve("))!.input).toContain("InnerException.HResult -eq -2147023728");
      expect(write.input).not.toContain(sample.sessionToken);
    }
  });
  it("rejects malformed, oversized, and unavailable responses without echo", async () => {
    const secret = "example-secret-never-echo";
    for (const raw of ["not-json", `${JSON.stringify({ ...sample, savedAt: new Date().toISOString() })}${" ".repeat(128 * 1024)}`, JSON.stringify({ ...sample, savedAt: "bad" })]) {
      const keychain = createKeychain("linux", async () => ({ code: 0, stdout: raw, stderr: secret }));
      await expect(keychain.read("work")).rejects.toMatchObject({ code: "invalid_keychain_data" });
    }
    const broken = createKeychain("linux", async () => ({ code: 2, stdout: secret, stderr: secret }));
    await expect(broken.read("work")).rejects.toMatchObject({ code: "keychain_unavailable" });
    try { await broken.read("work"); } catch (error) { expect((error as Error).message).not.toContain(secret); }
    const timeout = createKeychain("linux", async () => { throw new Error(secret); });
    await expect(timeout.read("work")).rejects.toBeInstanceOf(CredentialStoreError);
  });
  it("defaults to file and rejects invalid configuration before lookup", async () => {
    expect(credentialStore({})).toBe("file");
    expect(() => credentialStore({ SUBSTACK_CREDENTIAL_STORE: "bogus" })).toThrow();
    await expect(resolveSelectedPublications({ SUBSTACK_CREDENTIAL_STORE: "bogus" })).rejects.toMatchObject({ code: "invalid_credential_store" });
  });
  it("routes selected keychain profiles without crossing accounts or reading file storage", async () => {
    const { keychain } = fake("linux");
    await keychain.write("first", sample);
    await keychain.write("second", { ...sample, publicationUrl: "https://second.substack.com", sessionToken: "example-second-token" });
    const env = { SUBSTACK_CREDENTIAL_STORE: "keychain", SUBSTACK_PROFILES: "first,second" };
    const pubs = await resolveSelectedPublications(env, keychain);
    expect(pubs.map(p => [p.key, p.publicationUrl, p.sessionToken])).toEqual([
      ["first", sample.publicationUrl, sample.sessionToken],
      ["second", "https://second.substack.com", "example-second-token"],
    ]);
    await expect(resolveSelectedPublications({ ...env, SUBSTACK_PROFILES: "first,wrong" }, keychain)).rejects.toThrow(/no fallback/);
    await expect(resolveSelectedPublications({ ...env, SUBSTACK_PROFILES: "first,second", SUBSTACK_PUB_THIRD_USER_ID: "42" }, keychain)).rejects.toThrow(/cannot be combined/);
  });
  it("does not query keychain for complete named environment credentials", async () => {
    const keychain = createKeychain("linux", async () => { throw new Error("keychain should not be queried"); });
    const result = await resolveSelectedPublications({
      SUBSTACK_CREDENTIAL_STORE: "keychain", SUBSTACK_PUB_FIRST_PUBLICATION_URL: sample.publicationUrl,
      SUBSTACK_PUB_FIRST_SESSION_TOKEN: sample.sessionToken, SUBSTACK_PUB_FIRST_USER_ID: sample.userId,
    }, keychain);
    expect(result[0]).toMatchObject({ key: "first", source: "env", sessionToken: sample.sessionToken });
  });
  it("never falls back to an existing file when keychain is explicitly selected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "substack-keychain-test-"));
    vi.stubEnv("SUBSTACK_MCP_HOME", dir);
    try {
      saveSession(sample);
      const { keychain } = fake("linux");
      const result = await resolveSelectedPublications({ SUBSTACK_CREDENTIAL_STORE: "keychain" }, keychain);
      expect(result[0].source).toBe("none");
      expect(result[0].missing).toEqual(["SUBSTACK_PUBLICATION_URL", "SUBSTACK_SESSION_TOKEN", "SUBSTACK_USER_ID"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects unsafe account keys before issuing a command", async () => {
    const { keychain, calls } = fake("linux");
    await expect(keychain.write("../other", sample)).rejects.toThrow();
    await expect(keychain.read("../other")).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it("does not report a write as saved until readback matches", async () => {
    const keychain = createKeychain("linux", async (_file, args) => args[0] === "store"
      ? { code: 0, stdout: "", stderr: "" }
      : { code: 1, stdout: "", stderr: "" });
    await expect(keychain.write("default", sample)).rejects.toMatchObject({ code: "keychain_unavailable" });
  });
  it("reports selected storage and keychain availability without credential values", async () => {
    vi.stubEnv("SUBSTACK_CREDENTIAL_STORE", "keychain");
    const publications = () => [{ key: "first", label: "First", ...sample, source: "stored" as const, missing: [] }];
    const available = await doctor(false, publications, async () => true);
    expect(available).toMatchObject({ credential_store: "keychain", keychain_availability: "available", ok: true });
    const unavailable = await doctor(false, publications, async () => { throw new Error(sample.sessionToken); });
    expect(unavailable).toMatchObject({ credential_store: "keychain", keychain_availability: "unavailable", ok: false });
    expect(JSON.stringify(unavailable)).not.toContain(sample.sessionToken);
  });
});
