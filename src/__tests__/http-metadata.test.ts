import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "../api/request.js";
import { ResponseError, SubstackAPIError, TimeoutError } from "../utils/errors.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const url = "https://example.substack.com/api/test";

describe("HTTP failure metadata", () => {
  it.each([401, 403, 408, 429, 500, 502, 503, 504])("preserves actual HTTP %s", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("failure", { status })));
    const error = await requestJson(url).catch(error => error) as SubstackAPIError;
    expect(error).toMatchObject({ statusCode: status, statusSource: "http", responseBodyIssue: undefined });
    expect(error.message).toContain(`(${status})`);
  });

  it("distinguishes client errors from real HTTP 408/502", async () => {
    expect(new TimeoutError(url, 10)).toMatchObject({ statusCode: 408, statusSource: "client" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid")));
    await expect(requestJson(url)).rejects.toMatchObject({ statusCode: 502, statusSource: "client", code: "malformed_json" });
  });

  it.each([429, 503])("retains validated Retry-After for HTTP %s", async status => {
    for (const value of ["30", "Mon, 07 Sep 2026 22:00:00 GMT", "private-invalid-value", "9".repeat(65)]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status, headers: { "retry-after": value } })));
      const error = await requestJson(url).catch(error => error) as SubstackAPIError;
      if (value === "30" || value.startsWith("Mon,")) {
        expect(error.retryAfter).toBe(value);
        expect(error.message).toContain(`Retry-After: ${value}`);
      } else {
        expect(error.retryAfter).toBeUndefined();
        expect(error.message).not.toContain(value);
      }
    }
  });

  it.each(["oversized", "stalled", "broken"])("preserves 503 and retry guidance with a %s body", async mode => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream({
      start(controller) { if (mode === "broken") controller.error(new Error("private body failure")); }, cancel,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 503, headers: {
      "retry-after": "60", ...(mode === "oversized" ? { "content-length": "65537" } : {}),
    } })));
    const error = await requestJson(url, {}, 50).catch(error => error) as SubstackAPIError;
    expect(error).toMatchObject({ statusCode: 503, statusSource: "http", retryAfter: "60",
      responseBodyIssue: mode === "oversized" ? "response_too_large" : mode === "stalled" ? "timeout" : "body_read_failed" });
    expect(error.message).toContain("Retry-After: 60");
    expect(error.message).not.toContain("private body failure");
    if (mode !== "broken") expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the known HTTP failure when the caller cancels its stalled diagnostic body", async () => {
    const controller = new AbortController();
    const reason = new ResponseError("private-abort-endpoint", "response_too_large");
    let bodyRead!: () => void;
    const ready = new Promise<void>(resolve => { bodyRead = resolve; });
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull() { bodyRead(); }, cancel,
    }, { highWaterMark: 0 }), { status: 503, headers: { "retry-after": "15" } })));
    const operation = requestJson(url, { signal: controller.signal }).catch(error => error);
    await ready;
    controller.abort(reason);
    const error = await operation as SubstackAPIError;
    expect(error).toMatchObject({ statusCode: 503, statusSource: "http", retryAfter: "15", responseBodyIssue: "request_cancelled" });
    expect(error.message).not.toContain("private-abort-endpoint");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([200, 503])("preserves classified overflow if cleanup cancels HTTP %s", async status => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      cancel() { controller.abort(new Error("private cleanup reason")); },
    }), { status, headers: { "content-length": "20000000", "retry-after": "15" } })));
    const error = await requestJson(url, { signal: controller.signal }).catch(error => error) as SubstackAPIError;
    expect(error).toMatchObject(status === 200
      ? { statusCode: 502, statusSource: "client", code: "response_too_large" }
      : { statusCode: 503, statusSource: "http", responseBodyIssue: "response_too_large", retryAfter: "15" });
    expect(error.message).not.toContain("private cleanup reason");
  });

  it.each([200, 503])("retains first cancellation if the deadline fires during HTTP %s cleanup", async status => {
    const caller = new AbortController(), deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let bodyRead!: () => void;
    const ready = new Promise<void>(resolve => { bodyRead = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull() { bodyRead(); },
      cancel() { deadline.abort(new DOMException("expired", "TimeoutError")); },
    }, { highWaterMark: 0 }), { status })));
    const operation = requestJson(url, { signal: caller.signal }).catch(error => error);
    await ready;
    caller.abort(new Error("private caller reason"));
    const error = await operation as SubstackAPIError;
    expect(error).toMatchObject(status === 200
      ? { statusSource: "client", code: "request_cancelled" }
      : { statusCode: 503, statusSource: "http", responseBodyIssue: "request_cancelled" });
    expect(deadline.signal.aborted).toBe(true);
    expect(error.message).not.toContain("private caller reason");
  });

  it("retains deadline-first classification if cancellation follows during cleanup", async () => {
    const caller = new AbortController(), deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let bodyRead!: () => void;
    const ready = new Promise<void>(resolve => { bodyRead = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull() { bodyRead(); }, cancel() { caller.abort(); },
    }, { highWaterMark: 0 }), { status: 503 })));
    const operation = requestJson(url, { signal: caller.signal }).catch(error => error);
    await ready;
    deadline.abort(new DOMException("expired", "TimeoutError"));
    expect(await operation).toMatchObject({ statusCode: 503, statusSource: "http", responseBodyIssue: "timeout" });
    expect(caller.signal.aborted).toBe(true);
  });

  it.each([
    new SubstackAPIError(503, "private reason", "private endpoint"),
    new ResponseError("private endpoint", "response_too_large"),
  ])("does not expose caller-supplied typed abort reasons", async reason => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const error = await requestJson(url, { signal: AbortSignal.abort(reason) }).catch(error => error) as SubstackAPIError;
    expect(error).toMatchObject({ code: "request_cancelled", statusSource: "client", endpoint: url });
    expect(error.message).not.toContain("private");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never automatically retries a failed write even with Retry-After", async () => {
    let appliedWrites = 0;
    const fetchMock = vi.fn(async () => { appliedWrites++; return new Response("unavailable", { status: 503, headers: { "retry-after": "0" } }); });
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestJson(url, { method: "POST", body: "sample" })).rejects.toMatchObject({ statusCode: 503, retryAfter: "0" });
    // A response failure cannot establish whether the originating write happened.
    expect(appliedWrites).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid timeout %s before fetching", async timeout => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(requestJson(url, {}, timeout)).rejects.toThrow("positive finite number");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[0.5, 1], [5000.9, 5000], [3_000_000_000, 2_147_483_647]])("normalizes timeout %s to %s", async (input, expected) => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    await expect(requestJson(url, {}, input)).resolves.toEqual({});
    expect(timeout).toHaveBeenCalledExactlyOnceWith(expected);
  });
});
