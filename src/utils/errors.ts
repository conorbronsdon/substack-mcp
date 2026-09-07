export class SubstackAPIError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public endpoint: string,
  ) {
    super(`Substack API error (${statusCode}) at ${endpoint}: ${message}`);
    this.name = "SubstackAPIError";
  }
}

export class AuthenticationError extends SubstackAPIError {
  constructor(endpoint: string) {
    super(401, "Session token is invalid or expired. Get a fresh token from browser DevTools > Application > Cookies > connect.sid (or substack.sid on substack.com)", endpoint);
    this.name = "AuthenticationError";
  }
}

/** HTTP 429 — too many requests against the Substack API. */
export class RateLimitError extends SubstackAPIError {
  constructor(endpoint: string, detail: string, public retryAfter?: string) {
    super(429, "Rate limited by Substack: " + detail + ". Slow down requests and try again shortly." + (retryAfter ? ` Retry-After: ${retryAfter}.` : ""), endpoint);
    this.name = "RateLimitError";
  }
}

/** HTTP 400 — malformed or invalid request parameters. */
export class ValidationError extends SubstackAPIError {
  constructor(endpoint: string, detail: string) {
    super(400, "Validation error: " + detail + ". Check the arguments passed to this tool.", endpoint);
    this.name = "ValidationError";
  }
}

/** HTTP 404 — the requested draft, post, or note does not exist. */
export class NotFoundError extends SubstackAPIError {
  constructor(endpoint: string, detail: string) {
    super(404, "Not found: " + detail + ". The draft, post, or note may not exist or may have been deleted.", endpoint);
    this.name = "NotFoundError";
  }
}

/** HTTP 5xx — failure on Substack's side. */
export class ServerError extends SubstackAPIError {
  constructor(endpoint: string, detail: string) {
    super(500, "Server error: " + detail + ". Substack may be having issues — try again later.", endpoint);
    this.name = "ServerError";
  }
}

/**
 * The client's deadline fired before the full response was received.
 *
 * There is no real status here — 408 is synthetic,
 * chosen only so this fits the `SubstackAPIError` shape every tool handler
 * already renders. Without it, an aborted fetch surfaces as a bare
 * `DOMException: The operation was aborted due to timeout`, which says nothing
 * about which request died or how to fix it.
 */
export class TimeoutError extends SubstackAPIError {
  constructor(endpoint: string, timeoutMs: number) {
    super(
      408,
      `Request timed out after ${timeoutMs}ms before the full response was received. The host may be unreachable, ` +
        "or behind a proxy that drops packets instead of refusing the connection. " +
        "Set SUBSTACK_REQUEST_TIMEOUT_MS to raise the limit if the publication is just slow.",
      endpoint,
    );
    this.name = "TimeoutError";
  }
}

/**
 * True when a rejected `fetch` was aborted rather than failing on its own.
 *
 * Shape varies by runtime: `AbortSignal.timeout()` rejects with a DOMException
 * named `TimeoutError`, older undici builds substitute a generic `AbortError`
 * instead of propagating the signal's reason, and some wrap the abort in a
 * `TypeError` with the real reason on `.cause`. All three mean the same thing,
 * so all three are matched.
 */
export function isAbortError(err: unknown): boolean {
  const isAbortNamed = (e: unknown): boolean => {
    const name = (e as { name?: unknown } | null | undefined)?.name;
    return name === "TimeoutError" || name === "AbortError";
  };
  return (
    isAbortNamed(err) ||
    isAbortNamed((err as { cause?: unknown } | null | undefined)?.cause)
  );
}

/**
 * Maps an HTTP status code + error detail string to the appropriate typed
 * error. 401/403 route to AuthenticationError with `detail` intentionally
 * discarded — AuthenticationError's constructor takes only `endpoint` so its
 * message stays the exact hardcoded cookie-refresh guidance the existing
 * tests assert on verbatim; threading `detail` through would either change
 * that message or require duplicating it. Falls back to the base
 * `SubstackAPIError` for status codes outside the mapped classes.
 */
export function mapHttpStatusToError(status: number, detail: string, endpoint: string, retryAfter?: string): SubstackAPIError {
  if (status === 401 || status === 403) return new AuthenticationError(endpoint);
  if (status === 429) return new RateLimitError(endpoint, detail, retryAfter);
  if (status === 400) return new ValidationError(endpoint, detail);
  if (status === 404) return new NotFoundError(endpoint, detail);
  if (status >= 500) return new ServerError(endpoint, detail);
  return new SubstackAPIError(status, detail, endpoint);
}

/**
 * Pulls a human-readable detail string out of a Substack error response
 * body. Substack error bodies are inconsistent: some are JSON objects
 * (`{"error": "..."}` or `{"errors": [...]}`), some are plain text, and
 * some — notably a Cloudflare block page on custom domains, see README's
 * "403 error code: 1010" section — are large HTML documents. This function
 * tries JSON first, then falls back to the raw text (trimmed and capped so
 * a multi-KB Cloudflare HTML blob doesn't become the entire error message).
 */
export function extractErrorDetail(responseData: string, fallback: string, redact = (value: string) => value): string {
  const MAX_LENGTH = 500;
  const cap = (value: string) => { const safe = redact(value); return safe.length > MAX_LENGTH ? safe.slice(0, MAX_LENGTH) + "..." : safe; };

  try {
    const parsed = JSON.parse(responseData);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        return cap(parsed.error);
      }
      if (typeof parsed.message === "string" && parsed.message.length > 0) {
        return cap(parsed.message);
      }
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        return cap(parsed.errors
          .map((e: unknown) => (typeof e === "string" ? e : JSON.stringify(e)))
          .join("; "));
      }
    }
  } catch {
    // Not JSON — fall through to raw-text handling below.
  }

  const trimmed = responseData.trim();
  if (trimmed.length > 0) {
    return cap(trimmed);
  }

  return cap(fallback);
}

export type ResponseErrorCode = "response_too_large" | "unexpected_html" | "malformed_json" | "redirect_rejected" | "request_cancelled";
export class ResponseError extends SubstackAPIError {
  constructor(endpoint: string, public code: ResponseErrorCode) {
    const messages: Record<ResponseErrorCode, string> = {
      response_too_large: "Response exceeds the byte limit; no partial result was returned.",
      unexpected_html: "Expected JSON but received HTML, possibly a sign-in or blocking page.",
      malformed_json: "Response is not valid JSON; no result can be verified.",
      redirect_rejected: "Redirect rejected. Configure the publication origin that serves API requests directly; no redirect was followed.",
      request_cancelled: "Request cancelled before completion.",
    };
    super(502, messages[code], endpoint); // Synthetic status for a client-side failure.
    this.name = "ResponseError";
  }
}
