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
  constructor(endpoint: string, detail: string) {
    super(429, "Rate limited by Substack: " + detail + ". Slow down requests and try again shortly.", endpoint);
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
 * Maps an HTTP status code + error detail string to the appropriate typed
 * error. 401/403 route to AuthenticationError with `detail` intentionally
 * discarded — AuthenticationError's constructor takes only `endpoint` so its
 * message stays the exact hardcoded cookie-refresh guidance the existing
 * tests assert on verbatim; threading `detail` through would either change
 * that message or require duplicating it. Falls back to the base
 * `SubstackAPIError` for status codes outside the mapped classes.
 */
export function mapHttpStatusToError(status: number, detail: string, endpoint: string): SubstackAPIError {
  if (status === 401 || status === 403) return new AuthenticationError(endpoint);
  if (status === 429) return new RateLimitError(endpoint, detail);
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
export function extractErrorDetail(responseData: string, fallback: string): string {
  const MAX_LENGTH = 500;

  try {
    const parsed = JSON.parse(responseData);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        return parsed.error;
      }
      if (typeof parsed.message === "string" && parsed.message.length > 0) {
        return parsed.message;
      }
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        return parsed.errors
          .map((e: unknown) => (typeof e === "string" ? e : JSON.stringify(e)))
          .join("; ");
      }
    }
  } catch {
    // Not JSON — fall through to raw-text handling below.
  }

  const trimmed = responseData.trim();
  if (trimmed.length > 0) {
    return trimmed.length > MAX_LENGTH ? trimmed.slice(0, MAX_LENGTH) + "..." : trimmed;
  }

  return fallback;
}
