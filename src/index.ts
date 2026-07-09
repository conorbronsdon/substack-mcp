#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubstackClient } from "./api/client.js";
import { createServer } from "./server.js";
import { resolveCredentials } from "./auth/resolve-credentials.js";

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
  // The client constructor rejects a non-numeric user id; fall back to "0" so
  // startup surfaces the friendly missing-credentials warning above instead of
  // throwing when nothing is configured yet.
  const client = new SubstackClient(publicationUrl, sessionToken, userId || "0", userAgent);

  // Validate auth on startup (warn but don't block — allows inspection without credentials)
  try {
    const user = await client.validateAuth();
    console.error(`Authenticated as user ${user.id}`);
  } catch (err) {
    console.error("Warning: Authentication failed. Tools will error until a valid session token is provided.");
    console.error(err instanceof Error ? err.message : String(err));
  }

  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Substack MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
