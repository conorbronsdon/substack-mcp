import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolvePublications, resolveSelectedPublications } from "./auth/resolve-publications.js";
import { SubstackClient } from "./api/client.js";
import { checkTarget, writeAtomic } from "./export-cli.js";
import {
  collectSubscriberExport, DEFAULT_EXPORT_BUDGET, EXPORT_INCLUDE, EXPORT_MAX_ROWS, SUBSCRIBER_EXPORT_FLAG, SubscriberExportError,
  exportColumns, toCsv, type ExportDeps, type ExportInclude, type ExportOptions,
} from "./api/subscriber-export.js";

const command = "subscribers export";
export const usage = `Usage: ${SUBSCRIBER_EXPORT_FLAG}=1 substack-mcp subscribers export --output <file.csv> --purpose <text> --confirm-subscriber-pii
         [--types free,paid,comp] [--include activity_rating,created_at,flags,revenue] [--max-rows 1-${EXPORT_MAX_ROWS}] [--max-minutes 1-120] [--force] [--publication key]
Experimental. Writes subscriber email addresses (personal data) to one local CSV file (owner-only on POSIX; on Windows it inherits the folder's access rules); nothing is printed or sent anywhere else.
Reads every matching row oldest-first through the subscriber-stats search, one page of 50 per second by default, and writes nothing if any page fails,
the list changes during the read, or more rows match than --max-rows (default ${DEFAULT_EXPORT_BUDGET.maxRows}). stdout gets a summary with counts only.
See docs/subscriber-export-design.md.`;

interface Options extends ExportOptions { output: string; purpose: string; force: boolean; publication?: string; maxRows: number; maxMinutes: number }

function list<T extends string>(value: string, allowed: readonly T[]): T[] {
  const items = value.split(",");
  if (items.some(item => !(allowed as readonly string[]).includes(item)) || new Set(items).size !== items.length) throw new Error("invalid list");
  return items as T[];
}
function bounded(value: string, max: number): number {
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error("invalid number");
  return Number(value);
}

function parse(args: string[]): Options {
  const options: Partial<Options> & { confirmed?: boolean } = { include: [], force: false, maxRows: DEFAULT_EXPORT_BUDGET.maxRows, maxMinutes: DEFAULT_EXPORT_BUDGET.maxDurationMs / 60_000 };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error("duplicate option");
    seen.add(flag);
    if (flag === "--force") { options.force = true; continue; }
    if (flag === "--confirm-subscriber-pii") { options.confirmed = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error("missing value");
    if (flag === "--output") options.output = value;
    else if (flag === "--purpose") options.purpose = value;
    else if (flag === "--publication" && value.length <= 128) options.publication = value;
    else if (flag === "--types") options.subscription_types = list(value, ["free", "paid", "comp"] as const);
    else if (flag === "--include") options.include = list<ExportInclude>(value, EXPORT_INCLUDE);
    else if (flag === "--max-rows") options.maxRows = bounded(value, EXPORT_MAX_ROWS);
    else if (flag === "--max-minutes") options.maxMinutes = bounded(value, 120);
    else throw new Error("unknown option");
  }
  if (!options.confirmed) throw new Error("missing consent");
  if (!options.output || options.output === "-") throw new Error("missing output");
  const purpose = options.purpose?.trim();
  if (!purpose || purpose.length > 200 || /[\x00-\x1f\x7f]/.test(purpose)) throw new Error("invalid purpose");
  return { ...options, purpose } as Options;
}

const defaultDeps: ExportDeps = { sleep: ms => delay(ms), now: () => Date.now() };

/**
 * CLI only, never an MCP tool: subscriber rows go to a local file and never
 * into an assistant's context, stdout, stderr or logs.
 */
export async function runSubscriberExport(
  args: string[], load: () => ReturnType<typeof resolvePublications> | Promise<ReturnType<typeof resolvePublications>> = resolveSelectedPublications,
  io = { out: (text: string) => console.log(text), error: (text: string) => console.error(text) },
  env: NodeJS.ProcessEnv = process.env, deps: ExportDeps = defaultDeps,
): Promise<number> {
  const reject = (code: string, message: string, exit: number, extra: Record<string, unknown> = {}) => {
    io.error(JSON.stringify({ format_version: 1, ok: false, command, code, file_written: false, ...extra, message })); return exit;
  };
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { io.out(usage); return 0; }
  if (env[SUBSCRIBER_EXPORT_FLAG] !== "1") return reject("export_disabled", `Subscriber export is experimental. Set ${SUBSCRIBER_EXPORT_FLAG}=1 to enable it. No request was made.`, 2);
  let options: Options;
  try { options = parse(args); } catch { return reject("invalid_arguments", usage, 2); }
  const output = resolve(options.output);
  try { await checkTarget(output, options.force); }
  catch { return reject("output_unavailable", "The output path exists or is not a regular file; use --force to replace a file. No request was made.", 2); }
  let publications;
  try { publications = await load(); } catch { return reject("configuration", "Credential or publication configuration could not be loaded. No request was made.", 1); }
  const selected = options.publication ? publications.find(p => p.key === options.publication) : publications.length === 1 ? publications[0] : undefined;
  if (!selected) return reject("publication_required", "Select a configured --publication key; required when multiple publications are configured.", 2);
  const startedAt = new Date(deps.now()).toISOString();
  try {
    const client = new SubstackClient(selected.publicationUrl, selected.sessionToken, selected.userId, env.SUBSTACK_USER_AGENT, Number(env.SUBSTACK_REQUEST_TIMEOUT_MS) || undefined);
    const result = await collectSubscriberExport(input => client.subscribers.search(input),
      { subscription_types: options.subscription_types, include: options.include },
      { ...DEFAULT_EXPORT_BUDGET, maxRows: options.maxRows, maxDurationMs: options.maxMinutes * 60_000 }, deps);
    try { await writeAtomic(output, toCsv(result.rows, options.include), options.force); }
    catch {
      // writeAtomic publishes, then removes its temporary copy, so a failure can come after the file exists.
      const present = await lstat(output).then(stat => stat.isFile(), () => false);
      return reject("write_failed", "Writing the CSV failed. Check the output path and the output directory for a leftover temporary file, and delete any copy you should not keep. No subscriber data was printed.", 1,
        { file_written: !present ? false : options.force ? "unknown" : true });
    }
    io.out(JSON.stringify({ format_version: 1, ok: true, command, publication: selected.key, purpose: options.purpose, file: output,
      columns: exportColumns(options.include), subscription_types: options.subscription_types ?? "all", rows: result.rows.length,
      total_matching: result.total_matching, pages: result.pages, retries: result.retries, started_at: startedAt, finished_at: new Date(deps.now()).toISOString(),
      note: "The file contains subscriber personal data. Keep it private and delete it when the stated purpose is complete." }));
    return 0;
  } catch (error) {
    if (error instanceof SubscriberExportError) {
      return reject(error.code, `${error.message} No file was written.`, 1, { pages_read: error.pagesRead, ...(error.status ? { status: error.status } : {}) });
    }
    return reject("unknown", "The export failed; no subscriber data was printed. Check configuration with doctor --json --check-auth.", 1);
  }
}
