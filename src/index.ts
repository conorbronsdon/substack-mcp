#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubstackClient } from "./api/client.js";
import { createServer } from "./server.js";

async function main() {
  const publicationUrl = process.env.SUBSTACK_PUBLICATION_URL || "";
  const sessionToken = process.env.SUBSTACK_SESSION_TOKEN || "";
  const userId = process.env.SUBSTACK_USER_ID || "0";

  const missingVars = [
    !process.env.SUBSTACK_PUBLICATION_URL && "SUBSTACK_PUBLICATION_URL",
    !process.env.SUBSTACK_SESSION_TOKEN && "SUBSTACK_SESSION_TOKEN",
    !process.env.SUBSTACK_USER_ID && "SUBSTACK_USER_ID",
  ].filter(Boolean);

  if (missingVars.length > 0) {
    console.error(`Warning: Missing environment variables: ${missingVars.join(", ")}`);
    console.error("Tools will error until all variables are configured. See README.md for setup.");
  }

  const client = new SubstackClient(publicationUrl, sessionToken, userId);

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
