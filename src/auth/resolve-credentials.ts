/**
 * Resolve Substack credentials from environment variables, falling back to the
 * locally-stored session written by `substack-mcp-login`.
 *
 * Precedence is per-field: an explicit env var always wins, and a stored
 * session fills any gap. This keeps the zero-config env-var path (used in most
 * MCP client configs) working unchanged, while letting the browser-login flow
 * supply credentials when the env vars are absent.
 */
import { loadSession, type StoredSession } from "./session-store.js";

export interface ResolvedCredentials {
  publicationUrl: string;
  sessionToken: string;
  userId: string;
  /** Where each field ultimately came from, for startup diagnostics. */
  source: "env" | "stored" | "mixed" | "none";
  /** Names of the still-missing required variables (empty when complete). */
  missing: string[];
}

const FIELDS = [
  ["publicationUrl", "SUBSTACK_PUBLICATION_URL"],
  ["sessionToken", "SUBSTACK_SESSION_TOKEN"],
  ["userId", "SUBSTACK_USER_ID"],
] as const;

export function resolveCredentials(
  env: NodeJS.ProcessEnv = process.env,
  loader: () => StoredSession | null = loadSession,
): ResolvedCredentials {
  const stored = loader();

  let usedEnv = false;
  let usedStored = false;
  const out: Record<string, string> = {};
  const missing: string[] = [];

  for (const [key, envName] of FIELDS) {
    const fromEnv = env[envName];
    if (fromEnv) {
      out[key] = fromEnv;
      usedEnv = true;
    } else if (stored && stored[key]) {
      out[key] = stored[key];
      usedStored = true;
    } else {
      out[key] = "";
      missing.push(envName);
    }
  }

  const source: ResolvedCredentials["source"] =
    usedEnv && usedStored ? "mixed" : usedEnv ? "env" : usedStored ? "stored" : "none";

  return {
    publicationUrl: out.publicationUrl,
    sessionToken: out.sessionToken,
    userId: out.userId,
    source,
    missing,
  };
}
