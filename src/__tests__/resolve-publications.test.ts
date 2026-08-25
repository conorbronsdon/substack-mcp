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
