import { spawn } from "node:child_process";
import { z } from "zod";
import { profileKey } from "./profiles.js";
import { validateCredentials } from "./validate-credentials.js";
import type { StoredSession } from "./session-store.js";

const SERVICE = "substack-mcp";
const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 10_000;
const stored = z.object({ publicationUrl: z.string().max(2048), sessionToken: z.string().max(16_384), userId: z.string(), savedAt: z.string().datetime() }).strict();
export class CredentialStoreError extends Error {
  constructor(public readonly code: "invalid_credential_store" | "keychain_unavailable" | "invalid_keychain_data" | "profile_exists", message: string) { super(message); this.name = "CredentialStoreError"; }
}
export function credentialStore(env: NodeJS.ProcessEnv = process.env): "file" | "keychain" {
  const value = env.SUBSTACK_CREDENTIAL_STORE ?? "file";
  if (value !== "file" && value !== "keychain") throw new CredentialStoreError("invalid_credential_store", "SUBSTACK_CREDENTIAL_STORE must be file or keychain.");
  return value;
}
type Platform = NodeJS.Platform;
type Operation = "read" | "write" | "delete";
function command(platform: Platform, operation: Operation, account: string, secret?: string) {
  if (platform === "darwin") {
    const file = "/usr/bin/security";
    if (operation === "write") {
      // security -i reads a command from stdin; the password never enters argv.
      return { file, args: ["-i"], input: `add-generic-password -U -a ${account} -s ${SERVICE} -w ${JSON.stringify(secret)}\n` };
    }
    return { file, args: [operation === "read" ? "find-generic-password" : "delete-generic-password", "-a", account, "-s", SERVICE, ...(operation === "read" ? ["-w"] : [])], input: "" };
  }
  if (platform === "linux") return { file: "secret-tool", args: operation === "write" ? ["store", `--label=${SERVICE}`, "service", SERVICE, "account", account] : [operation === "read" ? "lookup" : "clear", "service", SERVICE, "account", account], input: operation === "write" ? `${secret}\n` : "" };
  if (platform === "win32") {
    // -Command - consumes stdin as commands, so encoded values live in its
    // single stdin script line. Neither value reaches the process argv.
    const encodedAccount = Buffer.from(account).toString("base64");
    const encodedSecret = Buffer.from(secret ?? "").toString("base64");
    const head = `$ErrorActionPreference='Stop';$a=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedAccount}'));$v=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new();`;
    const find = `try{$c=$v.Retrieve('${SERVICE}',$a)}catch{if($_.Exception.HResult -eq -2147023728 -or $_.Exception.InnerException.HResult -eq -2147023728){exit 3}else{exit 2}};`;
    const script = operation === "read" ? head + find + "$c.RetrievePassword();[Console]::Out.Write($c.Password)"
      : operation === "delete" ? head + find + "$v.Remove($c)"
      : head + `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedSecret}'));try{$old=$v.Retrieve('substack-mcp',$a);$v.Remove($old)}catch{if($_.Exception.HResult -ne -2147023728 -and $_.Exception.InnerException.HResult -ne -2147023728){exit 2}};$v.Add(([Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new('substack-mcp',$a,$s)))`;
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "-"], input: `${script}\n` };
  }
  throw new CredentialStoreError("keychain_unavailable", "OS keychain is unsupported on this platform.");
}
export interface KeychainRunner { (file: string, args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> }
export const runKeychainCommand: KeychainRunner = (file, args, input) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = [];
  let outputBytes = 0, exceeded = false, settled = false;
  const timer = setTimeout(() => { exceeded = true; try { child.kill(); } catch {} finally { finish(); } }, TIMEOUT_MS);
  const finish = (result?: { code: number | null; stdout: string; stderr: string }) => {
    if (settled) return; settled = true; clearTimeout(timer);
    if (exceeded || !result) reject(new CredentialStoreError("keychain_unavailable", "OS keychain command failed or timed out. Unlock the keychain and check its CLI installation."));
    else resolve(result);
  };
  child.on("error", () => finish()); child.on("close", code => finish({ code, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8") }));
  for (const [stream, chunks] of [[child.stdout, stdoutChunks], [child.stderr, stderrChunks]] as const) {
    stream.on("data", (bytes: Buffer) => { outputBytes += bytes.length; if (outputBytes > MAX_BYTES) { exceeded = true; try { child.kill(); } catch {} finally { finish(); } return; } chunks.push(bytes); });
  }
  child.stdin.on("error", () => {}); child.stdin.end(input);
});
function accountKey(key: string): string { return key === "default" ? key : profileKey(key); }
function parseSession(raw: string): StoredSession {
  try {
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error();
    const value = stored.parse(JSON.parse(raw));
    validateCredentials(value.publicationUrl, value.sessionToken, value.userId);
    return value;
  } catch { throw new CredentialStoreError("invalid_keychain_data", "Stored keychain credentials are malformed or oversized. Re-run login for this account."); }
}
export function createKeychain(platform: Platform = process.platform, run: KeychainRunner = runKeychainCommand) {
  async function call(operation: Operation, account: string, secret?: string) {
    const spec = command(platform, operation, accountKey(account), secret);
    try { return await run(spec.file, spec.args, spec.input); }
    catch { throw new CredentialStoreError("keychain_unavailable", "OS keychain is unavailable. Unlock it and check its CLI installation; no file fallback was used."); }
  }
  return {
    async read(account: string): Promise<StoredSession | null> {
      const result = await call("read", account);
      const absent = platform === "darwin" ? result.code === 44 : platform === "win32" ? result.code === 3 : result.code === 1 && result.stderr.trim() === "";
      if (absent) return null;
      if (result.code !== 0) throw new CredentialStoreError("keychain_unavailable", "OS keychain lookup failed. Unlock it and check its CLI installation; no file fallback was used.");
      return parseSession(result.stdout);
    },
    async write(account: string, value: Omit<StoredSession, "savedAt">, force = false) {
      accountKey(account); validateCredentials(value.publicationUrl, value.sessionToken, value.userId);
      if (!force && account !== "default" && await this.read(account)) throw new CredentialStoreError("profile_exists", "Keychain profile already exists; use --force to replace it.");
      const secret = JSON.stringify({ ...value, savedAt: new Date().toISOString() } satisfies StoredSession);
      if (Buffer.byteLength(secret) > MAX_BYTES) throw new CredentialStoreError("invalid_keychain_data", "Credentials exceed keychain storage bounds.");
      const result = await call("write", account, secret);
      if (result.code !== 0) throw new CredentialStoreError("keychain_unavailable", "OS keychain write failed. Unlock it and check its CLI installation; inspect the account before retrying.");
      const persisted = await this.read(account);
      const intended = parseSession(secret);
      if (!persisted || persisted.publicationUrl !== intended.publicationUrl || persisted.sessionToken !== intended.sessionToken || persisted.userId !== intended.userId || persisted.savedAt !== intended.savedAt) {
        throw new CredentialStoreError("keychain_unavailable", "OS keychain write could not be verified. Inspect the account before retrying.");
      }
    },
    async delete(account: string) {
      const result = await call("delete", account);
      const absent = platform === "darwin" ? result.code === 44 : platform === "win32" ? result.code === 3 : result.code === 1 && result.stderr.trim() === "";
      if (result.code !== 0 && !absent) throw new CredentialStoreError("keychain_unavailable", "OS keychain delete failed. Unlock it and check its CLI installation.");
    },
    async available() { await this.read("probe-nonexistent-substack-mcp"); return true; },
  };
}
