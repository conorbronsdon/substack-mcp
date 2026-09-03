import { describe, it, expect, vi, afterEach } from "vitest";
import { resolvePublications } from "../auth/resolve-publications.js";
import type { StoredSession } from "../auth/session-store.js";

const stored: StoredSession = {
  publicationUrl: "https://stored.substack.com",
  sessionToken: "stored-tok",
  userId: "99",
  savedAt: "2026-01-01T00:00:00Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolvePublications", () => {
  it("falls back to resolveCredentials (single 'default' entry) when no prefixed vars are set", () => {
    const env = {
      SUBSTACK_PUBLICATION_URL: "https://env.substack.com",
      SUBSTACK_SESSION_TOKEN: "env-tok",
      SUBSTACK_USER_ID: "1",
    } as NodeJS.ProcessEnv;
    const pubs = resolvePublications(env, () => stored);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]).toMatchObject({
      key: "default",
      publicationUrl: "https://env.substack.com",
      sessionToken: "env-tok",
      userId: "1",
      source: "env",
      missing: [],
    });
  });

  it("falls back to the stored-session path with nothing set at all", () => {
    const pubs = resolvePublications({} as NodeJS.ProcessEnv, () => stored);
    expect(pubs).toHaveLength(1);
    expect(pubs[0].publicationUrl).toBe("https://stored.substack.com");
    expect(pubs[0].source).toBe("stored");
  });

  it("resolves a single complete prefixed triplet, slugging the key and deriving a label", () => {
    const env = {
      SUBSTACK_PUB_KEVIN_MULDOON_PUBLICATION_URL: "https://kevinmuldoon.substack.com",
      SUBSTACK_PUB_KEVIN_MULDOON_SESSION_TOKEN: "tok-1",
      SUBSTACK_PUB_KEVIN_MULDOON_USER_ID: "111",
    } as NodeJS.ProcessEnv;
    const pubs = resolvePublications(env, () => null);
    expect(pubs).toEqual([
      {
        key: "kevin-muldoon",
        label: "Kevin Muldoon",
        publicationUrl: "https://kevinmuldoon.substack.com",
        sessionToken: "tok-1",
        userId: "111",
        source: "env",
        missing: [],
      },
    ]);
  });

  it("resolves multiple complete prefixed triplets", () => {
    const env = {
      SUBSTACK_PUB_KEVIN_MULDOON_PUBLICATION_URL: "https://kevinmuldoon.substack.com",
      SUBSTACK_PUB_KEVIN_MULDOON_SESSION_TOKEN: "tok-1",
      SUBSTACK_PUB_KEVIN_MULDOON_USER_ID: "111",
      SUBSTACK_PUB_SAPERE_PUBLICATION_URL: "https://sapere.substack.com",
      SUBSTACK_PUB_SAPERE_SESSION_TOKEN: "tok-2",
      SUBSTACK_PUB_SAPERE_USER_ID: "222",
    } as NodeJS.ProcessEnv;
    const pubs = resolvePublications(env, () => null);
    expect(pubs.map((p) => p.key).sort()).toEqual(["kevin-muldoon", "sapere"]);
    expect(pubs.every((p) => p.source === "env" && p.missing.length === 0)).toBe(true);
  });

  it("throws naming the offending key when a triplet is incomplete", () => {
    const env = {
      SUBSTACK_PUB_SAPERE_PUBLICATION_URL: "https://sapere.substack.com",
      SUBSTACK_PUB_SAPERE_SESSION_TOKEN: "tok-2",
      // SUBSTACK_PUB_SAPERE_USER_ID missing
    } as NodeJS.ProcessEnv;
    expect(() => resolvePublications(env, () => null)).toThrow(/sapere/);
  });

  it("ignores legacy vars (with a warning) when prefixed vars are also present", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = {
      SUBSTACK_PUBLICATION_URL: "https://legacy.substack.com",
      SUBSTACK_SESSION_TOKEN: "legacy-tok",
      SUBSTACK_USER_ID: "1",
      SUBSTACK_PUB_SAPERE_PUBLICATION_URL: "https://sapere.substack.com",
      SUBSTACK_PUB_SAPERE_SESSION_TOKEN: "tok-2",
      SUBSTACK_PUB_SAPERE_USER_ID: "222",
    } as NodeJS.ProcessEnv;
    const pubs = resolvePublications(env, () => null);
    expect(pubs).toHaveLength(1);
    expect(pubs[0].key).toBe("sapere");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/legacy/i));
  });
});

/**
 * A named publication's variable *name* is what declares intent, so an empty
 * value has to be an error. If empty values are skipped instead, the group
 * disappears — and a disappeared group is not "no configuration", it is a
 * different, more dangerous configuration. Both cases below were reachable at
 * eaa84bb.
 */
describe("resolvePublications: an empty named publication must not disappear", () => {
  it("does not fall back to a stored session when a named publication is present but empty", () => {
    const loader = vi.fn(() => stored);
    const env = {
      SUBSTACK_PUB_SAPERE_PUBLICATION_URL: "",
      SUBSTACK_PUB_SAPERE_SESSION_TOKEN: "",
      SUBSTACK_PUB_SAPERE_USER_ID: "",
    } as NodeJS.ProcessEnv;

    expect(() => resolvePublications(env, loader)).toThrow(/sapere/i);
    expect(loader).not.toHaveBeenCalled();
  });

  it("does not collapse to single-publication routing when one valid triplet sits beside an all-empty one", () => {
    const loader = vi.fn(() => stored);
    const env = {
      SUBSTACK_PUB_SAPERE_PUBLICATION_URL: "https://sapere.substack.com",
      SUBSTACK_PUB_SAPERE_SESSION_TOKEN: "tok-2",
      SUBSTACK_PUB_SAPERE_USER_ID: "222",
      SUBSTACK_PUB_OTHER_PUBLICATION_URL: "",
      SUBSTACK_PUB_OTHER_SESSION_TOKEN: "",
      SUBSTACK_PUB_OTHER_USER_ID: "",
    } as NodeJS.ProcessEnv;

    // Must throw naming `other` — not return the single valid publication,
    // which would drop the `publication` parameter from every tool and route
    // a call meant for `other` silently to `sapere`.
    expect(() => resolvePublications(env, loader)).toThrow(/other/i);
    expect(loader).not.toHaveBeenCalled();
  });

  it("reports a whitespace-only value the same way as an empty one", () => {
    const env = {
      SUBSTACK_PUB_SAPERE_PUBLICATION_URL: "https://sapere.substack.com",
      SUBSTACK_PUB_SAPERE_SESSION_TOKEN: "   ",
      SUBSTACK_PUB_SAPERE_USER_ID: "222",
    } as NodeJS.ProcessEnv;
    expect(() => resolvePublications(env, () => null)).toThrow(/sapere.*SESSION_TOKEN/is);
  });

  it("distinguishes an absent variable from an empty one in the error", () => {
    const env = {
      SUBSTACK_PUB_SAPERE_PUBLICATION_URL: "https://sapere.substack.com",
      SUBSTACK_PUB_SAPERE_SESSION_TOKEN: "",
      // SUBSTACK_PUB_SAPERE_USER_ID absent entirely
    } as NodeJS.ProcessEnv;
    expect(() => resolvePublications(env, () => null)).toThrow(/_SESSION_TOKEN \(empty\)/);
    expect(() => resolvePublications(env, () => null)).toThrow(/_USER_ID(?! \(empty\))/);
  });
});

describe("resolvePublications: key collisions", () => {
  it("rejects two distinct env names that slugify to the same key", () => {
    // Distinct variables on any POSIX host; one slug. Last-writer-wins would
    // merge them, and can pair one publication's URL with the other's cookie.
    const env = {
      SUBSTACK_PUB_ALPHA_PUBLICATION_URL: "https://alpha.substack.com",
      SUBSTACK_PUB_ALPHA_SESSION_TOKEN: "tok-alpha",
      SUBSTACK_PUB_ALPHA_USER_ID: "1",
      SUBSTACK_PUB_Alpha_PUBLICATION_URL: "https://beta.substack.com",
      SUBSTACK_PUB_Alpha_SESSION_TOKEN: "tok-beta",
      SUBSTACK_PUB_Alpha_USER_ID: "2",
    } as NodeJS.ProcessEnv;
    expect(() => resolvePublications(env, () => null)).toThrow(/same publication key/i);
    expect(() => resolvePublications(env, () => null)).toThrow(/ALPHA, Alpha/);
  });

  it("does not fire on a single key used across all three of its variables", () => {
    const env = {
      SUBSTACK_PUB_ALPHA_PUBLICATION_URL: "https://alpha.substack.com",
      SUBSTACK_PUB_ALPHA_SESSION_TOKEN: "tok-alpha",
      SUBSTACK_PUB_ALPHA_USER_ID: "1",
    } as NodeJS.ProcessEnv;
    expect(resolvePublications(env, () => null).map((p) => p.key)).toEqual(["alpha"]);
  });
});
