/**
 * Resolve credentials for one or more Substack publications.
 *
 * - No `SUBSTACK_PUB_<KEY>_*` vars present: falls back to the existing
 *   single-publication `resolveCredentials()` (plain `SUBSTACK_*` env vars,
 *   with the stored-session fallback), wrapped as a single internal entry.
 *   This is the zero-touch path every existing single-publication deployment
 *   stays on — no `publication` field is ever added to a tool's schema in
 *   this case (see server.ts).
 * - One or more complete `SUBSTACK_PUB_<KEY>_*` triplets present: one entry
 *   per triplet, keyed by a slugified `<KEY>` (e.g. `KEVIN_MULDOON` becomes
 *   `kevin-muldoon`). A triplet missing 1-2 of its 3 vars throws at startup —
 *   this is new, explicitly opt-in config, so a partial triplet is almost
 *   certainly a typo, not something to silently drop. Legacy unprefixed vars
 *   are ignored (with a warning) in this mode, rather than treated as an
 *   implicit unnamed extra publication.
 *
 * Browser-login sessions stay out of scope for named publications: only the
 * single-publication fallback above can ever pull from a stored session.
 */
import { resolveCredentials, type ResolvedCredentials } from "./resolve-credentials.js";
import { loadSession, type StoredSession } from "./session-store.js";

export interface PublicationCredentials {
  /** Tool-facing `publication` enum value, e.g. "kevin-muldoon". Never surfaced when only one publication is configured. */
  key: string;
  /** Human-readable label derived from `key`, e.g. "Kevin Muldoon". Used only in startup logs and the `publication` field's description. */
  label: string;
  publicationUrl: string;
  sessionToken: string;
  userId: string;
  source: ResolvedCredentials["source"];
  missing: string[];
}

type Field = "publicationUrl" | "sessionToken" | "userId";

const PREFIXED_VAR_RE = /^SUBSTACK_PUB_([A-Za-z0-9_]+)_(PUBLICATION_URL|SESSION_TOKEN|USER_ID)$/;

const FIELD_BY_SUFFIX: Record<string, Field> = {
  PUBLICATION_URL: "publicationUrl",
  SESSION_TOKEN: "sessionToken",
  USER_ID: "userId",
};

function slugify(rawKey: string): string {
  return rawKey.toLowerCase().replace(/_/g, "-");
}

function labelFromKey(key: string): string {
  return key
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function resolvePublications(
  env: NodeJS.ProcessEnv = process.env,
  loader: () => StoredSession | null = loadSession,
): PublicationCredentials[] {
  const groups = new Map<string, Partial<Record<Field, string>>>();

  for (const envName of Object.keys(env)) {
    const match = PREFIXED_VAR_RE.exec(envName);
    if (!match) continue;
    const value = env[envName];
    if (!value) continue;
    const [, rawKey, suffix] = match;
    const slug = slugify(rawKey);
    const group = groups.get(slug) ?? {};
    group[FIELD_BY_SUFFIX[suffix]] = value;
    groups.set(slug, group);
  }

  if (groups.size === 0) {
    const creds = resolveCredentials(env, loader);
    return [
      {
        key: "default",
        label: "default",
        publicationUrl: creds.publicationUrl,
        sessionToken: creds.sessionToken,
        userId: creds.userId,
        source: creds.source,
        missing: creds.missing,
      },
    ];
  }

  if (env.SUBSTACK_PUBLICATION_URL || env.SUBSTACK_SESSION_TOKEN || env.SUBSTACK_USER_ID) {
    console.error(
      "Warning: both SUBSTACK_PUB_<KEY>_* and legacy SUBSTACK_* env vars are set. " +
        "The legacy vars are ignored — remove them, or fold that publication into a SUBSTACK_PUB_<KEY>_* triplet.",
    );
  }

  const incomplete: string[] = [];
  const result: PublicationCredentials[] = [];
  for (const [slug, fields] of groups) {
    const missingFields = (["publicationUrl", "sessionToken", "userId"] as Field[]).filter((f) => !fields[f]);
    if (missingFields.length > 0) {
      incomplete.push(`${slug} (missing ${missingFields.length} of 3 vars)`);
      continue;
    }
    result.push({
      key: slug,
      label: labelFromKey(slug),
      publicationUrl: fields.publicationUrl!,
      sessionToken: fields.sessionToken!,
      userId: fields.userId!,
      source: "env",
      missing: [],
    });
  }

  if (incomplete.length > 0) {
    throw new Error(
      `Incomplete SUBSTACK_PUB_<KEY>_* configuration for: ${incomplete.join(", ")}. ` +
        "Each publication needs all three of _PUBLICATION_URL, _SESSION_TOKEN, and _USER_ID.",
    );
  }

  return result;
}
