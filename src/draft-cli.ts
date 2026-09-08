import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolvePublications } from "./auth/resolve-publications.js";
import { SubstackClient } from "./api/client.js";
import { planDraftUpdate, applyDraftUpdate, draftChangesInput, draftPlanOutput, DraftChangeError } from "./api/draft-changes.js";

const usage = "Usage: substack-mcp drafts plan --input changes.json [--publication key]\n       substack-mcp drafts apply --input changes.json --plan plan.json [--publication key]\nplan reads only and prints a review plan as JSON. apply requires the saved plan and identical changes; it can update an unpublished draft. Inspect the plan and Substack before applying. No automatic retries. Changes JSON: draft_id plus title, subtitle, body (Markdown), audience and optional allow_unsupported. Redirect stdout to retain a plan privately.";
const MAX_INPUT_BYTES = 1024 * 1024;

/** Read a bounded regular file, including a bound if it grows after stat. */
async function readJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error("Expected a regular JSON file no larger than 1 MiB.");
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_INPUT_BYTES) throw new Error("JSON input exceeds 1 MiB.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } finally { await file.close(); }
}

export async function runDrafts(args: string[], load = resolvePublications,
  io = { out: (text: string) => console.log(text), error: (text: string) => console.error(text) }): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { io.out(usage); return 0; }
  const action = args[0];
  const options: Record<string, string> = {};
  if (!["plan", "apply"].includes(action)) { io.error(usage); return 2; }
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!["--input", "--plan", "--publication"].includes(flag) || flag in options || !value || value.startsWith("--")) { io.error(usage); return 2; }
    options[flag] = value;
  }
  if (!options["--input"] || (action === "apply") !== !!options["--plan"]) { io.error(usage); return 2; }
  let input, receipt;
  try {
    input = draftChangesInput.parse(await readJson(options["--input"]));
    if (action === "apply") receipt = draftPlanOutput.parse(await readJson(options["--plan"])).receipt;
  } catch {
    io.error(JSON.stringify({ code: "invalid_input_file", message: "Read valid UTF-8 JSON from regular files at most 1 MiB. Changes must match the draft schema; --plan must contain the complete plan output. No write was attempted." }));
    return 2;
  }
  try {
    const pubs = load(), key = options["--publication"];
    const selected = key ? pubs.find(p => p.key === key) : pubs.length === 1 ? pubs[0] : undefined;
    if (!selected) throw new Error("Select a configured publication with --publication; required when multiple publications are configured.");
    const client = new SubstackClient(selected.publicationUrl, selected.sessionToken, selected.userId, process.env.SUBSTACK_USER_AGENT,
      Number(process.env.SUBSTACK_REQUEST_TIMEOUT_MS) || undefined);
    if (action === "plan") {
      io.out(JSON.stringify(await planDraftUpdate(client, input, selected.key), null, 2));
      return 0;
    }
    const result = await applyDraftUpdate(client, { ...input, receipt: receipt! }, selected.key);
    io.out(JSON.stringify(result, null, 2));
    return result.status === "verified" ? 0 : result.status === "conflict" ? 4 : 3;
  } catch (error) {
    const result = error instanceof DraftChangeError
      ? { code: error.code, message: error.message, unsupported_nodes: error.unsupported_nodes, write_attempts: 0 }
      : { code: "draft_command_failed", message: "Draft command failed; final state is not established. Check configuration with doctor and inspect Substack before any further write. Do not retry automatically." };
    io.error(JSON.stringify(result));
    return 1;
  }
}
