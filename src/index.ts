#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubstackClient } from "./api/client.js";
import { createServer } from "./server.js";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error("");
    console.error("Required environment variables:");
    console.error("  SUBSTACK_PUBLICATION_URL — e.g., https://yourblog.substack.com");
    console.error("  SUBSTACK_SESSION_TOKEN   — connect.sid cookie from browser DevTools");
    console.error("  SUBSTACK_USER_ID         — your numeric Substack user ID");
    console.error("");
    console.error("See README.md for setup instructions.");
    process.exit(1);
  }
  return value;
}

async function main() {
  const publicationUrl = getRequiredEnv("SUBSTACK_PUBLICATION_URL");
  const sessionToken = getRequiredEnv("SUBSTACK_SESSION_TOKEN");
  const userId = getRequiredEnv("SUBSTACK_USER_ID");

  const client = new SubstackClient(publicationUrl, sessionToken, userId);

  // Validate auth on startup
  try {
    const user = await client.validateAuth();
    console.error(`Authenticated as user ${user.id}`);
  } catch (err) {
    console.error("Authentication failed. Check your SUBSTACK_SESSION_TOKEN.");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
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
