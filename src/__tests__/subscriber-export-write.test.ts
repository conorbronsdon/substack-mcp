import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runSubscriberExport } from "../subscriber-export-cli.js";
import { SUBSCRIBER_EXPORT_FLAG } from "../api/subscriber-export.js";
import type { PublicationCredentials } from "../auth/resolve-publications.js";
import recorded from "./fixtures/subscriber-export-pages.json" with { type: "json" };

// Make the export writer's temporary-file cleanup fail, as an antivirus lock can on Windows.
const cleanup = vi.hoisted(() => ({ fail: false, raceTo: "", slowSync: false, late: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // `raceTo`: another process creates the destination after preflight, just before the exclusive link.
  // `slowSync`: the temporary file's fsync takes long enough to pass the time budget.
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (cleanup.slowSync && String(args[0]).endsWith(".tmp")) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); cleanup.late = true; };
    }
    return handle;
  }, link: async (from: string, to: string) => {
    if (cleanup.raceTo && to === cleanup.raceTo) await actual.writeFile(to, "another process", "utf8");
    return actual.link(from, to);
  }, unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
    if (cleanup.fail && String(path).endsWith(".tmp")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return actual.unlink(path);
  } };
});

type Page = { count: number; subscribers: Record<string, unknown>[] };
const pages = recorded.pages as Record<string, Page>;
const all = Object.values(pages).flatMap(page => page.subscribers);
const emails = Object.values(pages).flatMap(page => page.subscribers.map(row => String(row.user_email_address)));
const credentials: PublicationCredentials = { key: "example", label: "Example", publicationUrl: "https://example.substack.com", userId: "1", sessionToken: "example-session-token", source: "env", missing: [] };
let dir: string | undefined;

afterEach(async () => {
  cleanup.fail = false; cleanup.raceTo = ""; cleanup.slowSync = false; cleanup.late = false;
  vi.unstubAllGlobals();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const replay = () => vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const { offset, limit } = JSON.parse(String(init!.body)) as { offset: number; limit: number };
  return Response.json({ count: all.length, subscribers: all.slice(offset, offset + limit) });
}));

it("reports file_written: true when the CSV was published but cleanup failed", async () => {
  replay();
  dir = await mkdtemp(join(tmpdir(), "substack-subscriber-export-write-"));
  const output = { out: vi.fn(), error: vi.fn() };
  cleanup.fail = true;
  const code = await runSubscriberExport(
    ["--output", join(dir, "out.csv"), "--purpose", "Backup", "--confirm-subscriber-pii"], () => [credentials], output,
    { [SUBSCRIBER_EXPORT_FLAG]: "1" }, { sleep: async () => {}, now: () => 0, pageSize: recorded.page_size });
  expect(code).toBe(1);
  expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ ok: false, code: "write_failed", file_written: true });
  expect(await readdir(dir)).toContain("out.csv");
  const printed = [...output.out.mock.calls, ...output.error.mock.calls].map(call => String(call[0])).join("\n");
  for (const email of emails) expect(printed).not.toContain(email);
});

it("reports file_written: false when another process takes the destination after preflight", async () => {
  replay();
  dir = await mkdtemp(join(tmpdir(), "substack-subscriber-export-write-"));
  const output = { out: vi.fn(), error: vi.fn() }, path = join(dir, "out.csv");
  cleanup.raceTo = path;
  const code = await runSubscriberExport(
    ["--output", path, "--purpose", "Backup", "--confirm-subscriber-pii"], () => [credentials], output,
    { [SUBSCRIBER_EXPORT_FLAG]: "1" }, { sleep: async () => {}, now: () => 0, pageSize: recorded.page_size });
  expect(code).toBe(1);
  expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ ok: false, code: "write_failed", file_written: false });
  expect(await readFile(path, "utf8")).toBe("another process");
  expect(await readdir(dir)).toEqual(["out.csv"]);
});

it.each([["a new file", false], ["a --force replacement", true]])("does not publish %s when the write runs past the time budget", async (_name, force) => {
  replay();
  dir = await mkdtemp(join(tmpdir(), "substack-subscriber-export-write-"));
  const output = { out: vi.fn(), error: vi.fn() }, path = join(dir, "out.csv");
  if (force) await writeFile(path, "keep", "utf8");
  cleanup.slowSync = true;
  const code = await runSubscriberExport(
    ["--output", path, "--purpose", "Backup", "--confirm-subscriber-pii", "--max-minutes", "1", ...(force ? ["--force"] : [])], () => [credentials], output,
    { [SUBSCRIBER_EXPORT_FLAG]: "1" }, { sleep: async () => {}, now: () => (cleanup.late ? 61_000 : 0), pageSize: recorded.page_size });
  expect(code).toBe(1);
  expect(output.out).not.toHaveBeenCalled();
  expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ ok: false, code: "deadline_exceeded", file_written: false });
  expect(await readdir(dir)).toEqual(force ? ["out.csv"] : []);
  if (force) expect(await readFile(path, "utf8")).toBe("keep");
});
