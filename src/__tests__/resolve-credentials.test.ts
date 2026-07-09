import { describe, it, expect } from "vitest";
import { resolveCredentials } from "../auth/resolve-credentials.js";
import type { StoredSession } from "../auth/session-store.js";

const stored: StoredSession = {
  publicationUrl: "https://stored.substack.com",
  sessionToken: "stored-tok",
  userId: "99",
  savedAt: "2026-01-01T00:00:00Z",
};

describe("resolveCredentials", () => {
  it("prefers env vars when present (source=env)", () => {
    const env = {
      SUBSTACK_PUBLICATION_URL: "https://env.substack.com",
      SUBSTACK_SESSION_TOKEN: "env-tok",
      SUBSTACK_USER_ID: "1",
    } as NodeJS.ProcessEnv;
    const r = resolveCredentials(env, () => stored);
    expect(r.publicationUrl).toBe("https://env.substack.com");
    expect(r.sessionToken).toBe("env-tok");
    expect(r.userId).toBe("1");
    expect(r.source).toBe("env");
    expect(r.missing).toEqual([]);
  });

  it("falls back to the stored session when env vars are absent (source=stored)", () => {
    const r = resolveCredentials({} as NodeJS.ProcessEnv, () => stored);
    expect(r.publicationUrl).toBe("https://stored.substack.com");
    expect(r.sessionToken).toBe("stored-tok");
    expect(r.userId).toBe("99");
    expect(r.source).toBe("stored");
    expect(r.missing).toEqual([]);
  });

  it("mixes per field, env winning each present field (source=mixed)", () => {
    const env = { SUBSTACK_SESSION_TOKEN: "env-tok" } as NodeJS.ProcessEnv;
    const r = resolveCredentials(env, () => stored);
    expect(r.sessionToken).toBe("env-tok"); // env
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
});
