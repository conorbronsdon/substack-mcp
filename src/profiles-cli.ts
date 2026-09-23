import { listProfiles, loadProfile, migrateProfile, profileKey } from "./auth/profiles.js";
import { loadSession } from "./auth/session-store.js";
import { createKeychain, credentialStore } from "./auth/keychain.js";

const usage = "Usage: substack-mcp profiles list\n       substack-mcp profiles migrate --name key [--force]\n       substack-mcp profiles migrate --to keychain [--name key] [--force]\nCopies the legacy stored session into a named profile without modifying session.json. Existing profiles require --force. To use profiles set SUBSTACK_PROFILES=key or a comma-separated list, removing publication credential env vars. Unset SUBSTACK_PROFILES to return to legacy configuration. Migration to keychain copies the legacy file session (default) or named file profile (--name), retaining the source file; existing keychain entries require --force. Select keychain with SUBSTACK_CREDENTIAL_STORE=keychain. The default file store is encrypted and machine-bound, not an OS keychain or secret vault.";

export async function runProfiles(args: string[], io = { out: (text: string) => console.log(text), error: (text: string) => console.error(text) }, keychain = createKeychain()): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { io.out(usage); return 0; }
  const list = args.length === 1 && args[0] === "list";
  const migrate = args[0] === "migrate" && args[1] === "--name" && (args.length === 3 || (args.length === 4 && args[3] === "--force"));
  const toKeychain = args[0] === "migrate" && args[1] === "--to" && args[2] === "keychain" && (args.length === 3 || (args.length === 5 && args[3] === "--name") || (args.length === 4 && args[3] === "--force") || (args.length === 6 && args[3] === "--name" && args[5] === "--force"));
  if (!list && !migrate && !toKeychain) { io.error(JSON.stringify({ format_version: 1, ok: false, code: "invalid_arguments", message: usage })); return 2; }
  const key = toKeychain ? args[4] : args[2];
  if (key) {
    try { profileKey(key); } catch { io.error(JSON.stringify({ format_version: 1, ok: false, code: "invalid_profile_key", message: "Use a lowercase letter followed by letters, digits or hyphens; at most 64 characters." })); return 2; }
  }
  try {
    credentialStore();
    if (list) io.out(JSON.stringify({ format_version: 1, ok: true, command: "profiles list", profiles: listProfiles() }));
    else if (toKeychain) {
      const session = key ? loadProfile(key) : loadSession();
      if (!session) throw new Error("Source file session is missing or invalid.");
      if (!key && !args.includes("--force") && await keychain.read("default")) throw Object.assign(new Error("Keychain session already exists."), { code: "EEXIST" });
      await keychain.write(key ?? "default", session, args.includes("--force"));
      io.out(JSON.stringify({ format_version: 1, ok: true, command: "profiles migrate", profile: key ?? null, destination: "keychain", source_file_retained: true }));
    } else { migrateProfile(args[2], args.includes("--force")); io.out(JSON.stringify({ format_version: 1, ok: true, command: "profiles migrate", profile: args[2], legacy_session_retained: true })); }
    return 0;
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
    io.error(JSON.stringify({ format_version: 1, ok: false, code: exists ? "profile_exists" : "profile_operation_failed", message: exists ? "Profile already exists. Choose another name or explicitly use --force." : "Profile operation failed. Check local storage and legacy credentials; inspect saved profiles before retrying. The legacy session was not modified." }));
    return 1;
  }
}
