import { mkdtemp, readFile, readdir, writeFile, mkdir, rm, symlink, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { runExport, writeExportFiles } from "../export-cli.js";
import { exportDraft } from "../api/draft-export.js";
import type { PublicationCredentials } from "../auth/resolve-publications.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), unlink: vi.fn(actual.unlink) };
});

const source = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}]}';
const draft = { id: 42, publication_id: 7, draft_title: "Draft", audience: "everyone", draft_body: source };
const credentials: PublicationCredentials = { key: "example", label: "Example", publicationUrl: "https://example.substack.com", userId: "1", sessionToken: "example-session-token", source: "env", missing: [] };
const output = () => ({ out: vi.fn(), error: vi.fn() });
const directories: string[] = [];
const scratch = async () => { const path = await mkdtemp(join(tmpdir(), "substack-export-test-")); directories.push(path); return path; };
const bundle = () => exportDraft({ origin: credentials.publicationUrl, getPublication: async () => ({ data: { id: 7 } }), getDraft: async () => draft }, 42, "example");

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const path of directories.splice(0)) {
    expect(path.startsWith(join(tmpdir(), "substack-export-test-"))).toBe(true);
    await rm(path, { recursive: true, force: true });
  }
});

describe("export files", () => {
  it("saves a complete JSON bundle and refuses to overwrite it without force", async () => {
    const dir = await scratch(), path = join(dir, "draft.json"), result = await bundle();
    expect(await writeExportFiles(result, path, "json", false)).toEqual([path]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
    await expect(writeExportFiles({ ...result, title: "Changed" }, path, "json", false)).rejects.toThrow("already exists");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
    await writeExportFiles({ ...result, title: "Changed" }, path, "json", true);
    expect(JSON.parse(await readFile(path, "utf8")).title).toBe("Changed");
    expect(await readdir(dir)).toEqual(["draft.json"]);
  });
  it("always retains the original source and Markdown together in a sidecar", async () => {
    const dir = await scratch(), path = join(dir, "draft.md"), result = await bundle();
    expect(await writeExportFiles(result, path, "markdown", false)).toEqual([path, `${path}.source.json`]);
    expect(await readFile(path, "utf8")).toBe("Hello\n");
    const saved = JSON.parse(await readFile(`${path}.source.json`, "utf8"));
    expect(saved.source_prosemirror).toBe(source); expect(saved.markdown).toBe(await readFile(path, "utf8"));
    expect(await readdir(dir)).toEqual(["draft.md", "draft.md.source.json"]);
  });
  it.each(["draft.md", "draft.md.source.json"])("checks both destinations before writing when %s already exists", async name => {
    const dir = await scratch(); await writeFile(join(dir, name), "Keep me", "utf8");
    await expect(writeExportFiles(await bundle(), join(dir, "draft.md"), "markdown", false)).rejects.toThrow("already exists");
    expect(await readdir(dir)).toEqual([name]); expect(await readFile(join(dir, name), "utf8")).toBe("Keep me");
  });
  it("does not replace directories, even with force", async () => {
    const dir = await scratch(), path = join(dir, "protected"); await mkdir(path);
    await writeFile(join(path, "keep.txt"), "Keep", "utf8");
    await expect(writeExportFiles(await bundle(), path, "json", true)).rejects.toThrow("regular file");
    expect(await readFile(join(path, "keep.txt"), "utf8")).toBe("Keep");
  });
  it("refuses symbolic-link destinations without touching their target", async context => {
    const dir = await scratch(), path = join(dir, "link.json"), target = join(dir, "keep.json");
    await writeFile(target, "Keep", "utf8");
    try { await symlink(target, path, "file"); } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { context.skip(); return; }
      throw error;
    }
    await expect(writeExportFiles(await bundle(), path, "json", true)).rejects.toThrow("regular file");
    expect(await readFile(target, "utf8")).toBe("Keep");
  });
  it("does not create Markdown or sidecar files when Markdown is unavailable", async () => {
    const dir = await scratch(), result = await bundle();
    await expect(writeExportFiles({ ...result, markdown: null, status: "unavailable" }, join(dir, "draft.md"), "markdown", false)).rejects.toThrow("unavailable");
    expect(await readdir(dir)).toEqual([]);
  });
  it("protects the winning complete file from concurrent no-force exports", async () => {
    const dir = await scratch(), path = join(dir, "draft.json"), a = await bundle(), b = { ...a, title: "Other" };
    const attempts = await Promise.allSettled([writeExportFiles(a, path, "json", false), writeExportFiles(b, path, "json", false)]);
    expect(attempts.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(value => value.status === "rejected")).toHaveLength(1);
    expect([a, b]).toContainEqual(JSON.parse(await readFile(path, "utf8")));
    expect(await readdir(dir)).toEqual(["draft.json"]);
  });
  it("retains the complete source bundle and a safe error code when the Markdown write fails", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const dir = await scratch(), path = join(dir, "draft.md"), result = await bundle();
    vi.mocked(link).mockImplementation(async (from, to) => {
      if (String(to) === path) throw Object.assign(new Error("private filesystem details"), { code: "ENOSPC" });
      await actual.link(from, to);
    });
    try {
      await expect(writeExportFiles(result, path, "markdown", false)).rejects.toThrow("could not be saved (ENOSPC)");
      expect(JSON.parse(await readFile(`${path}.source.json`, "utf8"))).toEqual(result);
      expect(await readdir(dir)).toEqual(["draft.md.source.json"]);
    } finally { vi.mocked(link).mockImplementation(actual.link); }
  });
  it.each(["source", "markdown"])("reports saved files accurately when %s temporary-file cleanup fails", async stage => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const dir = await scratch(), path = join(dir, "draft.md"), result = await bundle();
    vi.mocked(unlink).mockImplementation(async temporary => {
      const isSource = String(temporary).includes(".source.json.");
      if (isSource === (stage === "source")) throw Object.assign(new Error("private filesystem details"), { code: "EACCES" });
      await actual.unlink(temporary);
    });
    try {
      await expect(writeExportFiles(result, path, "markdown", false)).rejects.toThrow("was saved; temporary-file cleanup failed (EACCES)");
      expect(JSON.parse(await readFile(`${path}.source.json`, "utf8"))).toEqual(result);
      if (stage === "markdown") expect(await readFile(path, "utf8")).toBe(result.markdown);
      else await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(dir)).filter(name => name.endsWith(".tmp"))).toHaveLength(1);
    } finally { vi.mocked(unlink).mockImplementation(actual.unlink); }
  });
  it("reports both the failed write and remaining temporary file when cleanup also fails", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const dir = await scratch(), path = join(dir, "draft.md"), result = await bundle();
    vi.mocked(link).mockImplementation(async (from, to) => {
      if (String(to) === path) throw Object.assign(new Error("private write details"), { code: "ENOSPC" });
      await actual.link(from, to);
    });
    vi.mocked(unlink).mockImplementation(async temporary => {
      if (!String(temporary).includes(".source.json.")) throw Object.assign(new Error("private cleanup details"), { code: "EACCES" });
      await actual.unlink(temporary);
    });
    try {
      let message = "";
      try { await writeExportFiles(result, path, "markdown", false); } catch (error) { message = (error as Error).message; }
      expect(message).toContain("was not saved (ENOSPC); temporary-file cleanup failed (EACCES)");
      const temporary = (await readdir(dir)).find(name => name.endsWith(".tmp"))!;
      expect(message).toContain(temporary);
      expect(message).not.toContain("private write details");
      expect(JSON.parse(await readFile(`${path}.source.json`, "utf8"))).toEqual(result);
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { vi.mocked(link).mockImplementation(actual.link); vi.mocked(unlink).mockImplementation(actual.unlink); }
  });
});

describe("export command", () => {
  it("has offline help and rejects invalid syntax before loading credentials", async () => {
    const load = vi.fn(() => [credentials]), io = output();
    expect(await runExport(["--help"], load, io)).toBe(0);
    expect(io.out.mock.calls[0][0]).toContain(".source.json");
    for (const args of [[], ["-1"], ["1.5"], ["42", "--publication"], ["42", "--format", "csv"], ["42", "--format", "markdown"], ["42", "--force"], ["42", "--unknown"], ["42", "--output", "a", "--output", "b"]]) expect(await runExport(args, load, io)).toBe(2);
    expect(load).not.toHaveBeenCalled();
  });
  it("requires an explicit configured publication when multiple exist", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const io = output(), load = () => [credentials, { ...credentials, key: "other" }];
    expect(await runExport(["42"], load, io)).toBe(1);
    expect(await runExport(["42", "--publication", "missing"], load, io)).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses the shared read-only core and prints the exact source bundle on stdout", async () => {
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      expect(options?.method ?? "GET").toBe("GET");
      return new Response(JSON.stringify(url.endsWith("/publication") ? { id: 7, name: "Example", subdomain: "example" } : draft));
    });
    vi.stubGlobal("fetch", fetchMock);
    const io = output();
    expect(await runExport(["42"], () => [credentials], io)).toBe(0);
    expect(io.error).not.toHaveBeenCalled();
    const result = JSON.parse(io.out.mock.calls[0][0]);
    expect(result).toMatchObject({ draft_id: 42, publication: "example", markdown: "Hello\n", source_prosemirror: source });
    expect(io.out.mock.calls[0][0]).not.toContain(credentials.sessionToken);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["https://example.substack.com/api/v1/publication", "https://example.substack.com/api/v1/drafts/42"]);
  });
});
