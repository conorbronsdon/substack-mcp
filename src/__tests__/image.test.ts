import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileToDataUri, SUPPORTED_IMAGE_EXTENSIONS } from "../utils/image.js";

describe("fileToDataUri", () => {
  let dir: string;
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "substack-image-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("encodes a png file as a data URI with the right MIME type", async () => {
    const path = join(dir, "pic.png");
    await writeFile(path, pngBytes);
    const uri = await fileToDataUri(path);
    expect(uri).toBe(`data:image/png;base64,${pngBytes.toString("base64")}`);
  });

  it("maps .jpg and .jpeg to image/jpeg", async () => {
    const jpg = join(dir, "a.jpg");
    const jpeg = join(dir, "b.jpeg");
    await writeFile(jpg, pngBytes);
    await writeFile(jpeg, pngBytes);
    expect(await fileToDataUri(jpg)).toMatch(/^data:image\/jpeg;base64,/);
    expect(await fileToDataUri(jpeg)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("is case-insensitive on the extension", async () => {
    const path = join(dir, "PIC.PNG");
    await writeFile(path, pngBytes);
    expect(await fileToDataUri(path)).toMatch(/^data:image\/png;base64,/);
  });

  it("throws on an unsupported extension", async () => {
    const path = join(dir, "notes.txt");
    await writeFile(path, "hello");
    await expect(fileToDataUri(path)).rejects.toThrow(/Unsupported image file extension/);
  });

  it("throws when the file does not exist", async () => {
    await expect(fileToDataUri(join(dir, "missing.png"))).rejects.toThrow();
  });

  it("exposes the supported extension list", () => {
    expect(SUPPORTED_IMAGE_EXTENSIONS).toContain(".png");
    expect(SUPPORTED_IMAGE_EXTENSIONS).toContain(".webp");
  });
});
