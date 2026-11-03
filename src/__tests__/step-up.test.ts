import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLogin, parseLoginArguments } from "../login.js";
import { loadSession } from "../auth/session-store.js";
import { completeStepUp, probeSubscriberAccess, rotatedSessionToken, PROBE_EMAIL, StepUpError } from "../auth/step-up.js";

const ORIGIN = "https://example.com", CODE = "123456";
const REAUTH = JSON.stringify({ error: "For your security, please sign out and sign back in to do this.", type: "reauthentication_required" });

/**
 * A fake Substack: subscriber-stats answers 403 reauthentication_required until the session has
 * completed reauthenticate/start + /complete with the right code. Completing rotates the cookie,
 * and only the rotated session passes, as the web app's retry-after-step-up flow implies.
 */
function fakeSubstack(options: { method?: string | null; rotate?: boolean } = {}) {
  const { method = "email", rotate = true } = options;
  const steppedUp = new Set<string>(), started = new Set<string>();
  const calls: { path: string; token: string; body?: unknown }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)), cookie = new Headers(init.headers).get("cookie") ?? "";
    const token = /connect\.sid=([^;]+)/.exec(cookie)?.[1] ?? "";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, token, body });
    if (url.pathname === "/api/v1/post_management/drafts") return Response.json({ posts: [] });
    if (url.pathname === "/api/v1/subscriber-stats") {
      return steppedUp.has(token) ? Response.json({ count: 0, subscribers: [] })
        : new Response(REAUTH, { status: 403, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (url.pathname === "/api/v1/reauthenticate/start") {
      started.add(token);
      if (method === null) { steppedUp.add(token); return Response.json({}); }
      return Response.json({ method });
    }
    if (url.pathname === "/api/v1/reauthenticate/complete") {
      if (!started.has(token) || body?.code !== CODE) return Response.json({ error: "Invalid code" }, { status: 400 });
      const next = rotate ? "stepped-up-token" : token;
      steppedUp.add(next);
      return Response.json({}, { headers: rotate ? { "set-cookie": `connect.sid=${next}; Path=/; HttpOnly; Secure` } : {} });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, calls, steppedUp };
}

function browser() {
  const cookies = vi.fn(async (url: string) => url === "https://substack.com"
    ? [{ name: "substack.sid", domain: ".substack.com", value: "example-substack-token" }]
    : [{ name: "connect.sid", domain: "example.com", value: "fresh-login-token" }]);
  const launch = vi.fn(async () => ({ newContext: async () => ({ cookies, newPage: async () => ({ goto: vi.fn() }) }), close: vi.fn(async () => {}) }));
  return { ask: vi.fn(async (_q: string) => CODE), loadChromium: vi.fn(async () => ({ launch })), out: vi.fn(), error: vi.fn(), pollIntervalMs: 1, publicationWaitMs: 50 };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "substack-stepup-test-")); vi.stubEnv("SUBSTACK_MCP_HOME", dir); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("login --subscriber-access: 403 reauthentication_required, then success", () => {
  it("completes Substack's step-up and saves a session that subscriber reads accept", async () => {
    const server = fakeSubstack(), deps = browser();
    expect(await runLogin([ORIGIN, "--user-id", "42", "--subscriber-access"], deps)).toBe(0);
    expect(server.calls.map(c => c.path)).toEqual([
      "/api/v1/post_management/drafts", "/api/v1/subscriber-stats",
      "/api/v1/reauthenticate/start", "/api/v1/reauthenticate/complete", "/api/v1/subscriber-stats",
    ]);
    // The first probe is the fresh login session; Substack refuses it.
    expect(server.calls[1].token).toBe("fresh-login-token");
    expect(server.calls[3].body).toEqual({ code: CODE });
    // The rotated session is what gets verified and saved.
    expect(server.calls[4].token).toBe("stepped-up-token");
    expect(loadSession()).toMatchObject({ sessionToken: "stepped-up-token", userId: "42" });
    expect(await probeSubscriberAccess(ORIGIN, loadSession()!.sessionToken)).toBe("granted");
    const prompt = deps.ask.mock.calls.map(c => c[0]).find(q => q.includes("emailed"));
    expect(prompt).toBeDefined();
    const output = deps.out.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain('"subscriber_access":"verified"');
    expect(output).toContain('"step_up":"email"');
    expect(output).not.toContain("stepped-up-token");
    expect(output).not.toContain(CODE);
  });

  it("keeps the session token when Substack marks the session without rotating its cookie", async () => {
    fakeSubstack({ method: "totp", rotate: false });
    const deps = browser();
    expect(await runLogin([ORIGIN, "--user-id", "42", "--subscriber-access"], deps)).toBe(0);
    expect(loadSession()?.sessionToken).toBe("fresh-login-token");
    expect(deps.ask.mock.calls.some(c => c[0].includes("authenticator app"))).toBe(true);
  });

  it("saves nothing when the code is never accepted", async () => {
    const server = fakeSubstack(), deps = browser();
    deps.ask.mockImplementation(async () => "000000");
    expect(await runLogin([ORIGIN, "--user-id", "42", "--subscriber-access"], deps)).toBe(1);
    expect(loadSession()).toBeNull();
    expect(server.calls.filter(c => c.path === "/api/v1/reauthenticate/complete")).toHaveLength(3);
    expect(deps.error.mock.calls.join("\n")).toContain("code_rejected");
  });

  it("saves nothing when the person cancels with a blank code", async () => {
    fakeSubstack(); const deps = browser();
    deps.ask.mockImplementation(async () => "");
    expect(await runLogin([ORIGIN, "--user-id", "42", "--subscriber-access"], deps)).toBe(1);
    expect(loadSession()).toBeNull();
    expect(deps.error.mock.calls.join("\n")).toContain("cancelled");
  });

  it("does not touch subscriber endpoints without the flag", async () => {
    const server = fakeSubstack();
    expect(await runLogin([ORIGIN, "--user-id", "42"], browser())).toBe(0);
    expect(server.calls.map(c => c.path)).toEqual(["/api/v1/post_management/drafts"]);
    expect(parseLoginArguments([ORIGIN]).subscriberAccess).toBe(false);
  });
});

describe("step-up protocol", () => {
  it("probes with a reserved address that can match no real subscriber", async () => {
    const server = fakeSubstack();
    expect(await probeSubscriberAccess(ORIGIN, "fresh-login-token")).toBe("reauthentication_required");
    expect(server.calls[0].body).toEqual({ filters: { user_email_address_string_is: PROBE_EMAIL }, limit: 1, offset: 0 });
    expect(PROBE_EMAIL.endsWith(".invalid")).toBe(true);
  });

  it("asks for no code when start reports no method", async () => {
    fakeSubstack({ method: null });
    const ask = vi.fn(async () => CODE);
    expect(await completeStepUp(ORIGIN, "fresh-login-token", ask)).toEqual({ sessionToken: "fresh-login-token", method: null });
    expect(ask).not.toHaveBeenCalled();
  });

  it("retries a rejected code and rejects unknown methods", async () => {
    fakeSubstack();
    const ask = vi.fn().mockResolvedValueOnce("999999").mockResolvedValueOnce(` ${CODE} `);
    expect(await completeStepUp(ORIGIN, "fresh-login-token", ask)).toEqual({ sessionToken: "stepped-up-token", method: "email" });
    expect(ask.mock.calls.map(c => c[1])).toEqual([1, 2]);
    fakeSubstack({ method: "sms" });
    await expect(completeStepUp(ORIGIN, "t", async () => CODE)).rejects.toEqual(new StepUpError("method_unsupported"));
  });

  it("ignores cookie deletions and malformed values when rotating", () => {
    const h = (...c: string[]) => { const headers = new Headers(); for (const v of c) headers.append("set-cookie", v); return new Response(null, { headers }); };
    expect(rotatedSessionToken(h("connect.sid=; Max-Age=0"), "old")).toBe("old");
    expect(rotatedSessionToken(h('connect.sid="a b"'), "old")).toBe("old");
    expect(rotatedSessionToken(h("other=x", "substack.sid=new"), "old")).toBe("new");
  });
});
