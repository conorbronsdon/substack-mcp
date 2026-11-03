import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "../api/request.js";
import { z } from "zod";
import { describeSyncFailure, SyncFailure, toolFailure } from "../calendar-sync.js";
import { AuthenticationError, mapHttpStatusToError, SubstackAPIError } from "../utils/errors.js";
import { contractRegistrar } from "../output-contracts.js";

const REAUTH_DETAIL = "For your security, please sign out and sign back in to do this.";

describe("Substack reauthentication 403", () => {
  it("maps Substack's reauthentication body to its own reason", () => {
    const error = mapHttpStatusToError(403, REAUTH_DETAIL, "/api/v1/subscriber-stats");
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).reason).toBe("reauthentication_required");
    expect(error.message).toContain("reauthentication_required");
  });

  it("keeps the expired-session reason for other 401/403 responses", () => {
    expect((mapHttpStatusToError(403, "Forbidden", "/api") as AuthenticationError).reason).toBe("invalid_or_expired");
    expect((mapHttpStatusToError(401, REAUTH_DETAIL, "/api") as AuthenticationError).reason).toBe("invalid_or_expired");
  });
});

describe("Substack reauthentication 403 through the request layer", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  const url = "https://example.substack.com/api/v1/subscriber-stats";
  const live = JSON.stringify({ error: REAUTH_DETAIL, type: "reauthentication_required" });

  it("classifies Substack's live reauthentication body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(live, { status: 403, headers: { "content-type": "application/json; charset=utf-8" } })));
    const error = await requestJson(url, { method: "POST", body: "{}" }).catch(e => e) as AuthenticationError;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.reason).toBe("reauthentication_required");
    expect(error.statusCode).toBe(403);
    expect(error.message).not.toContain("For your security");
  });

  const json = { "content-type": "application/json" };

  it("gives up on a stalled JSON 403 body after the 2 s probe window", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 403, headers: json })));
    const started = performance.now();
    const error = await requestJson(url, {}, 30000).catch(e => e) as AuthenticationError;
    const elapsed = performance.now() - started;
    expect(error.reason).toBe("invalid_or_expired");
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(2600);
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels a body that keeps streaming once it passes the 4 KB cap", async () => {
    let pulls = 0;
    const endless = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(1)); } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(endless, { status: 403, headers: json })));
    const started = performance.now();
    const error = await requestJson(url, {}, 30000).catch(e => e) as AuthenticationError;
    expect(error.reason).toBe("invalid_or_expired");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(pulls).toBeLessThanOrEqual(4100); // the cap plus the stream's one-chunk read-ahead
  });

  it("caps the probe at exactly 4 KB", async () => {
    const sized = (n: number) => { const head = JSON.stringify({ type: "reauthentication_required", pad: "" }); return head.replace('"pad":""', `"pad":"${"x".repeat(n - head.length)}"`); };
    expect(Buffer.byteLength(sized(4096))).toBe(4096);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sized(4096), { status: 403, headers: json })));
    expect(((await requestJson(url).catch(e => e)) as AuthenticationError).reason).toBe("reauthentication_required");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sized(4097), { status: 403, headers: json })));
    expect(((await requestJson(url).catch(e => e)) as AuthenticationError).reason).toBe("invalid_or_expired");
  });

  it("propagates caller cancellation during the probe instead of reporting a 403", async () => {
    const caller = new AbortController();
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ pull() { reading(); return new Promise(() => {}); } }), { status: 403, headers: json })));
    const pending = requestJson(url, { signal: caller.signal }, 30000).catch(e => e);
    await started;
    caller.abort();
    const error = await pending;
    expect(error).not.toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({ code: "request_cancelled" });
  });

  it("reports the request's own deadline as a timeout, not an expired session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { status: 403, headers: json })));
    const error = await requestJson(url, {}, 300).catch(e => e) as SubstackAPIError;
    expect(error).not.toBeInstanceOf(AuthenticationError);
    expect(error.statusCode).toBe(408);
  });

  it("does not read non-JSON 403 bodies", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 403 })));
    const error = await requestJson(url).catch(e => e) as AuthenticationError;
    expect(error.reason).toBe("invalid_or_expired");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps other 401/403 bodies as invalid_or_expired", async () => {
    for (const [status, body] of [[403, "Forbidden"], [401, live], [403, ""]] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
      const error = await requestJson(url).catch(e => e) as AuthenticationError;
      expect(error.reason).toBe("invalid_or_expired");
    }
  });
});

describe("calendar sync failure reasons", () => {
  it("names the reason from a tool error payload without echoing other fields", () => {
    const content = [{ type: "text", text: JSON.stringify({ code: "upstream_error", status: 403, auth_reason: "reauthentication_required", message: "reader@example.org leaked?" }) }];
    const { reason, line } = describeSyncFailure(toolFailure("get_subscriber", content));
    expect(reason).toBe("substack_reauthentication_required");
    expect(line).toContain("reason=substack_reauthentication_required, status=403");
    expect(line).not.toContain("@");
  });

  it("falls back to the tool code, then a generic code, for unusable payloads", () => {
    expect(toolFailure("t", [{ type: "text", text: JSON.stringify({ code: "result_too_large" }) }]).reason).toBe("substack_result_too_large");
    expect(toolFailure("t", [{ type: "text", text: JSON.stringify({ code: "Bad Code <x@y.z>" }) }]).reason).toBe("substack_upstream_error");
    expect(toolFailure("t", [{ type: "text", text: "not json" }]).reason).toBe("substack_upstream_error");
    expect(toolFailure("t", undefined).reason).toBe("substack_upstream_error");
  });

  it("classifies lock, validation and unknown failures", () => {
    expect(describeSyncFailure(Object.assign(new Error("exists"), { code: "EEXIST" })).reason).toBe("lock_held");
    expect(describeSyncFailure(z.string().safeParse(1).error).reason).toBe("invalid_config_or_state");
    expect(describeSyncFailure(new SyntaxError("bad json")).reason).toBe("invalid_config_or_state");
    expect(describeSyncFailure(new SyncFailure("scan_cap", "x")).reason).toBe("scan_cap");
    const unknown = describeSyncFailure(new Error("reader@example.org exploded"));
    expect(unknown.reason).toBe("unexpected");
    expect(unknown.line).not.toContain("@");
  });
});

describe("tool error contract", () => {
  async function errorPayload(thrown: unknown) {
    let handler: ((...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    const fake = { registerTool: (_name: string, _config: unknown, cb: typeof handler) => { handler = cb; } };
    contractRegistrar(fake as never)("get_subscriber", {}, async () => { throw thrown; });
    return JSON.parse((await handler!()).content[0].text) as Record<string, unknown>;
  }

  it("carries auth_reason for authentication errors", async () => {
    const payload = await errorPayload(mapHttpStatusToError(403, REAUTH_DETAIL, "/api/v1/subscriber-stats"));
    expect(payload).toMatchObject({ code: "upstream_error", status: 403, auth_reason: "reauthentication_required" });
  });

  it("omits auth_reason for other errors", async () => {
    const payload = await errorPayload(mapHttpStatusToError(500, "boom", "/api"));
    expect(payload.status).toBe(500);
    expect(payload).not.toHaveProperty("auth_reason");
  });
});
