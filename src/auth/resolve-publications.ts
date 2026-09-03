/**
 * Resolve credentials for one or more Substack publications.
 *
 * - No `SUBSTACK_PUB_<KEY>_*` vars present: falls back to the existing
 *   single-publication `resolveCredentials()` (plain `SUBSTACK_*` env vars,
 *   with the stored-session fallback), wrapped as a single internal entry.
 *   This is the zero-touch path every existing single-publication deployment
 *   stays on — no `publication` field is ever added to a tool's schema in
 *   this case (see server.ts).
 * - One or more `SUBSTACK_PUB_<KEY>_*` vars present: one entry per triplet,
 *   keyed by a slugified `<KEY>` (e.g. `KEVIN_MULDOON` becomes
 *   `kevin-muldoon`). An incomplete triplet throws at startup — this is new,
 *   explicitly opt-in config, so a partial triplet is almost certainly a typo,
 *   not something to silently drop. Legacy unprefixed vars are ignored (with a
 *   warning) in this mode, rather than treated as an implicit unnamed extra
 *   publication.
 *
 * ## Why a variable's *name* is what establishes intent
 *
 * The rule here is that a matching variable name creates the group, before its
 * value is looked at. Skipping empty values instead — `if (!value) continue` —
 * makes an all-empty triplet vanish, and a vanished group is not an error, it
 * is a different configuration:
 *
 * - All-empty triplet on its own: no groups remain, so resolution falls back to
 *   the legacy path and can pick up a *stored browser-login session* the
 *   operator never intended this process to use.
 * - Valid A plus an all-empty B: one group remains, the server decides it is in
 *   single-publication mode, every tool loses its `publication` parameter, and
 *   a call meant for B routes silently to A. `create_note` publishes
 *   immediately and cannot be undone, so that is an uncorrectable mistake.
 *
 * Both were reachable at eaa84bb. Creating the group first turns each into a
 * startup error naming the offending key.
 *
 * Slug collisions are an error for the same reason: `SUBSTACK_PUB_ALPHA_*` and
 * `SUBSTACK_PUB_Alpha_*` are two distinct variables on a POSIX host but one
 * slug, so last-writer-wins would silently merge two publications — and can
 * pair one publication's URL with another's session cookie, per field, in
 * whatever order the environment happens to enumerate.
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

/** One publication under construction: its fields, plus every raw `<KEY>` that mapped to it. */
interface Group {
  fields: Partial<Record<Field, string>>;
  rawKeys: Set<string>;
}

const ALL_FIELDS: Field[] = ["publicationUrl", "sessionToken", "userId"];

const SUFFIX_BY_FIELD: Record<Field, string> = {
  publicationUrl: "PUBLICATION_URL",
  sessionToken: "SESSION_TOKEN",
  userId: "USER_ID",
};

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
  const groups = new Map<string, Group>();

  for (const envName of Object.keys(env)) {
    const match = PREFIXED_VAR_RE.exec(envName);
    if (!match) continue;
    const [, rawKey, suffix] = match;
    const slug = slugify(rawKey);
    // The name creates the group; the value is judged afterwards. See the
    // module comment for what skipping empty values here used to allow.
    const group = groups.get(slug) ?? { fields: {}, rawKeys: new Set<string>() };
    group.rawKeys.add(rawKey);
    group.fields[FIELD_BY_SUFFIX[suffix]] = env[envName] ?? "";
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

  // Two env-var names that slugify to the same key are two publications the
  // operator meant to keep apart. Merging them is silent and can cross
  // credentials, so it is fatal rather than a warning.
  const collisions = [...groups]
    .filter(([, group]) => group.rawKeys.size > 1)
    .map(([slug, group]) => `${slug} (from ${[...group.rawKeys].sort().join(", ")})`);
  if (collisions.length > 0) {
    throw new Error(
      `Conflicting SUBSTACK_PUB_<KEY>_* names resolve to the same publication key: ${collisions.join("; ")}. ` +
        "Keys are compared case-insensitively with _ as -; give each publication a distinct key.",
    );
  }

  const incomplete: string[] = [];
  const result: PublicationCredentials[] = [];
  for (const [slug, { fields }] of groups) {
    // `undefined` (name never seen) and `""` (name seen, value empty) are both
    // unusable, and both are reported — an empty value is a typo, not a
    // decision to disable that publication.
    const badFields = ALL_FIELDS.filter((f) => !fields[f]?.trim());
    if (badFields.length > 0) {
      const detail = badFields.map((f) => `_${SUFFIX_BY_FIELD[f]}${fields[f] === undefined ? "" : " (empty)"}`);
      incomplete.push(`${slug} (${detail.join(", ")})`);
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
        "Each publication needs all three of _PUBLICATION_URL, _SESSION_TOKEN, and _USER_ID with a non-empty value.",
    );
  }

  return result;
}
