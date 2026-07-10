import { readFile } from "node:fs/promises";
import { extname } from "node:path";

// Substack's image endpoint takes a base64 data URI. When a caller passes a
// local file path instead, we read the bytes and build that data URI here,
// inferring the MIME type from the file extension.
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export const SUPPORTED_IMAGE_EXTENSIONS = Object.keys(MIME_BY_EXT);

/**
 * Read a local image file and encode it as a base64 data URI
 * (e.g. "data:image/png;base64,...") suitable for Substack's image upload.
 */
export async function fileToDataUri(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(
      `Unsupported image file extension "${ext || "(none)"}" for "${filePath}". ` +
        `Supported extensions: ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}.`,
    );
  }
  const buffer = await readFile(filePath);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}
