import { SubscriberSearchError, type SubscriberSearchInput, type SubscriberService } from "./subscribers.js";
import { SubstackAPIError, ResponseError } from "../utils/errors.js";

/** Experimental: the export command refuses to run unless this is exactly "1". */
export const SUBSCRIBER_EXPORT_FLAG = "SUBSTACK_EXPERIMENTAL_SUBSCRIBER_EXPORT";
export const EXPORT_PAGE_SIZE = 50;
export const EXPORT_MAX_ROWS = 100_000;
export const EXPORT_INCLUDE = ["activity_rating", "created_at", "flags", "revenue"] as const;
export type ExportInclude = typeof EXPORT_INCLUDE[number];

export interface ExportBudget { maxRows: number; pageDelayMs: number; maxRetries: number; maxRetryAfterMs: number; maxDurationMs: number }
export const DEFAULT_EXPORT_BUDGET: ExportBudget = { maxRows: 10_000, pageDelayMs: 1_000, maxRetries: 3, maxRetryAfterMs: 120_000, maxDurationMs: 30 * 60_000 };

export type ExportFailureCode = "row_limit_exceeded" | "rate_limited" | "authentication" | "deadline_exceeded" | "inconsistent_snapshot"
  | "filter_rejected" | "filter_not_honored" | "invalid_subscriber_response" | "upstream_unavailable" | "unknown";

const failureMessages: Record<ExportFailureCode, string> = {
  row_limit_exceeded: "More subscribers match than --max-rows allows. Narrow --types or raise --max-rows; nothing was truncated.",
  rate_limited: "Substack rate limited the export beyond its retry budget, or asked for a longer wait than allowed. Try again later.",
  authentication: "Substack rejected the session. Refresh it with substack-mcp login and check with doctor --json --check-auth.",
  deadline_exceeded: "The export exceeded its time budget before every page was read.",
  inconsistent_snapshot: "The subscriber list changed while it was being read (count drift or rows shifting between pages). Re-run the export.",
  filter_rejected: "Substack rejected the export filters.",
  filter_not_honored: "Returned rows contradicted the requested filters.",
  invalid_subscriber_response: "A subscriber page was malformed or outside the response contract.",
  upstream_unavailable: "Substack returned server errors or timed out beyond the retry budget.",
  unknown: "The export failed for an unclassified reason.",
};

/** Messages are static: upstream text, filters and subscriber values are never included. */
export class SubscriberExportError extends Error {
  constructor(public code: ExportFailureCode, public pagesRead: number, public rowsRead: number, public status?: number) {
    super(failureMessages[code]);
    this.name = "SubscriberExportError";
  }
}

type SearchResult = Awaited<ReturnType<SubscriberService["search"]>>;
export type ExportRow = SearchResult["subscribers"][number];
export interface ExportDeps { sleep: (ms: number) => Promise<void>; now: () => number; pageSize?: number }
export interface ExportOptions { subscription_types?: ("free" | "paid" | "comp")[]; include: ExportInclude[] }
export interface ExportResult { rows: ExportRow[]; total_matching: number; pages: number; retries: number; duration_ms: number }

function retryAfterMs(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  if (/^\d{1,10}$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * Read every matching subscriber through the verified subscriber-stats search,
 * oldest first so new signups land after the cursor. Fails closed: no partial
 * result is returned on any error, drift or limit.
 */
export async function collectSubscriberExport(
  search: (input: SubscriberSearchInput) => Promise<SearchResult>, options: ExportOptions, budget: ExportBudget, deps: ExportDeps,
): Promise<ExportResult> {
  const pageSize = deps.pageSize ?? EXPORT_PAGE_SIZE;
  const started = deps.now();
  const rows = new Map<number, ExportRow>();
  let offset = 0, pages = 0, retries = 0, duplicates = 0;
  let firstTotal: number | undefined, lastTotal = 0, drifted = false;
  const fail = (code: ExportFailureCode, status?: number) => new SubscriberExportError(code, pages, rows.size, status);
  const wait = async (ms: number) => {
    if (deps.now() - started + ms > budget.maxDurationMs) throw fail("deadline_exceeded");
    await deps.sleep(ms);
  };
  while (true) {
    if (deps.now() - started > budget.maxDurationMs) throw fail("deadline_exceeded");
    let page: SearchResult;
    try {
      page = await search({ ...(options.subscription_types ? { subscription_types: options.subscription_types } : {}), include: options.include, sort: "created_asc", limit: pageSize, offset });
    } catch (error) {
      if (error instanceof SubscriberSearchError) throw fail(error.code);
      if (error instanceof ResponseError) throw fail("invalid_subscriber_response");
      if (!(error instanceof SubstackAPIError)) throw fail("unknown");
      const status = error.statusSource === "http" ? error.statusCode : undefined;
      if (status === 401 || status === 403) throw fail("authentication", status);
      const transient = status === 429 || (status !== undefined && status >= 500) || error.statusCode === 408;
      if (!transient) throw fail("unknown", status);
      const exhausted = status === 429 ? "rate_limited" : "upstream_unavailable";
      if (retries >= budget.maxRetries) throw fail(exhausted, status);
      const requested = status === 429 ? retryAfterMs(error.retryAfter, deps.now()) : undefined;
      const delay = requested ?? budget.pageDelayMs * 2 ** (retries + 1);
      if (delay > budget.maxRetryAfterMs) throw fail(exhausted, status);
      retries++;
      await wait(delay);
      continue;
    }
    pages++;
    firstTotal ??= page.total_matching;
    lastTotal = page.total_matching;
    if (lastTotal !== firstTotal) drifted = true;
    if (lastTotal > budget.maxRows) throw fail("row_limit_exceeded");
    for (const row of page.subscribers) {
      if (rows.has(row.subscription_id)) duplicates++;
      else rows.set(row.subscription_id, row);
    }
    if (!page.has_more) break;
    offset = page.next_offset!;
    await wait(budget.pageDelayMs);
  }
  // Offset pages are not a snapshot: a removal shifts later rows back a page.
  if (drifted || duplicates > 0 || rows.size !== lastTotal) throw fail("inconsistent_snapshot");
  return { rows: [...rows.values()], total_matching: lastTotal, pages, retries, duration_ms: deps.now() - started };
}

export function exportColumns(include: readonly ExportInclude[]): string[] {
  return ["user_email_address", "subscription_id", "subscription_interval",
    ...(include.includes("activity_rating") ? ["activity_rating"] : []),
    ...(include.includes("created_at") ? ["created_at"] : []),
    ...(include.includes("revenue") ? ["revenue"] : []),
    ...(include.includes("flags") ? ["is_comp", "is_founding", "is_gift", "is_free_trial"] : [])];
}

/** RFC 4180 quoting plus a spreadsheet formula guard for text cells. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: readonly ExportRow[], include: readonly ExportInclude[]): string {
  const columns = exportColumns(include);
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map(column => csvCell((row as Record<string, unknown>)[column])).join(","));
  return lines.join("\r\n") + "\r\n";
}
