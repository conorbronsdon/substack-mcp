import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "../server.js";
import { SubstackClient } from "../api/client.js";
import { startHttpServer } from "../transport/http.js";

function makeServer() {
  return createServer(new SubstackClient("https://example.substack.com", "tok", "1"));
}

let httpServer: ReturnType<typeof startHttpServer> | undefined;

async function listen(): Promise<void> {
  httpServer = startHttpServer(makeServer, 0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer!.once("listening", resolve));
}

function baseUrl(): string {
  const { port } = httpServer!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
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
    const res = await fetch(`${baseUrl()}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
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
