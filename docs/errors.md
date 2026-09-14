# Typed errors

API failures are mapped to a typed error hierarchy (`SubstackAPIError` base, with `AuthenticationError`, `RateLimitError`, `ValidationError`, `NotFoundError`, and `ServerError` subclasses keyed off HTTP status) in `src/utils/errors.ts`. Every tool call still surfaces the same error response shape on failure — the typed hierarchy just makes the message specific to what went wrong instead of a single generic "Substack API error" string.

| Class | Status | Triggered by |
|---|---|---|
| `AuthenticationError` | 401/403 | Expired/invalid session token, or a Cloudflare `error code: 1010` block (see [Custom domains & Cloudflare](../README.md#custom-domains--cloudflare)) |
| `RateLimitError` | 429 | Too many requests against the Substack API in a short window |
| `ValidationError` | 400 | Malformed or invalid arguments passed to a tool (e.g. a missing required field) |
| `NotFoundError` | 404 | The referenced draft, post, or note doesn't exist |
| `ServerError` | 5xx | Failure on Substack's side |
| `TimeoutError` | 408 (synthetic) | The request hit the client's own deadline — no response arrived, so there is no real status to report (see [Request timeout](../README.md#request-timeout)) |
| `SubstackAPIError` | any other status | Fallback for unmapped status codes |

Substack error response bodies are inconsistent — sometimes JSON (`{"error": "..."}` or `{"errors": [...]}`), sometimes plain text, and sometimes a large Cloudflare HTML block page. `extractErrorDetail` handles all three: it tries `JSON.parse` first, falls back to the raw text (trimmed and capped at ~500 characters so a multi-KB HTML page doesn't become the whole error message), and only uses a generic fallback string if the body is empty.
