/**
 * Remote image download for upload_image (#55). Node-only: it relies on a
 * per-request DNS `lookup` hook, so every connection (including each redirect)
 * is checked against the address it will actually connect to. There is no
 * separate preliminary lookup that DNS rebinding could get past.
 *
 * No Substack cookies or credentials are ever sent: this uses a bare request
 * with its own headers, not SubstackClient.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { RemoteImageError, type RemoteImage } from "./remote-image-errors.js";
import { REMOTE_IMAGE_DEADLINE_MS, REMOTE_IMAGE_MAX_BYTES, REMOTE_IMAGE_MAX_REDIRECTS } from "./remote-image-limits.js";

export const REMOTE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"] as const;

const reservedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) reservedV4.addSubnet(network, prefix, "ipv4");
// IPv6 must be global unicast (2000::/3) and outside ranges that embed or tunnel IPv4
// (6to4, Teredo, NAT64) or are documentation-only. Mapped, loopback, link-local,
// unique-local (including fd00:ec2::254) and multicast addresses fall outside 2000::/3.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const reservedV6 = new BlockList();
for (const [network, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) reservedV6.addSubnet(network, prefix, "ipv6");

/** True only for publicly routable unicast addresses. Unparseable input fails closed. */
export function isPublicAddress(address: string): boolean {
  try {
    const family = isIP(address);
    if (family === 4) return !reservedV4.check(address, "ipv4");
    if (family === 6) return !address.includes("%") && globalV6.check(address, "ipv6") && !reservedV6.check(address, "ipv6");
  } catch { /* fall through */ }
  return false;
}

type Resolve = (hostname: string, options: LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** A connection-time lookup that rejects the host if ANY resolved address is not allowed. */
export function createGuardedLookup(resolve: Resolve = dnsLookup, allow: (address: string) => boolean = isPublicAddress): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error || !Array.isArray(addresses) || !addresses.length) {
        callback(new RemoteImageError("dns_failed", `Could not resolve the image host ${hostname}.`) as NodeJS.ErrnoException, "", 0);
        return;
      }
      if (addresses.some(entry => !allow(entry.address))) {
        callback(new RemoteImageError("blocked_destination", `The image host ${hostname} resolves to a private, loopback, link-local, metadata or reserved address.`) as NodeJS.ErrnoException, "", 0);
        return;
      }
      const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
      const usable = family ? addresses.filter(entry => entry.family === family) : addresses;
      if (!usable.length) {
        callback(new RemoteImageError("dns_failed", `The image host ${hostname} has no address in the requested family.`) as NodeJS.ErrnoException, "", 0);
        return;
      }
      if (options?.all) callback(null, usable);
      else callback(null, usable[0].address, usable[0].family);
    });
  };
}

/** Identify an allowed raster format from its leading bytes. */
export function sniffImageType(bytes: Buffer): (typeof REMOTE_IMAGE_TYPES)[number] | null {
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("latin1");
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12))) return "image/avif";
  return null;
}

export interface RemoteImageOptions {
  maxBytes?: number;
  deadlineMs?: number;
  maxRedirects?: number;
  /** Test hooks. Production callers must not override the address policy or scheme. */
  resolve?: Resolve;
  allowAddress?: (address: string) => boolean;
  allowHttp?: boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function checkUrl(value: string | URL, allowHttp: boolean, allowAddress: (address: string) => boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RemoteImageError("invalid_url", "The image URL is not a valid absolute URL."); }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) throw new RemoteImageError("invalid_url", "Image URLs must use https.");
  if (url.username || url.password) throw new RemoteImageError("invalid_url", "Image URLs must not contain credentials.");
  if (!allowHttp && url.port) throw new RemoteImageError("invalid_url", "Image URLs must use the default https port.");
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!host) throw new RemoteImageError("invalid_url", "The image URL has no host.");
  // Literal addresses skip DNS lookup entirely, so check them here.
  if (isIP(host) && !allowAddress(host)) throw new RemoteImageError("blocked_destination", "The image URL points to a private, loopback, link-local, metadata or reserved address.");
  return url;
}

interface Hop { status: number; location?: string; contentType?: string; body?: Buffer }

function fetchHop(url: URL, lookup: LookupFunction, signal: AbortSignal, maxBytes: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      agent: false,
      lookup,
      signal,
      headers: { accept: REMOTE_IMAGE_TYPES.join(", "), "accept-encoding": "identity", "user-agent": "substack-mcp-image-fetch" },
    }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (REDIRECTS.has(status) || status !== 200) {
        response.resume();
        resolve({ status, location: typeof response.headers.location === "string" ? response.headers.location : undefined });
        return;
      }
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding.toLowerCase() !== "identity") {
        reject(new RemoteImageError("unsupported_encoding", "The image host returned an encoded body; only unencoded image bytes are accepted."));
        response.destroy();
        return;
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        reject(new RemoteImageError("too_large", `The image is larger than ${maxBytes} bytes.`));
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(new RemoteImageError("too_large", `The image is larger than ${maxBytes} bytes.`));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status, contentType: response.headers["content-type"], body: Buffer.concat(chunks, total) }));
      response.on("aborted", () => reject(new RemoteImageError("network", "The image download ended early.")));
      response.on("error", error => reject(error));
    });
    request.on("error", error => reject(error));
    request.end();
  });
}

/** Download an image URL and return it as a data URI for Substack's upload endpoint. */
export async function fetchRemoteImage(input: string, options: RemoteImageOptions = {}): Promise<RemoteImage> {
  const maxBytes = options.maxBytes ?? REMOTE_IMAGE_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? REMOTE_IMAGE_MAX_REDIRECTS;
  const allowAddress = options.allowAddress ?? isPublicAddress;
  const allowHttp = options.allowHttp ?? false;
  const lookup = createGuardedLookup(options.resolve, allowAddress);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.deadlineMs ?? REMOTE_IMAGE_DEADLINE_MS);
  try {
    let url = checkUrl(input, allowHttp, allowAddress);
    for (let redirects = 0; ; redirects++) {
      let hop: Hop;
      try {
        hop = await fetchHop(url, lookup, controller.signal, maxBytes);
      } catch (error) {
        if (controller.signal.aborted) throw new RemoteImageError("timeout", "The image download exceeded its deadline.");
        if (error instanceof RemoteImageError) throw error;
        const cause = (error as { cause?: unknown })?.cause;
        if (cause instanceof RemoteImageError) throw cause;
        throw new RemoteImageError("network", "The image could not be downloaded.");
      }
      if (REDIRECTS.has(hop.status)) {
        if (!hop.location) throw new RemoteImageError("http_status", `The image host returned HTTP ${hop.status} without a Location.`);
        if (redirects >= maxRedirects) throw new RemoteImageError("too_many_redirects", `The image URL redirected more than ${maxRedirects} times.`);
        url = checkUrl(new URL(hop.location, url), allowHttp, allowAddress);
        continue;
      }
      if (hop.status !== 200 || !hop.body) throw new RemoteImageError("http_status", `The image host returned HTTP ${hop.status}.`);
      const sniffed = sniffImageType(hop.body);
      if (!sniffed) throw new RemoteImageError("unsupported_type", "The downloaded file is not a PNG, JPEG, GIF, WebP or AVIF image. SVG and HEIC are not accepted.");
      const declared = (hop.contentType ?? "").split(";")[0].trim().toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
      if (declared !== sniffed) throw new RemoteImageError("type_mismatch", `The image host declared ${declared || "no content type"}, but the bytes are ${sniffed}.`);
      return { data_uri: `data:${sniffed};base64,${hop.body.toString("base64")}`, mime: sniffed, bytes: hop.body.length, final_url: url.href, redirects };
    }
  } finally {
    clearTimeout(timer);
  }
}
