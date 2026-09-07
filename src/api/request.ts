import { extractErrorDetail, isAbortError, mapHttpStatusToError, ResponseError, SubstackAPIError, TimeoutError, type ResponseBodyIssue } from "../utils/errors.js";

export const MAX_JSON_BYTES = 10 * 1024 * 1024;
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_ERROR_BYTES = 64 * 1024;

/** Race operations against cancellation, including body reads and custom fetches. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function discard(response: Response) { void response.body?.cancel().catch(() => {}); }

/** Count decoded transport bytes as they arrive, not just Content-Length. */
export async function readBounded(response: Response, maxBytes: number, signal: AbortSignal, endpoint: string, expiresAt = Infinity): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid response byte limit.");
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    discard(response);
    throw new ResponseError(endpoint, "response_too_large");
  }
  if (!response.body) { signal.throwIfAborted(); return ""; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "", complete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      if (performance.now() >= expiresAt) throw new DOMException("Response deadline exceeded", "TimeoutError");
      const { done, value } = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (performance.now() >= expiresAt) throw new DOMException("Response deadline exceeded", "TimeoutError");
      if (done) { complete = true; return text + decoder.decode(); }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new ResponseError(endpoint, "response_too_large");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Cancellation itself can be slow: never wait for it to enforce a deadline.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function retryAfter(response: Response): string | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw || raw.length > 64) return undefined;
  if (/^\d{1,10}$/.test(raw)) return raw;
  if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw) && Number.isFinite(Date.parse(raw))) return raw;
  return undefined;
}

function redactDetail(detail: string, options: RequestInit): string {
  const cookie = new Headers(options.headers).get("cookie");
  if (!cookie) return detail;
  for (const part of cookie.split(";")) {
    const value = part.slice(part.indexOf("=") + 1).trim();
    if (!value) continue;
    detail = detail.replaceAll(value, "[redacted]");
    try { detail = detail.replaceAll(decodeURIComponent(value), "[redacted]"); } catch { /* Preserve opaque cookie values. */ }
  }
  return detail;
}

/** One deadline through headers/body. JSON calls never follow redirects or retry. */
async function request(url: string, options: RequestInit, timeoutMs: number, format: "json" | "text", maxBytes: number): Promise<unknown> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Request timeout must be a positive finite number.");
  timeoutMs = Math.max(1, Math.min(2_147_483_647, Math.floor(timeoutMs)));
  const expiresAt = performance.now() + timeoutMs;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  try {
    signal.throwIfAborted();
    let currentUrl = url, redirects = 0;
    let response: Response;
    while (true) {
      signal.throwIfAborted();
      if (performance.now() >= expiresAt) throw new TimeoutError(url, timeoutMs);
      const pending = fetch(currentUrl, { ...options, redirect: "manual", signal });
      // A substituted fetch may return after cancellation; discard its late body.
      void pending.then(response => { if (signal.aborted) discard(response); }, () => {});
      response = await abortable(pending, signal);
      if (signal.aborted || performance.now() >= expiresAt) {
        discard(response); signal.throwIfAborted(); throw new TimeoutError(url, timeoutMs);
      }
      const redirect = [301, 302, 303, 307, 308].includes(response.status);
      if (response.type === "opaqueredirect" || redirect) {
        discard(response);
        const location = response.headers.get("location");
        if (format !== "text" || !location || redirects >= 3) throw new ResponseError(url, "redirect_rejected");
        let target: URL;
        try { target = new URL(location, currentUrl); }
        catch { throw new ResponseError(url, "redirect_rejected"); }
        if (target.protocol !== "https:" || target.username || target.password || target.port) throw new ResponseError(url, "redirect_rejected");
        currentUrl = target.href; redirects++;
        continue;
      }
      break;
    }
    if ([401, 403, 429].includes(response.status)) {
      discard(response);
      throw mapHttpStatusToError(response.status, "Too many requests", url, retryAfter(response));
    }
    if (!response.ok) {
      let detail: string;
      let bodyIssue: ResponseBodyIssue | undefined;
      try {
        const text = await readBounded(response, MAX_ERROR_BYTES, signal, url, expiresAt);
        detail = extractErrorDetail(text, "unknown error", value => redactDetail(value, options));
      } catch (error) {
        // A known HTTP failure takes precedence over an unread diagnostic body.
        bodyIssue = error !== signal.reason && error instanceof ResponseError && error.code === "response_too_large" ? "response_too_large"
          : options.signal?.aborted && !deadline.aborted ? "request_cancelled"
          : deadline.aborted || isAbortError(error) ? "timeout" : "body_read_failed";
        detail = `HTTP error received; diagnostic body unavailable (${bodyIssue}); details were discarded`;
      }
      throw mapHttpStatusToError(response.status, detail, url, retryAfter(response), bodyIssue);
    }
    if (format === "json" && /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get("content-type") ?? "")) {
      discard(response);
      throw new ResponseError(url, "unexpected_html");
    }
    const text = await readBounded(response, maxBytes, signal, url, expiresAt);
    if (format === "text") return text;
    if (text.trimStart().startsWith("<")) throw new ResponseError(url, "unexpected_html");
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new ResponseError(url, "malformed_json"); }
    // Parsing is synchronous and byte-bounded, not preemptible. Preserve the
    // known complete result rather than manufacture an uncertain write outcome.
    return value;
  } catch (error) {
    // Preserve locally classified errors across cancellation during cleanup.
    // Caller-supplied abort reasons still receive static, credential-safe text.
    if (error instanceof SubstackAPIError && error !== signal.reason) throw error;
    if (options.signal?.aborted && !deadline.aborted) throw new ResponseError(url, "request_cancelled");
    if (deadline.aborted || isAbortError(error)) throw new TimeoutError(url, timeoutMs);
    throw error;
  }
}

export function requestJson<T>(url: string, options: RequestInit = {}, timeoutMs = 30_000, maxBytes = MAX_JSON_BYTES): Promise<T> {
  return request(url, options, timeoutMs, "json", maxBytes) as Promise<T>;
}

/** Public page GET only; never forward credentials or arbitrary caller headers. */
export async function requestText(url: string, options: RequestInit = {}, timeoutMs = 30_000): Promise<string> {
  const headers = new Headers(options.headers);
  if ((options.method && options.method !== "GET") || options.body || [...headers.keys()].some(name => !["user-agent", "accept"].includes(name))) {
    throw new Error("Public page reads accept only GET, User-Agent and Accept; credentials are not allowed.");
  }
  return request(url, { headers, method: "GET", credentials: "omit", signal: options.signal }, timeoutMs, "text", MAX_HTML_BYTES) as Promise<string>;
}
