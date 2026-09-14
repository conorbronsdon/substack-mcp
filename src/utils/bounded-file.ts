import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Read a bounded regular UTF-8 file, including a bound if it grows after stat. */
export async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Expected a regular file no larger than ${maxBytes} bytes.`);
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error(`Input exceeds ${maxBytes} bytes.`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } finally { await file.close(); }
}
