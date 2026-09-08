import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePublications } from "./auth/resolve-publications.js";
import { SubstackClient } from "./api/client.js";
import { exportDraft, type DraftExport } from "./api/draft-export.js";

const usage = "Usage: substack-mcp export <draft-id> [--publication key] [--format json|markdown] [--output path] [--force]\nDefaults to a JSON bundle on stdout. Markdown requires --output and also saves <path>.source.json with the exact original body and diagnostics. Existing files are never replaced without --force.";
type Options = { id: number; publication?: string; format: "json" | "markdown"; output?: string; force: boolean };

function parse(args: string[]): Options {
  if (!/^\d+$/.test(args[0] ?? "") || !Number.isSafeInteger(Number(args[0])) || Number(args[0]) <= 0) throw new Error("Provide a positive safe-integer draft ID.");
  const result: Options = { id: Number(args[0]), format: "json", force: false };
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error("Duplicate export option.");
    seen.add(flag);
    if (flag === "--force") { result.force = true; continue; }
    if (!["--publication", "--format", "--output"].includes(flag)) throw new Error("Unknown export option.");
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("Export option is missing its value.");
    if (flag === "--publication") result.publication = value;
    else if (flag === "--output") result.output = value;
    else if (value === "json" || value === "markdown") result.format = value;
    else throw new Error("Export format must be json or markdown.");
  }
  if (result.format === "markdown" && !result.output) throw new Error("Markdown export requires --output so its original-source bundle can also be retained.");
  if (result.force && !result.output) throw new Error("--force requires --output.");
  return result;
}

async function checkTarget(path: string, force: boolean): Promise<void> {
  let stat;
  try { stat = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile()) throw new Error("Export destination must be a regular file; directories and symbolic links are not replaced.");
  if (!force) throw new Error("Export destination already exists; use --force to replace it.");
}

/** Publish one complete file. Exclusive linking prevents a no-force overwrite race. */
async function writeAtomic(path: string, text: string, force: boolean): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try { await file.writeFile(text, "utf8"); await file.sync(); }
    finally { await file.close(); }
    if (force) { await checkTarget(path, true); await rename(temporary, path); }
    else await link(temporary, path);
  } finally {
    try { await unlink(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function writeExportFiles(result: DraftExport, path: string, format: "json" | "markdown", force: boolean): Promise<string[]> {
  const output = resolve(path);
  const source = `${output}.source.json`;
  await checkTarget(output, force);
  if (format === "markdown") await checkTarget(source, force);
  if (format === "markdown" && result.markdown === null) throw new Error("Markdown is unavailable for this body; export JSON to retain the original source.");
  const bundle = JSON.stringify(result, null, 2) + "\n";
  if (format === "json") { await writeAtomic(output, bundle, force); return [output]; }
  // Two files cannot be committed atomically as a pair. Save the complete bundle
  // first: it also contains the exact generated Markdown if the second write fails.
  await writeAtomic(source, bundle, force);
  try { await writeAtomic(output, result.markdown!, force); }
  catch (error) {
    const rawCode = (error as NodeJS.ErrnoException)?.code;
    const code = typeof rawCode === "string" && /^E[A-Z0-9_]{1,24}$/.test(rawCode) ? rawCode : "UNKNOWN";
    throw new Error(`The original-source bundle was saved, but the Markdown file could not be saved (${code}). Inspect the .source.json file; no automatic retry was attempted.`, { cause: error });
  }
  return [output, source];
}

export async function runExport(
  args: string[], load = resolvePublications,
  io = { out: (text: string) => console.log(text), error: (text: string) => console.error(text) },
): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { io.out(usage); return 0; }
  let options: Options;
  try { options = parse(args); } catch (error) { io.error(`${(error as Error).message}\n${usage}`); return 2; }
  try {
    const publications = load();
    const selected = options.publication ? publications.find(p => p.key === options.publication) : publications.length === 1 ? publications[0] : undefined;
    if (!selected) throw new Error("Select a configured publication with --publication; required when multiple publications are configured.");
    const client = new SubstackClient(selected.publicationUrl, selected.sessionToken, selected.userId, process.env.SUBSTACK_USER_AGENT,
      Number(process.env.SUBSTACK_REQUEST_TIMEOUT_MS) || undefined);
    const result = await exportDraft(client, options.id, selected.key);
    if (options.output) {
      const files = await writeExportFiles(result, options.output, options.format, options.force);
      io.out(JSON.stringify({ draft_id: result.draft_id, publication: result.publication, status: result.status, files, unsupported_nodes: result.unsupported_nodes }));
    } else io.out(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : "Draft export failed.");
    return 1;
  }
}
