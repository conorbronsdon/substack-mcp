import { constants } from "node:fs";
import { open } from "node:fs/promises";
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

/** Upper bound for `upload_image` with `image_path`; the whole file is held in memory as base64. */
export const LOCAL_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

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
  // Open without blocking so a FIFO cannot hang the call, then check the opened
  // file itself: devices (a symlink to /dev/zero), FIFOs and directories are
  // refused, and the byte count is bounded even if the file grows after stat.
  const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error(`"${filePath}" is not a regular file.`);
    if (stat.size > LOCAL_IMAGE_MAX_BYTES) throw new Error(`Local images are limited to ${LOCAL_IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > stat.size) throw new Error(`"${filePath}" changed while it was being read.`);
    return `data:${mime};base64,${bytes.subarray(0, size).toString("base64")}`;
  } finally { await file.close(); }
}
