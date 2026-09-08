import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createServer } from "./server.js";
import { SubstackClient } from "./api/client.js";
import { resolvePublications } from "./auth/resolve-publications.js";
import { doctor } from "./doctor.js";
import packageMetadata from "../package.json" with { type: "json" };

export async function runStatus(args: string[], load = resolvePublications,
  io = { out: (text: string) => console.log(text), error: (text: string) => console.error(text) }): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    io.out("Usage: substack-mcp status [--json]\nOffline configuration status; never launches a browser or checks remote authentication. Use doctor --json --check-auth for an opt-in authenticated read."); return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    io.error(JSON.stringify({ format_version: 1, ok: false, command: "status", code: "invalid_arguments", message: "Usage: substack-mcp status [--json]" })); return 2;
  }
  const result = await doctor(false, load);
  io.out(JSON.stringify({ format_version: 1, command: "status", ...result, runtime: { node: process.version, platform: process.platform }, version: packageMetadata.version }));
  return result.ok ? 0 : 1;
}

const usage = `Usage: substack-mcp drafts list [--offset n] [--limit 1-50] [--publication key]
       substack-mcp drafts get <draft-id> [--publication key]
       substack-mcp analytics post <post-id> [--publication key]
       substack-mcp subscribers count [--publication key]
       substack-mcp subscribers get <email> [--publication key]
Read-only JSON output. --json is accepted explicitly. Pagination performs one bounded page, not an automatic full export.
Subscriber and draft results are private; protect redirected output. Analytics uses the same bounded recent-post scan as MCP.`;

function integer(value: string | undefined, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (!value || !/^\d+$/.test(value)) throw new Error("invalid argument");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error("invalid argument");
  return number;
}

function parse(args: string[]) {
  const command = args.slice(0, 2).join(" ");
  const tools: Record<string, string> = { "drafts list": "list_drafts", "drafts get": "get_draft", "analytics post": "get_post_analytics", "subscribers count": "get_subscriber_count", "subscribers get": "get_subscriber" };
  const tool = tools[command];
  if (!tool) throw new Error("invalid command");
  const input: Record<string, unknown> = {};
  let index = 2;
  if (command === "drafts get") input.draft_id = integer(args[index++], 1);
  if (command === "analytics post") input.post_id = integer(args[index++], 1);
  if (command === "subscribers get") input.email = z.string().trim().email().max(254).parse(args[index++]);
  let publication: string | undefined;
  const seen = new Set<string>();
  while (index < args.length) {
    const flag = args[index++];
    if (seen.has(flag)) throw new Error("duplicate option");
    seen.add(flag);
    if (flag === "--json") continue;
    const value = args[index++];
    if (flag === "--publication") {
      if (!value || value.startsWith("--") || value.length > 128) throw new Error("invalid selection");
      publication = value;
    } else if (command === "drafts list" && flag === "--offset") input.offset = integer(value, 0);
    else if (command === "drafts list" && flag === "--limit") input.limit = integer(value, 1, 50);
    else throw new Error("unknown option");
  }
  return { command, tool, input, publication };
}

/** Uses the real MCP handlers so projection, pagination and read semantics stay shared. */
export async function runOperator(args: string[], load = resolvePublications,
  io = { out: (text: string) => console.log(text), error: (text: string) => console.error(text) }): Promise<number> {
  if (args.length >= 2 && ["--help", "-h"].includes(args.at(-1)!) && args.length <= 3) { io.out(usage); return 0; }
  let options: ReturnType<typeof parse>;
  try { options = parse(args); }
  catch { io.error(JSON.stringify({ format_version: 1, ok: false, code: "invalid_arguments", message: usage })); return 2; }
  let server: ReturnType<typeof createServer> | undefined;
  const client = new Client({ name: "substack-operator-cli", version: "1" });
  try {
    const publications = load();
    const selected = options.publication ? publications.find(p => p.key === options.publication) : publications.length === 1 ? publications[0] : undefined;
    if (!selected) {
      io.error(JSON.stringify({ format_version: 1, ok: false, command: options.command, code: "publication_required", message: "Select a configured --publication key; required when multiple publications are configured." })); return 2;
    }
    server = createServer([{ key: selected.key, label: selected.label, client: new SubstackClient(selected.publicationUrl, selected.sessionToken, selected.userId, process.env.SUBSTACK_USER_AGENT, Number(process.env.SUBSTACK_REQUEST_TIMEOUT_MS) || undefined) }]);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    const reply = await client.callTool({ name: options.tool, arguments: options.input });
    if (reply.isError) throw new Error("read failed");
    const content = reply.content as { type: string; text?: string }[];
    if (content.length !== 1 || content[0].type !== "text" || !content[0].text) throw new Error("unexpected output");
    const output = JSON.stringify({ format_version: 1, ok: true, command: options.command, publication: selected.key, data: JSON.parse(content[0].text) });
    if (Buffer.byteLength(output, "utf8") > 4 * 1024 * 1024) throw new Error("output limit");
    io.out(output); return 0;
  } catch {
    io.error(JSON.stringify({ format_version: 1, ok: false, command: options.command, code: "read_failed", message: "The read could not be completed within its response bounds. Check configuration and authentication with doctor --json --check-auth. No writes were attempted." })); return 1;
  } finally { await client.close(); await server?.close(); }
}
