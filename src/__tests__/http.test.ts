import { describe, it, expect, afterEach, vi, type Mock } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "../server.js";
import { SubstackClient } from "../api/client.js";
import { startHttpServer, type HttpTransportOptions } from "../transport/http.js";

function makeServer() {
  return createServer(new SubstackClient("https://example.substack.com", "tok", "1"));
}

let httpServer: ReturnType<typeof startHttpServer> | undefined;

/**
 * A spy wrapping the server factory. Every rejection test asserts this was
 * never called: the invariant under test is that a rejected request never
 * builds an McpServer, and therefore can never reach a Substack API call.
 */
let factory: Mock<() => ReturnType<typeof makeServer>>;

async function listen(options: HttpTransportOptions = {}): Promise<void> {
  factory = vi.fn(makeServer);
  httpServer = startHttpServer(() => factory(), 0, "127.0.0.1", options);
  await new Promise<void>((resolve) => httpServer!.once("listening", resolve));
}

function port(): number {
  return (httpServer!.address() as AddressInfo).port;
}

function baseUrl(): string {
  return `http://127.0.0.1:${port()}`;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

function post(headers: Record<string, string> = {}, body: BodyInit = JSON.stringify(INITIALIZE)) {
  return fetch(`${baseUrl()}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body,
  });
}

afterEach(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = undefined;
  }
});

describe("HTTP transport", () => {
  it("answers GET /health", async () => {
    await listen();
    const res = await fetch(`${baseUrl()}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  it("handles an MCP initialize request on POST /mcp", async () => {
    await listen();
    const res = await post();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"serverInfo"');
    expect(text).toContain('"name":"substack-mcp"');
  });

  it("rejects GET /mcp with 405", async () => {
    await listen();
    const res = await fetch(`${baseUrl()}/mcp`);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.message).toContain("Method not allowed");
  });

  it("404s on an unknown path", async () => {
    await listen();
    const res = await fetch(`${baseUrl()}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("HTTP transport: origin and host validation", () => {
  it("rejects an untrusted Origin with 403 and never builds a server", async () => {
    await listen();
    const res = await post({ Origin: "https://attacker.example" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { message: expect.stringContaining("Origin") } });
    expect(factory).not.toHaveBeenCalled();
  });

  it("accepts an explicitly allowed Origin", async () => {
    await listen();
    const res = await post({ Origin: `http://127.0.0.1:${port()}` });
    expect(res.status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("accepts a request with no Origin at all (non-browser MCP clients)", async () => {
    await listen();
    const res = await post();
    expect(res.status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("rejects an untrusted Host with 403 and never builds a server", async () => {
    await listen();
    // `fetch` will not let a Host header through, so this goes over a raw socket.
    const res = await rawRequest(port(), "attacker.example", []);
    expect(res.status).toBe(403);
    expect(res.body).toContain("Host header is not allowed");
    expect(factory).not.toHaveBeenCalled();
  });

  it("honours an explicit host allowlist", async () => {
    await listen({ allowedHosts: ["nas.local:1234"] });
    const allowed = await rawRequest(port(), "nas.local:1234", []);
    expect(allowed.status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(1);

    // The default loopback names are replaced, not extended, by an explicit list.
    const rejected = await rawRequest(port(), `127.0.0.1:${port()}`, []);
    expect(rejected.status).toBe(403);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('disables host checking with "*"', async () => {
    await listen({ allowedHosts: ["*"] });
    const res = await rawRequest(port(), "anything.example", []);
    expect(res.status).toBe(200);
  });
});

describe("HTTP transport: bearer auth", () => {
  it("rejects a request with no token when one is configured", async () => {
    await listen({ token: "FAKE-TEST-TOKEN" });
    const res = await post();
    expect(res.status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects a wrong token", async () => {
    await listen({ token: "FAKE-TEST-TOKEN" });
    const res = await post({ Authorization: "Bearer WRONG" });
    expect(res.status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });

  it("accepts the configured token", async () => {
    await listen({ token: "FAKE-TEST-TOKEN" });
    const res = await post({ Authorization: "Bearer FAKE-TEST-TOKEN" });
    expect(res.status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe("HTTP transport: request body limit", () => {
  /** Pads the initialize request out to exactly `bytes` of JSON. */
  function bodyOfExactly(bytes: number): string {
    const skeleton = JSON.stringify({ ...INITIALIZE, params: { ...INITIALIZE.params, pad: "" } });
    const padding = "a".repeat(Math.max(0, bytes - skeleton.length));
    return JSON.stringify({ ...INITIALIZE, params: { ...INITIALIZE.params, pad: padding } });
  }

  it("accepts a body exactly at the limit", async () => {
    const limit = 4096;
    await listen({ maxBodyBytes: limit });
    const body = bodyOfExactly(limit);
    expect(Buffer.byteLength(body)).toBe(limit);
    const res = await post({}, body);
    expect(res.status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("rejects a body one byte over the limit with 413 and never builds a server", async () => {
    const limit = 4096;
    await listen({ maxBodyBytes: limit });
    const body = bodyOfExactly(limit + 1);
    expect(Buffer.byteLength(body)).toBe(limit + 1);
    const res = await post({}, body);
    expect(res.status).toBe(413);
    expect(factory).not.toHaveBeenCalled();
  });

  it("bounds the streaming accumulator itself, with no Content-Length", async () => {
    const limit = 4096;
    await listen({ maxBodyBytes: limit });
    // Chunked: the request declares no length, so only the running byte
    // counter inside readJsonBody can stop this. 64 chunks of 1 KiB is 16x
    // the limit; a passing 413 here proves the accumulator is the gate.
    const res = await rawRequest(port(), `127.0.0.1:${port()}`, new Array(64).fill("a".repeat(1024)));
    expect(res.status).toBe(413);
    expect(factory).not.toHaveBeenCalled();
  });

  it("answers 400, not 500, on a malformed JSON body", async () => {
    await listen();
    const res = await post({}, "{not json");
    expect(res.status).toBe(400);
    expect(factory).not.toHaveBeenCalled();
  });
});

/**
 * Minimal raw HTTP/1.1 client. `fetch` refuses to set `Host` and always sets
 * `Content-Length`, so host validation and the chunked over-limit case both
 * need the socket directly.
 */
async function rawRequest(
  serverPort: number,
  hostHeader: string,
  chunks: string[],
): Promise<{ status: number; body: string }> {
  const net = await import("node:net");
  const payload = chunks.length > 0 ? chunks : [JSON.stringify(INITIALIZE)];

  return new Promise((resolve, reject) => {
    const socket = net.connect(serverPort, "127.0.0.1", () => {
      socket.write(
        `POST /mcp HTTP/1.1\r\n` +
          `Host: ${hostHeader}\r\n` +
          `Content-Type: application/json\r\n` +
          `Accept: application/json, text/event-stream\r\n` +
          `Transfer-Encoding: chunked\r\n` +
          `Connection: close\r\n\r\n`,
      );
      for (const chunk of payload) {
        socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
      }
      socket.write("0\r\n\r\n");
    });

    let raw = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);
      resolve({ status, body: raw });
    };

    socket.setEncoding("utf8");
    socket.on("data", (d) => {
      raw += d;
      // An accepted request answers with an SSE stream that stays open, so
      // waiting for `close` would hang. The status line plus a complete header
      // block is everything these assertions need.
      if (raw.includes("\r\n\r\n")) setTimeout(finish, 50);
    });
    socket.on("error", reject);
    socket.on("close", finish);
  });
}
