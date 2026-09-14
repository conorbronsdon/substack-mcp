/**
 * Runtime-neutral types for remote image ingestion. The Node fetcher lives in
 * remote-image.ts; this module has no Node imports so the Cloudflare Worker,
 * which shares createServer, can reference it without bundling node:https.
 */
export type RemoteImageErrorCode =
  | "invalid_url"
  | "blocked_destination"
  | "dns_failed"
  | "too_many_redirects"
  | "http_status"
  | "unsupported_encoding"
  | "too_large"
  | "timeout"
  | "unsupported_type"
  | "type_mismatch"
  | "network";

export class RemoteImageError extends Error {
  constructor(readonly code: RemoteImageErrorCode, message: string) {
    super(message);
    this.name = "RemoteImageError";
  }
}

export interface RemoteImage {
  data_uri: string;
  mime: string;
  bytes: number;
  final_url: string;
  redirects: number;
}

/** Downloads one image URL under the SSRF, size, time and type rules in remote-image.ts. */
export type RemoteImageFetcher = (url: string) => Promise<RemoteImage>;
