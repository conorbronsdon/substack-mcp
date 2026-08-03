#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubstackClient } from "./api/client.js";
import { createServer } from "./server.js";
import { resolveCredentials } from "./auth/resolve-credentials.js";

/**
 * Wire every way this process can be asked to stop to one clean transport close.
 *
 * SIGTERM/SIGINT: nothing installs a handler by default, and the kernel ignores
 * default-disposition signals for PID 1 — so in a container `docker stop` waits
 * out its full 10s grace period and then SIGKILLs. Handling the signal
 * in-process keeps the image free of an init wrapper.
 *
 * stdin EOF: the normal end of an MCP stdio session. The transport doesn't
 * watch for it; the process just exits once the event loop drains, which any
 * still-pending request can hold open for the length of its network timeout.
 * Closing explicitly makes the ordinary shutdown immediate either way.
 *
 * Idempotent by design: a second trigger arriving mid-shutdown is dropped, and
 * a `close()` that never settles is capped by a forced exit.
 */
function installShutdownHandlers(close: () => Promise<void>): void {
  let shuttingDown = false;

  const shutdown = async (trigger: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Shutting down (${trigger}).`);

    // Unref'd so it can never hold the event loop open by itself: it only
    // fires when something *else* is still keeping the process alive, which is
    // precisely the hang this guards against.
    setTimeout(() => process.exit(0), 2000).unref();

    try {
      await close();
    } catch (err) {
      console.error("Error while closing transport:", err instanceof Error ? err.message : String(err));
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.stdin.once("end", () => void shutdown("stdin EOF"));
}

/** Parse SUBSTACK_REQUEST_TIMEOUT_MS, warning (not failing) on garbage. */
function resolveTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Warning: ignoring invalid SUBSTACK_REQUEST_TIMEOUT_MS="${raw}" — using the default.`);
    return undefined;
  }
  return parsed;
}

async function main() {
  // Env vars take precedence; a stored session (from `substack-mcp-login`)
  // fills any gaps.
  const creds = resolveCredentials();
  const { publicationUrl, sessionToken, userId } = creds;

  if (creds.missing.length > 0) {
    console.error(`Warning: Missing credentials: ${creds.missing.join(", ")}`);
    console.error(
      "Set them as SUBSTACK_* env vars, or run `substack-mcp-login` to sign in via browser. See README.md.",
    );
  } else if (creds.source !== "env") {
    console.error(`Using stored credentials (source: ${creds.source}).`);
  }

  const userAgent = process.env.SUBSTACK_USER_AGENT;
  const timeoutMs = resolveTimeoutMs(process.env.SUBSTACK_REQUEST_TIMEOUT_MS);
  // The client constructor rejects a non-numeric user id; fall back to "0" so
  // startup surfaces the friendly missing-credentials warning above instead of
  // throwing when nothing is configured yet.
  const client = new SubstackClient(publicationUrl, sessionToken, userId || "0", userAgent, timeoutMs);

  const server = createServer(client);
  const transport = new StdioServerTransport();
  // Registered before connect so a signal arriving during startup is still
  // handled; McpServer.close() is safe on a server that never connected.
  installShutdownHandlers(() => server.close());
  await server.connect(transport);
  console.error("Substack MCP server running on stdio");

  // Auth is validated *after* connect, and the result only warns. Awaiting it
  // first put a network round trip in front of the MCP handshake: a host that
  // hangs rather than refuses (corporate proxy, blackholed route) stalled
  // `initialize` for undici's full connect timeout with no output at all.
  // Tools still error individually on a bad token, which is where the failure
  // is actionable anyway.
  try {
    const user = await client.validateAuth();
    console.error(`Authenticated as user ${user.id}`);
  } catch (err) {
    console.error("Warning: Authentication failed. Tools will error until a valid session token is provided.");
    console.error(err instanceof Error ? err.message : String(err));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
