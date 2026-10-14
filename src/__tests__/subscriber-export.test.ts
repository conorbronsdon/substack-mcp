import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSubscriberExport } from "../subscriber-export-cli.js";
import { csvCell, SUBSCRIBER_EXPORT_FLAG, type ExportDeps } from "../api/subscriber-export.js";
import type { PublicationCredentials } from "../auth/resolve-publications.js";
import recorded from "./fixtures/subscriber-export-pages.json" with { type: "json" };

type Page = { count: number; subscribers: Record<string, unknown>[] };
const pages = recorded.pages as Record<string, Page>;
const all = Object.values(pages).flatMap(page => page.subscribers);
const emails = Object.values(pages).flatMap(page => page.subscribers.map(row => String(row.user_email_address)));
const credentials: PublicationCredentials = { key: "example", label: "Example", publicationUrl: "https://example.substack.com", userId: "1", sessionToken: "example-session-token", source: "env", missing: [] };
const enabled = { [SUBSCRIBER_EXPORT_FLAG]: "1" };
const directories: string[] = [];
const scratch = async () => { const path = await mkdtemp(join(tmpdir(), "substack-subscriber-export-test-")); directories.push(path); return path; };
const io = () => ({ out: vi.fn(), error: vi.fn() });
const printed = (output: ReturnType<typeof io>) => [...output.out.mock.calls, ...output.error.mock.calls].map(call => String(call[0])).join("\n");
const clock = (step = 0) => { let t = Date.parse("2026-10-14T00:00:00Z"); return () => (t += step); };
const deps = (overrides: Partial<ExportDeps> = {}): ExportDeps & { sleep: ReturnType<typeof vi.fn> } =>
  ({ sleep: vi.fn(async () => {}), now: clock(), pageSize: recorded.page_size, ...overrides }) as never;

/** Replays the recorded rows as one ordered list sliced by request offset and limit; `override` can replace any call by index or change `list`. */
function replay(override: (call: number, offset: number, list: Record<string, unknown>[]) => Response | undefined = () => undefined, list = [...all]) {
  let call = 0;
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { offset, limit } = JSON.parse(String(init!.body)) as { offset: number; limit: number };
    return override(call++, offset, list) ?? Response.json({ count: list.length, subscribers: list.slice(offset, offset + limit) });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const run = (args: string[], output = io(), env: NodeJS.ProcessEnv = enabled, d = deps()) => runSubscriberExport(args, () => [credentials], output, env, d);
const base = (path: string) => ["--output", path, "--purpose", "Migrate the free list to a self-hosted list", "--confirm-subscriber-pii"];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("subscriber export gate", () => {
  it("refuses to run without the experimental flag and makes no request", async () => {
    const fetch = replay(), output = io(), dir = await scratch();
    for (const env of [{}, { [SUBSCRIBER_EXPORT_FLAG]: "true" }, { [SUBSCRIBER_EXPORT_FLAG]: "0" }]) {
      expect(await run(base(join(dir, "out.csv")), output, env)).toBe(2);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ ok: false, code: "export_disabled", file_written: false });
    expect(await readdir(dir)).toEqual([]);
  });
  it.each([
    ["no consent flag", (p: string) => ["--output", p, "--purpose", "x"]],
    ["no purpose", (p: string) => ["--output", p, "--confirm-subscriber-pii"]],
    ["blank purpose", (p: string) => ["--output", p, "--purpose", "   ", "--confirm-subscriber-pii"]],
    ["no output", () => ["--purpose", "x", "--confirm-subscriber-pii"]],
    ["stdout output", () => ["--output", "-", "--purpose", "x", "--confirm-subscriber-pii"]],
    ["unknown include", (p: string) => [...base(p), "--include", "names"]],
    ["unknown option", (p: string) => [...base(p), "--search", "x"]],
    ["row cap above hard limit", (p: string) => [...base(p), "--max-rows", "100001"]],
  ])("rejects %s before any request", async (_name, args) => {
    const fetch = replay(), output = io(), dir = await scratch();
    expect(await run(args(join(dir, "out.csv")), output)).toBe(2);
    expect(JSON.parse(output.error.mock.calls[0][0]).code).toBe("invalid_arguments");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["a UNC share", "\\\\host\\share\\out.csv"],
    ["an extended UNC path", "\\\\?\\UNC\\host\\share\\out.csv"],
    ["a device path", "\\\\.\\pipe\\out"],
    ["a slash-form share", "//host/share/out.csv"],
    ["a mixed-separator share", "\\/host/share/out.csv"],
  ])("refuses %s as the output before any request", async (_name, path) => {
    const fetch = replay(), output = io();
    expect(await run(base(path), output)).toBe(2);
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ ok: false, code: "network_output", file_written: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses an existing output file without --force before reading subscribers", async () => {
    const fetch = replay(), output = io(), dir = await scratch(), path = join(dir, "out.csv");
    await writeFile(path, "keep", "utf8");
    expect(await run(base(path), output)).toBe(2);
    expect(JSON.parse(output.error.mock.calls[0][0]).code).toBe("output_unavailable");
    expect(fetch).not.toHaveBeenCalled(); expect(await readFile(path, "utf8")).toBe("keep");
  });
});

describe("subscriber export", () => {
  it("pages oldest-first with a one-row overlap and writes only the default projection", async () => {
    const fetch = replay(), output = io(), dir = await scratch(), path = join(dir, "out.csv"), d = deps();
    expect(await run(base(path), output, enabled, d)).toBe(0);
    const bodies = fetch.mock.calls.map(call => JSON.parse(String(call[1]!.body)));
    expect(bodies.map(body => body.offset)).toEqual([0, 2, 4]);
    for (const body of bodies) expect(body).toMatchObject({ limit: 3, filters: { order_by: "subscription_created_at" } });
    expect(fetch.mock.calls.every(call => new URL(String(call[0])).pathname === "/api/v1/subscriber-stats" && call[1]!.method === "POST")).toBe(true);
    expect(d.sleep.mock.calls).toEqual([[1000], [1000]]);
    const csv = await readFile(path, "utf8"), lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("user_email_address,subscription_id,subscription_interval");
    expect(lines).toHaveLength(8);
    expect(lines[1]).toBe("example-ada@example.org,1001,free");
    expect(lines[3]).toBe("'+example-formula@example.org,1003,free");
    expect(csv).not.toMatch(/Private Name|private\.jpg|900\d|activity|revenue/);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["out.csv"]);
    const summary = JSON.parse(output.out.mock.calls[0][0]);
    expect(summary).toMatchObject({ ok: true, publication: "example", rows: 7, total_matching: 7, completeness: "best_effort", pages: 3, retries: 0, file: path, purpose: "Migrate the free list to a self-hosted list" });
    for (const email of emails) expect(printed(output)).not.toContain(email);
  });
  it("adds requested field groups and forwards the type filter", async () => {
    const fetch = replay(), dir = await scratch(), path = join(dir, "out.csv");
    expect(await run([...base(path), "--include", "flags,revenue,created_at,activity_rating", "--types", "free,paid"])).toBe(0);
    expect(JSON.parse(String(fetch.mock.calls[0][1]!.body)).filters.subscription_type_in).toEqual(["free", "paid"]);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\r\n");
    expect(lines[0]).toBe("user_email_address,subscription_id,subscription_interval,activity_rating,created_at,revenue,is_comp,is_founding,is_gift,is_free_trial");
    expect(lines[6]).toBe("example-eve@example.org,1006,month,5,2026-06-15T12:00:00.123456789+00:00,800,false,false,true,false");
  });
  it("honors a bounded Retry-After on 429 and then completes", async () => {
    replay(call => call === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "7" } }) : undefined);
    const output = io(), dir = await scratch(), d = deps();
    expect(await run(base(join(dir, "out.csv")), output, enabled, d)).toBe(0);
    expect(d.sleep.mock.calls).toEqual([[1000], [7000], [1000]]);
    expect(JSON.parse(output.out.mock.calls[0][0])).toMatchObject({ rows: 7, retries: 1 });
  });
  it.each([
    ["exhausted retries", () => new Response("", { status: 429 }), "rate_limited"],
    ["an oversized Retry-After", () => new Response("", { status: 429, headers: { "retry-after": "3600" } }), "rate_limited"],
    ["persistent server errors", () => new Response("{\"error\":\"example-ada@example.org failed\"}", { status: 503 }), "upstream_unavailable"],
    ["an expired session", () => new Response("", { status: 401 }), "authentication"],
    ["a malformed page", () => Response.json({ count: 7, subscribers: [{ user_email_address: "example-ada@example.org" }] }), "invalid_subscriber_response"],
  ])("fails closed on %s without writing or printing subscriber data", async (_name, response, code) => {
    replay(call => call >= 1 ? response() : undefined);
    const output = io(), dir = await scratch(), d = deps();
    expect(await run(base(join(dir, "out.csv")), output, enabled, d)).toBe(1);
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ ok: false, code, pages_read: 1, file_written: false });
    expect(await readdir(dir)).toEqual([]);
    expect(d.sleep.mock.calls.length).toBeLessThanOrEqual(4);
    for (const email of emails) expect(printed(output)).not.toContain(email);
  });
  it("does not retry authentication failures", async () => {
    const fetch = replay(() => new Response("", { status: 403 }));
    expect(await run(base(join(await scratch(), "out.csv")))).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refuses to truncate when more rows match than --max-rows", async () => {
    const fetch = replay(), output = io(), dir = await scratch();
    expect(await run([...base(join(dir, "out.csv")), "--max-rows", "5"], output)).toBe(1);
    expect(JSON.parse(output.error.mock.calls[0][0]).code).toBe("row_limit_exceeded");
    expect(fetch).toHaveBeenCalledTimes(1); expect(await readdir(dir)).toEqual([]);
  });
  it.each([
    ["count drift on a middle page", (call: number, offset: number) => call === 1 ? Response.json({ count: 8, subscribers: all.slice(offset, offset + 3) }) : undefined],
    ["rows shifting back past the overlap anchor", (call: number) => call === 1 ? Response.json({ count: 7, subscribers: all.slice(3, 6) }) : undefined],
    ["a removal before the cursor offset by an append", (call: number, _offset: number, list: Record<string, unknown>[]) => {
      // Read 1001-1003, then 1001 unsubscribes and 1008 signs up: the count stays 7 and plain offsets would skip 1004.
      if (call === 1) list.shift(), list.push({ ...all[6], subscription_id: 1008, user_email_address: "example-late@example.org" });
      return undefined;
    }],
  ])("treats %s as an inconsistent snapshot and writes nothing", async (_name, override) => {
    replay(override);
    const output = io(), dir = await scratch();
    expect(await run(base(join(dir, "out.csv")), output)).toBe(1);
    expect(JSON.parse(output.error.mock.calls[0][0]).code).toBe("inconsistent_snapshot");
    expect(await readdir(dir)).toEqual([]);
  });
  it("aborts a request that outlives the remaining time budget", async () => {
    replay(call => call === 1 ? new Promise<Response>(() => {}) as never : undefined);
    const output = io(), dir = await scratch(), t = Date.parse("2026-10-14T00:00:00Z");
    let calls = 0;
    // Only ~50 ms of the one-minute budget is left when the second request starts, and it never answers.
    const now = () => (calls++ < 3 ? t : t + 60_000 - 50);
    expect(await run([...base(join(dir, "out.csv")), "--max-minutes", "1"], output, enabled, deps({ now }))).toBe(1);
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ code: "deadline_exceeded", pages_read: 1, file_written: false });
    expect(await readdir(dir)).toEqual([]);
  });
  it("does not publish when the final page lands after the time budget", async () => {
    const t = Date.parse("2026-10-14T00:00:00Z");
    let late = false;
    replay(call => { if (call === 2) late = true; return undefined; });
    const output = io(), dir = await scratch();
    const now = () => (late ? t + 61_000 : t);
    expect(await run([...base(join(dir, "out.csv")), "--max-minutes", "1"], output, enabled, deps({ now }))).toBe(1);
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ code: "deadline_exceeded", file_written: false });
    expect(await readdir(dir)).toEqual([]);
    for (const email of emails) expect(printed(output)).not.toContain(email);
  });
  it("stops at the time budget", async () => {
    replay();
    const output = io(), dir = await scratch();
    expect(await run([...base(join(dir, "out.csv")), "--max-minutes", "1"], output, enabled, deps({ now: clock(40_000) }))).toBe(1);
    expect(JSON.parse(output.error.mock.calls[0][0]).code).toBe("deadline_exceeded");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("csv cells", () => {
  it.each([["=SUM(A1)", "'=SUM(A1)"], ["+1", "'+1"], ["-x", "'-x"], ["@x", "'@x"], ["a,b", "\"a,b\""], ["say \"hi\"", "\"say \"\"hi\"\"\""], [null, ""], [-5, "-5"], [false, "false"]])("encodes %j", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });
});
