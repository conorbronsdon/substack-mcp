import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runSubscriberExport } from "../subscriber-export-cli.js";
import { SUBSCRIBER_EXPORT_FLAG } from "../api/subscriber-export.js";
import type { PublicationCredentials } from "../auth/resolve-publications.js";
import recorded from "./fixtures/subscriber-export-pages.json" with { type: "json" };

// Make the export writer's temporary-file cleanup fail, as an antivirus lock can on Windows.
const cleanup = vi.hoisted(() => ({ fail: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
    if (cleanup.fail && String(path).endsWith(".tmp")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return actual.unlink(path);
  } };
});

type Page = { count: number; subscribers: Record<string, unknown>[] };
const pages = recorded.pages as Record<string, Page>;
const emails = Object.values(pages).flatMap(page => page.subscribers.map(row => String(row.user_email_address)));
const credentials: PublicationCredentials = { key: "example", label: "Example", publicationUrl: "https://example.substack.com", userId: "1", sessionToken: "example-session-token", source: "env", missing: [] };
let dir: string | undefined;

afterEach(async () => {
  cleanup.fail = false;
  vi.unstubAllGlobals();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("reports file_written: true when the CSV was published but cleanup failed", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    Response.json(pages[String(JSON.parse(String(init!.body)).offset)] ?? { count: 7, subscribers: [] })));
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
