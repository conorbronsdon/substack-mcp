import { describe, it, expect } from "vitest";
import { resolveCredentials } from "../auth/resolve-credentials.js";
import type { StoredSession } from "../auth/session-store.js";

const stored: StoredSession = {
  publicationUrl: "https://stored.substack.com",
  sessionToken: "example-stored-token",
  userId: "99",
  savedAt: "2026-01-01T00:00:00Z",
};

describe("resolveCredentials", () => {
  it("prefers env vars when present (source=env)", () => {
    const env = {
      SUBSTACK_PUBLICATION_URL: "https://env.substack.com",
      SUBSTACK_SESSION_TOKEN: "example-env-token",
      SUBSTACK_USER_ID: "1",
    } as NodeJS.ProcessEnv;
    const r = resolveCredentials(env, () => stored);
    expect(r.publicationUrl).toBe("https://env.substack.com");
    expect(r.sessionToken).toBe("example-env-token");
    expect(r.userId).toBe("1");
    expect(r.source).toBe("env");
    expect(r.missing).toEqual([]);
  });

  it("falls back to the stored session when env vars are absent (source=stored)", () => {
    const r = resolveCredentials({} as NodeJS.ProcessEnv, () => stored);
    expect(r.publicationUrl).toBe("https://stored.substack.com");
    expect(r.sessionToken).toBe("example-stored-token");
    expect(r.userId).toBe("99");
    expect(r.source).toBe("stored");
    expect(r.missing).toEqual([]);
  });

  it("mixes per field, env winning each present field (source=mixed)", () => {
    const env = { SUBSTACK_SESSION_TOKEN: "example-env-token" } as NodeJS.ProcessEnv;
    const r = resolveCredentials(env, () => stored);
    expect(r.sessionToken).toBe("example-env-token"); // env
    expect(r.publicationUrl).toBe("https://stored.substack.com"); // store
    expect(r.userId).toBe("99"); // store
    expect(r.source).toBe("mixed");
    expect(r.missing).toEqual([]);
  });

  it("reports all missing when neither env nor store supplies them (source=none)", () => {
    const r = resolveCredentials({} as NodeJS.ProcessEnv, () => null);
    expect(r.missing).toEqual([
      "SUBSTACK_PUBLICATION_URL",
      "SUBSTACK_SESSION_TOKEN",
      "SUBSTACK_USER_ID",
    ]);
    expect(r.source).toBe("none");
    expect(r.publicationUrl).toBe("");
  });

  it("reports only still-missing fields with a partial store", () => {
    const partial: StoredSession = { ...stored, userId: "" };
    const r = resolveCredentials({} as NodeJS.ProcessEnv, () => partial);
    expect(r.missing).toEqual(["SUBSTACK_USER_ID"]);
    expect(r.source).toBe("stored");
  });

  it("refuses a stored session token with an env publication URL on a different origin", () => {
    const env = { SUBSTACK_PUBLICATION_URL: "https://other.substack.com" } as NodeJS.ProcessEnv;
    expect(() => resolveCredentials(env, () => stored)).toThrow(
      /stored session was captured for https:\/\/stored\.substack\.com.*https:\/\/other\.substack\.com/,
    );
  });

  it("refuses the stored token when the env URL differs only by scheme or subdomain", () => {
    for (const url of ["http://stored.substack.com", "https://www.stored.substack.com", "https://substack.com"]) {
      const env = { SUBSTACK_PUBLICATION_URL: url } as NodeJS.ProcessEnv;
      expect(() => resolveCredentials(env, () => stored), url).toThrow(/stored session/);
    }
  });

  it("refuses the stored token when the env URL is not a parseable URL", () => {
    const env = { SUBSTACK_PUBLICATION_URL: "stored.substack.com" } as NodeJS.ProcessEnv;
    expect(() => resolveCredentials(env, () => stored)).toThrow(/stored session/);
  });

  it("never echoes the stored token in the refusal", () => {
    const env = { SUBSTACK_PUBLICATION_URL: "https://other.substack.com" } as NodeJS.ProcessEnv;
    expect(() => resolveCredentials(env, () => stored)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("example-stored-token") }),
    );
  });

  it("still resolves a stored token with an env URL on the same origin (source=mixed)", () => {
    for (const url of ["https://stored.substack.com", "https://STORED.substack.com/", "https://stored.substack.com:443"]) {
      const env = { SUBSTACK_PUBLICATION_URL: url } as NodeJS.ProcessEnv;
      const r = resolveCredentials(env, () => stored);
      expect(r.sessionToken, url).toBe("example-stored-token");
      expect(r.publicationUrl, url).toBe(url);
      expect(r.source, url).toBe("mixed");
    }
  });

  it("still lets an env token pair with an env URL on any origin, ignoring the stored session", () => {
    const env = {
      SUBSTACK_PUBLICATION_URL: "https://other.substack.com",
      SUBSTACK_SESSION_TOKEN: "example-env-token",
    } as NodeJS.ProcessEnv;
    const r = resolveCredentials(env, () => stored);
    expect(r.sessionToken).toBe("example-env-token");
    expect(r.publicationUrl).toBe("https://other.substack.com");
    expect(r.userId).toBe("99");
    expect(r.source).toBe("mixed");
  });
});
