import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { gzipSync } from "node:zlib";
import { SubstackClient } from "../api/client.js";
import { MAX_JSON_BYTES, readBounded, requestJson, requestText } from "../api/request.js";
import { AuthenticationError, RateLimitError, ResponseError, TimeoutError, extractErrorDetail } from "../utils/errors.js";
import { doctor } from "../doctor.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const url = "https://example.substack.com/api/test";
const encode = (value: string) => new TextEncoder().encode(value);
const signal = () => new AbortController().signal;
const config = () => [{ key: "test", label: "Test", publicationUrl: "https://example.substack.com", sessionToken: "synthetic-session", userId: "1", missing: [], source: "env" as const }];

function streaming(chunks: Uint8Array[], headers: HeadersInit = {}) {
  let index = 0;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({
    pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); }, cancel,
  }), { headers });
  return { response, cancel };
}

describe("bounded response bodies", () => {
  it("counts bytes across UTF-8 chunk boundaries and accepts the exact limit", async () => {
    const bytes = encode('"é"');
    expect(bytes.length).toBe(4);
    const { response } = streaming([bytes.slice(0, 2), bytes.slice(2)]);
    expect(await readBounded(response, 4, signal(), url)).toBe('"é"');
  });
  it.each([{}, { "content-length": "1" }])("rejects streamed overflow even with missing or dishonest length: %j", async headers => {
    const { response, cancel } = streaming([encode("123"), encode("45"), encode("6")], headers as HeadersInit);
    await expect(readBounded(response, 4, signal(), url)).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("rejects an excessive announced body without reading it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-length": "500" } });
    await expect(readBounded(response, 4, signal(), url)).rejects.toMatchObject({ code: "response_too_large" });
    expect(response.body?.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("does not let a stalled body or slow cancellation outlive the deadline", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }))));
    await expect(requestJson(url, {}, 20)).rejects.toBeInstanceOf(TimeoutError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("shares the deadline across headers and body instead of resetting it", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancel = vi.fn();
    let headersReady!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { headersReady = resolve; })));
    const operation = requestJson(url, {}, 50).catch(error => error);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(50);
    headersReady(new Response(new ReadableStream({ cancel })));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    controller.abort(new DOMException("expired", "TimeoutError"));
    expect(await operation).toBeInstanceOf(TimeoutError);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("honors caller cancellation and distinguishes it from timeout", async () => {
    const controller = new AbortController(), cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }))));
    const operation = requestJson(url, { signal: controller.signal }, 5000).catch(error => error);
    await Promise.resolve(); await Promise.resolve();
    controller.abort(new Error("private cancellation reason"));
    const error = await operation as ResponseError;
    expect(error).toMatchObject({ code: "request_cancelled" });
    expect(error.message).not.toContain("private cancellation reason");
  });
  it("does not fetch with an already-cancelled caller signal", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(requestJson(url, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "request_cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("discards a response that arrives after a header timeout", async () => {
    let respond!: (response: Response) => void;
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })));
    await expect(requestJson(url, {}, 20)).rejects.toBeInstanceOf(TimeoutError);
    respond(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("bounds the public HTML fallback too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { headers: { "content-length": "3000000" } })));
    await expect(requestText(url)).rejects.toMatchObject({ code: "response_too_large" });
  });
});

describe("response classification", () => {
  it.each([
    { body: "private HTML", headers: { "content-type": "text/html" }, code: "unexpected_html" },
    { body: " <html>private</html>", headers: {}, code: "unexpected_html" },
    { body: "{private", headers: {}, code: "malformed_json" },
  ])("classifies $code without echoing response bodies", async ({ body, headers, code }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: headers as HeadersInit })));
    const error = await requestJson(url).catch(error => error) as RateLimitError & ResponseError;
    expect(error).toMatchObject({ code });
    expect(error.message).not.toContain("private");
    const result = await doctor(true, config);
    expect(result.publications[0].authentication).toBe(code);
  });
  it.each([401, 403, 429])("classifies HTTP %s without waiting for its body", async status => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { status, headers: { "retry-after": "120" } })));
    const error = await requestJson(url).catch(error => error) as RateLimitError & ResponseError;
    expect(error).toBeInstanceOf(status === 429 ? RateLimitError : AuthenticationError);
    if (status === 429) { expect(error.retryAfter).toBe("120"); expect(error.message).toContain("Retry-After: 120"); }
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(["Mon, 07 Sep 2026 22:00:00 GMT", "30", "private-injected-value"])("validates Retry-After %s", async value => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": value } })));
    const error = await requestJson(url).catch(error => error) as RateLimitError & ResponseError;
    expect(error.retryAfter).toBe(value.startsWith("private") ? undefined : value);
    expect(error.message).not.toContain("private");
  });
  it("keeps error details bounded and removes raw/decoded cookies", async () => {
    for (const body of [{ error: "x".repeat(600) }, { message: "x".repeat(600) }, { errors: ["x".repeat(600)] }]) {
      expect(extractErrorDetail(JSON.stringify(body), "fallback")).toBe("x".repeat(500) + "...");
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"s%3Aprivate and s:private"}', { status: 400 })));
    const error = await requestJson(url, { headers: { Cookie: "connect.sid=s%3Aprivate;" } }).catch(error => error) as Error;
    expect(error.message).not.toContain("private");
    expect(error.message).toContain("[redacted] and [redacted]");
    const prefix = "x".repeat(495);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: prefix + "s%3Aprivate" }), { status: 400 })));
    const boundary = await requestJson(url, { headers: { Cookie: "connect.sid=s%3Aprivate" } }).catch(error => error) as Error;
    expect(boundary.message).not.toContain("s%3A");
    expect(boundary.message).toContain("[reda...");
  });
  it("enforces doctor's smaller body budget", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { headers: { "content-length": "1048577" } })));
    expect((await doctor(true, config)).publications[0].authentication).toBe("response_too_large");
  });
  it("routes API calls through the response limit with no automatic write retry", async () => {
    const fetchMock = vi.fn(async () => new Response("", { headers: { "content-length": String(MAX_JSON_BYTES + 1) } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new SubstackClient("https://example.substack.com", "synthetic", "1").createDraft("Sample")).rejects.toBeInstanceOf(ResponseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("real fetch contract", () => {
  it("never follows same-origin or cross-origin redirects or replays a POST", async () => {
    let hits = 0;
    const received: string[] = [];
    const server = createHttpServer((req, res) => {
      hits++; received.push(req.headers.cookie ?? "");
      if (req.url === "/destination") { res.end('{}'); return; }
      res.writeHead(307, { Location: req.url === "/same" ? "/destination" : "https://example.invalid/private" }); res.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      for (const path of ["same", "cross"]) {
        await expect(requestJson(`http://127.0.0.1:${address.port}/${path}`, { method: "POST", body: "sample", headers: { Cookie: "synthetic-cookie" }, redirect: "follow" })).rejects.toMatchObject({ code: "redirect_rejected" });
      }
      expect(hits).toBe(2); expect(received).toEqual(["synthetic-cookie", "synthetic-cookie"]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("limits decompressed bytes instead of trusting compressed Content-Length", async () => {
    const compressed = gzipSync('"' + "x".repeat(10000) + '"');
    const server = createHttpServer((_req, res) => { res.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length }); res.end(compressed); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      await expect(requestJson(`http://127.0.0.1:${port}`, {}, 1000, 1000)).rejects.toMatchObject({ code: "response_too_large" });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
