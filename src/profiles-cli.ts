import { listProfiles, migrateProfile, profileKey } from "./auth/profiles.js";

const usage = "Usage: substack-mcp profiles list\n       substack-mcp profiles migrate --name key [--force]\nCopies the legacy stored session into a named profile without modifying session.json. Existing profiles require --force. To use profiles set SUBSTACK_PROFILES=key or a comma-separated list, removing publication credential env vars. Unset SUBSTACK_PROFILES to return to legacy configuration. Storage is encrypted and machine-bound, not an OS keychain or secret vault.";

export async function runProfiles(args: string[], io = { out: (text: string) => console.log(text), error: (text: string) => console.error(text) }): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { io.out(usage); return 0; }
  const list = args.length === 1 && args[0] === "list";
  const migrate = args[0] === "migrate" && args[1] === "--name" && (args.length === 3 || (args.length === 4 && args[3] === "--force"));
  if (!list && !migrate) { io.error(JSON.stringify({ format_version: 1, ok: false, code: "invalid_arguments", message: usage })); return 2; }
  if (migrate) {
    try { profileKey(args[2]); } catch { io.error(JSON.stringify({ format_version: 1, ok: false, code: "invalid_profile_key", message: "Use a lowercase letter followed by letters, digits or hyphens; at most 64 characters." })); return 2; }
  }
  try {
    if (list) io.out(JSON.stringify({ format_version: 1, ok: true, command: "profiles list", profiles: listProfiles() }));
    else { migrateProfile(args[2], args.includes("--force")); io.out(JSON.stringify({ format_version: 1, ok: true, command: "profiles migrate", profile: args[2], legacy_session_retained: true })); }
    return 0;
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
    io.error(JSON.stringify({ format_version: 1, ok: false, code: exists ? "profile_exists" : "profile_operation_failed", message: exists ? "Profile already exists. Choose another name or explicitly use --force." : "Profile operation failed. Check local storage and legacy credentials; inspect saved profiles before retrying. The legacy session was not modified." }));
    return 1;
  }
}
