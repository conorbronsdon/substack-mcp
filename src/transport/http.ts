/**
 * Streamable HTTP transport for running substack-mcp as a persistent network
 * service (e.g. behind `mcp-remote` on a NAS) instead of a per-session stdio
 * subprocess. Uses `node:http` directly rather than Express — the SDK's own
 * `createMcpExpressApp` helper pulls in Express, which ships no types and
 * isn't otherwise a dependency here, for what is just two routes.
 *
 * Runs in stateless mode (`sessionIdGenerator: undefined`): each request gets
 * its own McpServer + transport pair, per the SDK's documented pattern for
 * deployments that don't need cross-request session state.
 */
import http from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

function sendJsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  makeServer: () => McpServer,
): Promise<void> {
  if (req.method !== "POST") {
    sendJsonRpcError(res, 405, "Method not allowed. Use POST /mcp.");
    return;
  }

  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    const body = await readJsonBody(req);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("Error handling MCP request:", err instanceof Error ? err.message : String(err));
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, "Internal server error");
    }
  }
}

/** Starts the HTTP transport: `POST /mcp` plus a `GET /health` for container healthchecks. */
export function startHttpServer(makeServer: () => McpServer, port: number, host: string): http.Server {
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    void handleMcpRequest(req, res, makeServer);
  });

  httpServer.listen(port, host, () => {
    console.error(`Substack MCP server listening on http://${host}:${port} (POST /mcp, GET /health)`);
  });

  return httpServer;
}
