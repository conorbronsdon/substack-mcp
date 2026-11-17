/**
 * Resolve Substack credentials from environment variables, falling back to the
 * locally-stored session written by `substack-mcp-login`.
 *
 * Precedence is per-field: an explicit env var always wins, and a stored
 * session fills any gap. This keeps the zero-config env-var path (used in most
 * MCP client configs) working unchanged, while letting the browser-login flow
 * supply credentials when the env vars are absent.
 *
 * One mix is refused: a stored session token paired with an env publication
 * URL on a different origin. The token was captured for the stored origin, so
 * sending it elsewhere would leak it to a host that never issued it.
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

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function resolveCredentials(
  env: NodeJS.ProcessEnv = process.env,
  loader: () => StoredSession | null = loadSession,
): ResolvedCredentials {
  const stored = loader();

  let usedEnv = false;
  let usedStored = false;
  const out: Record<string, string> = {};
  const missing: string[] = [];
  const sources: Record<string, "env" | "stored"> = {};

  for (const [key, envName] of FIELDS) {
    const fromEnv = env[envName];
    if (fromEnv) {
      out[key] = fromEnv;
      sources[key] = "env";
      usedEnv = true;
    } else if (stored && stored[key]) {
      out[key] = stored[key];
      sources[key] = "stored";
      usedStored = true;
    } else {
      out[key] = "";
      missing.push(envName);
    }
  }

  if (sources.sessionToken === "stored" && sources.publicationUrl === "env") {
    const storedOrigin = originOf(stored!.publicationUrl);
    const envOrigin = originOf(out.publicationUrl);
    if (!storedOrigin || storedOrigin !== envOrigin) {
      throw new Error(
        `The stored session was captured for ${storedOrigin ?? "an unparseable publication URL"}, ` +
          `but SUBSTACK_PUBLICATION_URL names ${envOrigin ?? "an unparseable URL"}. ` +
          "Refusing to send the stored session token to a different origin. " +
          "Set SUBSTACK_SESSION_TOKEN for that publication, unset SUBSTACK_PUBLICATION_URL, " +
          "or run substack-mcp-login for it.",
      );
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
