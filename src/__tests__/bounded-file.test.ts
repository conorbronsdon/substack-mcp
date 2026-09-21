import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wrap lstat and open so a test can stand in for a directory entry that the
// platform cannot create (symbolic links need a privilege on Windows) or that
// changes between the check and the open. Every other call reaches the real
// file system.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

const { readBoundedFile } = await import("../utils/bounded-file.js");
const lstat = vi.mocked(fsPromises.lstat), open = vi.mocked(fsPromises.open);

const dir = mkdtempSync(join(tmpdir(), "substack-bounded-file-"));
const file = (name: string, content: string | Uint8Array) => { const path = join(dir, name); writeFileSync(path, content); return path; };

afterEach(() => { lstat.mockClear(); open.mockClear(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readBoundedFile", () => {
  it("reads a regular UTF-8 file up to the bound", async () => {
    expect(await readBoundedFile(file("exact.md", "Héllo"), 6)).toBe("Héllo");
    expect(await readBoundedFile(file("empty.md", ""), 6)).toBe("");
  });

  it("rejects a file one byte over the bound", async () => {
    await expect(readBoundedFile(file("over.md", "1234567"), 6)).rejects.toThrow("no larger than 6 bytes");
  });

  it("rejects bytes that are not valid UTF-8", async () => {
    await expect(readBoundedFile(file("invalid.md", new Uint8Array([0x48, 0xff, 0x69])), 6)).rejects.toThrow();
  });

  it("rejects a directory without opening it", async () => {
    const path = join(dir, "folder"); mkdirSync(path);
    await expect(readBoundedFile(path, 6)).rejects.toThrow("regular file");
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects a symbolic-link entry without opening its target", async () => {
    const path = file("reported-as-link.md", "Hello");
    lstat.mockResolvedValueOnce({ isFile: () => false, isSymbolicLink: () => true } as Awaited<ReturnType<typeof fsPromises.lstat>>);
    await expect(readBoundedFile(path, 6)).rejects.toThrow("regular file");
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects an actual symbolic link to a regular file", async context => {
    const target = file("link-target.md", "Hello"), path = join(dir, "link.md");
    try { symlinkSync(target, path, "file"); } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { context.skip(); return; }
      throw error;
    }
    await expect(readBoundedFile(path, 6)).rejects.toThrow("regular file");
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects a file that replaced the checked entry before the open", async () => {
    const checked = file("checked.md", "Safe"), opened = file("swapped.md", "Other");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    lstat.mockImplementationOnce(() => actual.lstat(checked));
    await expect(readBoundedFile(opened, 6)).rejects.toThrow("regular file");
    expect(open).toHaveBeenCalledTimes(1);
  });
});
