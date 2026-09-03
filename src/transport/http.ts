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
 *
 * ## Trust boundary
 *
 * Over stdio the boundary is the local user account: the MCP client spawns
 * this process and nothing else can speak to it. Over HTTP the boundary is
 * whatever can open a socket to the listener, and every request that gets
 * through carries the operator's Substack session cookie — including the two
 * tools that publish a Note immediately and irreversibly. So the listener
 * fails closed on both axes, all checked *before* `makeServer()` is called
 * and therefore before any Substack API call can be reached:
 *
 * 1. `Host` — an allowlist, defaulting to the loopback names for the bound
 *    port. Blocks DNS rebinding, where a name the attacker controls resolves
 *    to 127.0.0.1 and the user's own browser becomes the confused deputy.
 * 2. `Origin` — an allowlist, defaulting to the loopback origins. A *missing*
 *    `Origin` is allowed: non-browser MCP clients do not send one, and a
 *    browser always does on a cross-origin request, so requiring it would
 *    break every real client while blocking nothing.
 *
 * The SDK's own `enableDnsRebindingProtection` is deliberately not used. It is
 * marked `@deprecated` in favour of external middleware as of SDK 1.27.x, and
 * it runs inside `transport.handleRequest()` — i.e. after an McpServer already
 * exists. Checking here keeps the invariant that a rejected request never
 * builds a server.
 *
 * Request bodies are bounded while they stream, so one unauthenticated request
 * cannot buffer the process to death before the SDK ever validates it.
 */
import http from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Largest request body accepted, in bytes.
 *
 * `upload_image` takes a base64 data URI, which inflates the source file by
 * ~4/3 and then again as JSON-escaped text, so the cap has to clear a real
 * cover image comfortably. 10 MiB does; it is also small enough that a
 * concurrent flood of maximum-size requests stays inside an ordinary
 * container's memory. Override with `MCP_HTTP_MAX_BODY_BYTES`.
 */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface HttpTransportOptions {
  /**
   * Allowed `Host` header values. `["*"]` disables the check. Defaults to the
   * loopback names for `port`.
   */
  allowedHosts?: string[];
  /**
   * Allowed `Origin` header values. `["*"]` disables the check. Defaults to the
   * loopback origins for `port`. A request with no `Origin` is always allowed.
   */
  allowedOrigins?: string[];
  /** Body cap in bytes. Defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
}

class PayloadTooLargeError extends Error {}
class BadJsonError extends Error {}

/** Loopback `Host` values a client can legitimately use to reach `port`. */
export function defaultAllowedHosts(port: number): string[] {
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "localhost", "127.0.0.1", "[::1]"];
}

/** Loopback `Origin` values a browser could legitimately present for `port`. */
export function defaultAllowedOrigins(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
}

/**
 * Read the body with a hard byte cap enforced *while* chunks arrive.
 *
 * The running counter — not `Content-Length` — is the gate: a chunked request
 * declares no length, so trusting the header would leave the streaming path
 * unbounded. `Content-Length` is only a cheap early reject.
 */
async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes} byte limit.`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes} byte limit.`);
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadJsonError("Request body is not valid JSON.");
  }
}

function sendJsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

interface RequestPolicy {
  allowedHosts: string[];
  allowedOrigins: string[];
}

/**
 * Fail-closed header checks. Returns the error to send, or `undefined` to
 * proceed. Runs before any McpServer exists.
 */
function rejectRequest(
  req: http.IncomingMessage,
  policy: RequestPolicy,
): { status: number; message: string } | undefined {
  const host = req.headers.host;
  if (!policy.allowedHosts.includes("*") && (!host || !policy.allowedHosts.includes(host))) {
    return { status: 403, message: "Forbidden: Host header is not allowed." };
  }

  // An absent Origin is allowed on purpose — see the module comment.
  const origin = req.headers.origin;
  if (origin && !policy.allowedOrigins.includes("*") && !policy.allowedOrigins.includes(origin)) {
    return { status: 403, message: "Forbidden: Origin is not allowed." };
  }

  return undefined;
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  makeServer: () => McpServer,
  maxBodyBytes: number,
): Promise<void> {
  // Body first, server second: an oversized or malformed request never
  // allocates an McpServer or reaches a Substack client.
  let body: unknown;
  try {
    body = await readJsonBody(req, maxBodyBytes);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendJsonRpcError(res, 413, err.message);
    } else if (err instanceof BadJsonError) {
      sendJsonRpcError(res, 400, err.message);
    } else {
      console.error("Error reading MCP request body:", err instanceof Error ? err.message : String(err));
      sendJsonRpcError(res, 400, "Could not read request body.");
    }
    req.destroy();
    return;
  }

  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
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
export function startHttpServer(
  makeServer: () => McpServer,
  port: number,
  host: string,
  options: HttpTransportOptions = {},
): http.Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  // Port 0 means "pick one" — so the default allowlists cannot be built until
  // the listener is bound. Resolved on first use, then cached.
  let policy: RequestPolicy | undefined;
  const requestPolicy = (): RequestPolicy => {
    if (!policy) {
      const address = httpServer.address();
      const boundPort = address && typeof address === "object" ? address.port : port;
      policy = {
        allowedHosts: options.allowedHosts ?? defaultAllowedHosts(boundPort),
        allowedOrigins: options.allowedOrigins ?? defaultAllowedOrigins(boundPort),
      };
    }
    return policy;
  };

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Unauthenticated by design: a container healthcheck runs before any
    // credential is available, and this reveals nothing but liveness.
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, "Method not allowed. Use POST /mcp.");
      return;
    }

    const rejection = rejectRequest(req, requestPolicy());
    if (rejection) {
      sendJsonRpcError(res, rejection.status, rejection.message);
      req.destroy();
      return;
    }

    void handleMcpRequest(req, res, makeServer, maxBodyBytes);
  });

  httpServer.listen(port, host, () => {
    const address = httpServer.address();
    const boundPort = address && typeof address === "object" ? address.port : port;
    const resolved = requestPolicy();
    console.error(`Substack MCP server listening on http://${host}:${boundPort} (POST /mcp, GET /health)`);
    // Printed, not merely documented: the operator has to be able to see what
    // this listener will accept without reading the source.
    console.error(
      `HTTP policy: hosts=${resolved.allowedHosts.join(",")} origins=${resolved.allowedOrigins.join(",")} ` +
        `maxBodyBytes=${maxBodyBytes}`,
    );
  });

  return httpServer;
}
