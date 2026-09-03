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
    // Asserted as the whole message on purpose. The previous version of this
    // test used /_USER_ID(?! \(empty\))/, which could never fail: the
    // unconditional tail "…and _USER_ID with a non-empty value" satisfies the
    // negative lookahead no matter what the per-key detail says.
    expect(() => resolvePublications(env, () => null)).toThrow(
      "Incomplete SUBSTACK_PUB_<KEY>_* configuration for: " +
        "sapere (_SESSION_TOKEN (empty), _USER_ID). " +
        "Each publication needs all three of _PUBLICATION_URL, _SESSION_TOKEN, and _USER_ID with a non-empty value.",
    );
  });
});

/**
 * The same lesson as the empty-value bug, one gate earlier: a name that
 * announces itself as a publication variable but does not match the grammar is
 * still intent, and dropping it silently changes the configuration rather than
 * reducing it.
 */
describe("resolvePublications: names that do not match the grammar", () => {
  const validA = {
    SUBSTACK_PUB_A_PUBLICATION_URL: "https://a.substack.com",
    SUBSTACK_PUB_A_SESSION_TOKEN: "FAKE-A",
    SUBSTACK_PUB_A_USER_ID: "1",
  };

  const malformedGroups: Array<[string, NodeJS.ProcessEnv, RegExp]> = [
    [
      "a hyphen in the key",
      {
        "SUBSTACK_PUB_B-PUB_PUBLICATION_URL": "https://b.substack.com",
        "SUBSTACK_PUB_B-PUB_SESSION_TOKEN": "FAKE-B",
        "SUBSTACK_PUB_B-PUB_USER_ID": "2",
      } as NodeJS.ProcessEnv,
      /B-PUB_PUBLICATION_URL/,
    ],
    [
      "trailing whitespace in the name",
      {
        "SUBSTACK_PUB_B_PUBLICATION_URL ": "https://b.substack.com",
        "SUBSTACK_PUB_B_SESSION_TOKEN ": "FAKE-B",
        "SUBSTACK_PUB_B_USER_ID ": "2",
      } as NodeJS.ProcessEnv,
      /SUBSTACK_PUB_B_USER_ID /,
    ],
    [
      "a lowercase suffix",
      {
        SUBSTACK_PUB_B_publication_url: "https://b.substack.com",
        SUBSTACK_PUB_B_session_token: "FAKE-B",
        SUBSTACK_PUB_B_user_id: "2",
      } as NodeJS.ProcessEnv,
      /SUBSTACK_PUB_B_publication_url/,
    ],
    [
      "a non-ASCII key",
      {
        "SUBSTACK_PUB_CAFÉ_PUBLICATION_URL": "https://c.substack.com",
        "SUBSTACK_PUB_CAFÉ_SESSION_TOKEN": "FAKE-C",
        "SUBSTACK_PUB_CAFÉ_USER_ID": "3",
      } as NodeJS.ProcessEnv,
      /CAFÉ_SESSION_TOKEN/,
    ],
  ];

  for (const [label, malformed, named] of malformedGroups) {
    it(`throws naming the variable, beside a valid publication — ${label}`, () => {
      const loader = vi.fn(() => stored);
      // Without this, the malformed group vanishes, one publication remains,
      // single-publication mode is selected, and a call meant for it lands on A.
      expect(() => resolvePublications({ ...validA, ...malformed }, loader)).toThrow(named);
      expect(loader).not.toHaveBeenCalled();
    });

    it(`throws rather than falling back to a stored session — ${label} alone`, () => {
      const loader = vi.fn(() => stored);
      expect(() => resolvePublications({ ...malformed }, loader)).toThrow(named);
      expect(loader).not.toHaveBeenCalled();
    });
  }

  it("control: well-formed names beside each other still resolve", () => {
    const env = {
      ...validA,
      SUBSTACK_PUB_B_PUB_PUBLICATION_URL: "https://b.substack.com",
      SUBSTACK_PUB_B_PUB_SESSION_TOKEN: "FAKE-B",
      SUBSTACK_PUB_B_PUB_USER_ID: "2",
    } as NodeJS.ProcessEnv;
    expect(resolvePublications(env, () => null).map((p) => p.key).sort()).toEqual(["a", "b-pub"]);
  });

  it("control: the legacy SUBSTACK_PUBLICATION_URL is not mistaken for a malformed prefixed name", () => {
    const env = {
      SUBSTACK_PUBLICATION_URL: "https://legacy.substack.com",
      SUBSTACK_SESSION_TOKEN: "FAKE-LEGACY",
      SUBSTACK_USER_ID: "1",
    } as NodeJS.ProcessEnv;
    expect(resolvePublications(env, () => null)[0].key).toBe("default");
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
