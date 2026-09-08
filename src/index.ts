#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubstackClient } from "./api/client.js";
import { createServer, type PublicationConfig } from "./server.js";
import { resolvePublications } from "./auth/resolve-publications.js";
import { startHttpServer, type HttpTransportOptions } from "./transport/http.js";

/**
 * Wire every way this process can be asked to stop to one clean shutdown.
 *
 * SIGTERM/SIGINT: nothing installs a handler by default, and the kernel ignores
 * default-disposition signals for PID 1 â€” so in a container `docker stop` waits
 * out its full 10s grace period and then SIGKILLs. Handling the signal
 * in-process keeps the image free of an init wrapper.
 *
 * stdin EOF (stdio transport only): the normal end of an MCP stdio session.
 * The transport doesn't watch for it; the process just exits once the event
 * loop drains, which any still-pending request can hold open for the length
 * of its network timeout. Closing explicitly makes the ordinary shutdown
 * immediate either way. The HTTP transport has no stdin session to end, so
 * `watchStdin` is left off there â€” SIGTERM/SIGINT are its only stop signal.
 *
 * Idempotent by design: a second trigger arriving mid-shutdown is dropped, and
 * a `close()` that never settles is capped by a forced exit.
 */
function installShutdownHandlers(close: () => Promise<void>, watchStdin: boolean): void {
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
  if (watchStdin) {
    process.stdin.once("end", () => void shutdown("stdin EOF"));
  }
}

/** Parse SUBSTACK_REQUEST_TIMEOUT_MS, warning (not failing) on garbage. */
function resolveTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Warning: ignoring invalid SUBSTACK_REQUEST_TIMEOUT_MS="${raw}" â€” using the default.`);
    return undefined;
  }
  return parsed;
}

/** Split a comma-separated allowlist env var; `undefined` when unset/blank. */
function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Translate the `MCP_HTTP_*` env vars into a transport policy.
 *
 * Unset means the transport's own loopback-only defaults apply â€” the listener
 * fails closed, and reaching it under any other name is an explicit act
 * (`MCP_HTTP_ALLOWED_HOSTS`), not something a default hands out.
 */
export function resolveHttpOptions(port: number, env: NodeJS.ProcessEnv = process.env): HttpTransportOptions {
  const rawMax = env.MCP_HTTP_MAX_BODY_BYTES;
  let maxBodyBytes: number | undefined;
  if (rawMax !== undefined && rawMax !== "") {
    const parsed = Number(rawMax);
    if (Number.isFinite(parsed) && parsed > 0) {
      maxBodyBytes = parsed;
    } else {
      // Same policy as SUBSTACK_REQUEST_TIMEOUT_MS: garbage warns and falls
      // back rather than silently removing the limit.
      console.error(`Warning: ignoring invalid MCP_HTTP_MAX_BODY_BYTES="${rawMax}" â€” using the default.`);
    }
  }

  return {
    allowedHosts: parseList(env.MCP_HTTP_ALLOWED_HOSTS),
    allowedOrigins: parseList(env.MCP_HTTP_ALLOWED_ORIGINS),
    maxBodyBytes,
    token: env.MCP_HTTP_TOKEN || undefined,
  };
}

async function main() {
  // Env vars take precedence; a stored session (from `substack-mcp-login`)
  // fills any gaps. See resolve-publications.ts for the multi-publication
  // SUBSTACK_PUB_<KEY>_* scheme this falls back from.
  const pubCreds = resolvePublications();
  const multi = pubCreds.length > 1;
  const userAgent = process.env.SUBSTACK_USER_AGENT;
  const timeoutMs = resolveTimeoutMs(process.env.SUBSTACK_REQUEST_TIMEOUT_MS);

  // Only appended once 2+ publications are configured, so single-publication
  // log output stays byte-identical to what it was before this existed.
  const pubSuffix = (label: string): string => (multi ? ` for publication "${label}"` : "");

  const publications: PublicationConfig[] = pubCreds.map((p) => {
    if (p.missing.length > 0) {
      console.error(`Warning: Missing credentials${pubSuffix(p.label)}: ${p.missing.join(", ")}`);
      console.error(
        "Set them as SUBSTACK_* env vars, or run `substack-mcp-login` to sign in via browser. See README.md.",
      );
    } else if (p.source !== "env") {
      console.error(`Using stored credentials${pubSuffix(p.label)} (source: ${p.source}).`);
    }

    // Fail before connecting if any publication is invalid. Dropping one would
    // change the publication selector and could route a write to the wrong host.
    try {
      const client = new SubstackClient(p.publicationUrl, p.sessionToken, p.userId, userAgent, timeoutMs);
      return { key: p.key, label: p.label, client };
    } catch (error) {
      throw new Error(`Invalid configuration for publication "${p.key}": ${error instanceof Error ? error.message : "Credential validation failed."} Run substack-mcp doctor --json to inspect each publication; run substack-mcp-login to set up a session.`);
    }
  });

  const transportMode = process.env.MCP_TRANSPORT ?? "stdio";
  if (transportMode === "http") {
    const port = Number(process.env.MCP_HTTP_PORT) || 8080;
    const host = process.env.MCP_HTTP_HOST ?? "0.0.0.0";
    // Stateless: each request gets its own McpServer, so there's no single
    // instance to close on shutdown â€” only the underlying http.Server.
    const httpServer = startHttpServer(() => createServer(publications), port, host, resolveHttpOptions(port));
    installShutdownHandlers(() => new Promise((resolve) => httpServer.close(() => resolve())), false);
  } else {
    const server = createServer(publications);
    const transport = new StdioServerTransport();
    // Registered before connect so a signal arriving during startup is still
    // handled; McpServer.close() is safe on a server that never connected.
    installShutdownHandlers(() => server.close(), true);
    await server.connect(transport);
    console.error("Substack MCP server running on stdio");
  }

  // Auth is validated *after* connect, and the result only warns. Awaiting it
  // first put a network round trip in front of the MCP handshake: a host that
  // hangs rather than refuses (corporate proxy, blackholed route) stalled
  // `initialize` for undici's full connect timeout with no output at all.
  // Tools still error individually on a bad token, which is where the failure
  // is actionable anyway.
  await Promise.all(
    publications.map(async (p) => {
      try {
        const user = await p.client.validateAuth();
        console.error(`Authenticated as user ${user.id}${pubSuffix(p.label)}`);
      } catch (err) {
        console.error(
          `Warning: Authentication failed${pubSuffix(p.label)}. Tools will error until a valid session token is provided.`,
        );
        console.error(err instanceof Error ? err.message : String(err));
      }
    }),
  );
}

async function run() {
  const args = process.argv.slice(2);
  if (args[0] === "status") {
    const { runStatus } = await import("./operator-cli.js");
    process.exitCode = await runStatus(args.slice(1));
    return;
  }
  if (["analytics", "subscribers"].includes(args[0]) || (args[0] === "drafts" && ["list", "get"].includes(args[1]))) {
    const { runOperator } = await import("./operator-cli.js");
    process.exitCode = await runOperator(args);
    return;
  }
  if (args[0] === "drafts" && args[1] === "export") {
    const { runExport } = await import("./export-cli.js");
    process.exitCode = await runExport(args.slice(2));
    return;
  }
  if (args[0] === "drafts") {
    const { runDrafts } = await import("./draft-cli.js");
    process.exitCode = await runDrafts(args.slice(1));
    return;
  }
  if (args[0] === "export") {
    const { runExport } = await import("./export-cli.js");
    process.exitCode = await runExport(args.slice(1));
    return;
  }
  if (args[0] === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    return runDoctor(args.slice(1));
  }
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: substack-mcp [serve | status [--json] | doctor [--json] [--check-auth] | export <draft-id> [options] | drafts list/get/export/plan/apply [options] | analytics post <id> | subscribers count/get]\nWith no command, starts the MCP server. doctor checks configuration without network access; --check-auth adds a bounded read per publication. export saves Markdown and original JSON without changing Substack; run export --help. For reviewed updates, run drafts --help. Read commands: drafts list/get, analytics post, subscribers count/get; add --publication when needed. status is offline. Login: substack-mcp-login.");
    return;
  }
  if (args.length && !(args.length === 1 && args[0] === "serve")) {
    console.error("Unknown command. Run substack-mcp --help.");
    process.exitCode = 2;
    return;
  }
  await main();
}

run().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
