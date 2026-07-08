import { describe, it, expect } from "vitest";
import {
  SubstackAPIError,
  AuthenticationError,
  RateLimitError,
  ValidationError,
  NotFoundError,
  ServerError,
  mapHttpStatusToError,
  extractErrorDetail,
} from "../utils/errors.js";

describe("SubstackAPIError", () => {
  it("formats message with status code and endpoint", () => {
    const err = new SubstackAPIError(404, "not found", "/api/v1/posts/99");
    expect(err.message).toBe(
      "Substack API error (404) at /api/v1/posts/99: not found"
    );
    expect(err.statusCode).toBe(404);
    expect(err.endpoint).toBe("/api/v1/posts/99");
  });

  it("has correct name property", () => {
    const err = new SubstackAPIError(500, "oops", "/api");
    expect(err.name).toBe("SubstackAPIError");
  });

  it("is an instance of Error", () => {
    const err = new SubstackAPIError(400, "bad", "/api");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("AuthenticationError", () => {
  it("is a 401 with cookie guidance message", () => {
    const err = new AuthenticationError("/api/v1/drafts");
    expect(err.statusCode).toBe(401);
    expect(err.message).toContain("connect.sid");
    expect(err.message).toContain("substack.sid");
    expect(err.endpoint).toBe("/api/v1/drafts");
  });

  it("has correct name property", () => {
    const err = new AuthenticationError("/api");
    expect(err.name).toBe("AuthenticationError");
  });

  it("is an instance of SubstackAPIError", () => {
    const err = new AuthenticationError("/api");
    expect(err).toBeInstanceOf(SubstackAPIError);
  });
});

describe("RateLimitError", () => {
  it("is a 429 with rate-limit guidance", () => {
    const err = new RateLimitError("/api/v1/drafts", "too many requests");
    expect(err.statusCode).toBe(429);
    expect(err.endpoint).toBe("/api/v1/drafts");
    expect(err.message).toContain("too many requests");
    expect(err.message).toContain("Slow down");
  });

  it("has correct name property and extends SubstackAPIError", () => {
    const err = new RateLimitError("/api", "x");
    expect(err.name).toBe("RateLimitError");
    expect(err).toBeInstanceOf(SubstackAPIError);
  });
});

describe("ValidationError", () => {
  it("is a 400 with argument-checking guidance", () => {
    const err = new ValidationError("/api/v1/drafts", "missing draft_title");
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain("missing draft_title");
    expect(err.message).toContain("Check the arguments passed to this tool");
  });

  it("has correct name property and extends SubstackAPIError", () => {
    const err = new ValidationError("/api", "x");
    expect(err.name).toBe("ValidationError");
    expect(err).toBeInstanceOf(SubstackAPIError);
  });
});

describe("NotFoundError", () => {
  it("is a 404 mentioning the missing resource", () => {
    const err = new NotFoundError("/api/v1/drafts/99", "no such draft");
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain("no such draft");
    expect(err.message).toContain("draft, post, or note");
  });

  it("has correct name property and extends SubstackAPIError", () => {
    const err = new NotFoundError("/api", "x");
    expect(err.name).toBe("NotFoundError");
    expect(err).toBeInstanceOf(SubstackAPIError);
  });
});

describe("ServerError", () => {
  it("is a 5xx with retry-later guidance", () => {
    const err = new ServerError("/api/v1/drafts", "internal error");
    expect(err.statusCode).toBe(500);
    expect(err.message).toContain("internal error");
    expect(err.message).toContain("try again later");
  });

  it("has correct name property and extends SubstackAPIError", () => {
    const err = new ServerError("/api", "x");
    expect(err.name).toBe("ServerError");
    expect(err).toBeInstanceOf(SubstackAPIError);
  });
});

describe("mapHttpStatusToError", () => {
  it("maps 401 and 403 to AuthenticationError, discarding detail", () => {
    const err401 = mapHttpStatusToError(401, "some raw body that should be ignored", "/api/v1/drafts");
    const err403 = mapHttpStatusToError(403, "some raw body that should be ignored", "/api/v1/drafts");
    expect(err401).toBeInstanceOf(AuthenticationError);
    expect(err403).toBeInstanceOf(AuthenticationError);
    // Message must match AuthenticationError's own hardcoded guidance exactly,
    // not the discarded detail string — this is the 401/403 tradeoff.
    expect(err401.message).toBe(new AuthenticationError("/api/v1/drafts").message);
    expect(err401.message).not.toContain("some raw body");
  });

  it("maps 429 to RateLimitError", () => {
    const err = mapHttpStatusToError(429, "slow down", "/api");
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toContain("slow down");
  });

  it("maps 400 to ValidationError", () => {
    const err = mapHttpStatusToError(400, "bad params", "/api");
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("bad params");
  });

  it("maps 404 to NotFoundError", () => {
    const err = mapHttpStatusToError(404, "no such post", "/api");
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toContain("no such post");
  });

  it("maps 500-599 to ServerError", () => {
    expect(mapHttpStatusToError(500, "boom", "/api")).toBeInstanceOf(ServerError);
    expect(mapHttpStatusToError(502, "bad gateway", "/api")).toBeInstanceOf(ServerError);
    expect(mapHttpStatusToError(503, "unavailable", "/api")).toBeInstanceOf(ServerError);
  });

  it("falls back to base SubstackAPIError for unmapped status codes", () => {
    const err = mapHttpStatusToError(418, "teapot", "/api");
    expect(err).toBeInstanceOf(SubstackAPIError);
    expect(err).not.toBeInstanceOf(AuthenticationError);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(ServerError);
    expect(err.message).toContain("Substack API error (418)");
    expect(err.message).toContain("teapot");
  });
});

describe("extractErrorDetail", () => {
  it("returns the .error field from a JSON object body", () => {
    expect(extractErrorDetail('{"error": "Invalid parameters"}', "fallback")).toBe("Invalid parameters");
  });

  it("returns the .message field from a JSON object body when .error is absent", () => {
    expect(extractErrorDetail('{"message": "Draft is locked"}', "fallback")).toBe("Draft is locked");
  });

  it("joins a JSON .errors array into a single string", () => {
    const result = extractErrorDetail('{"errors": ["title is required", "body is too long"]}', "fallback");
    expect(result).toContain("title is required");
    expect(result).toContain("body is too long");
  });

  it("returns a plain-text response body as-is", () => {
    expect(extractErrorDetail("Not authorized", "fallback")).toBe("Not authorized");
  });

  it("falls back when response data is an empty string", () => {
    expect(extractErrorDetail("", "fallback")).toBe("fallback");
  });

  it("trims and caps a Cloudflare-style HTML block page", () => {
    const htmlPage =
      "\n\n  <!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>" +
      "<body>" +
      "error code: 1010".repeat(100) +
      "</body></html>\n\n";
    const result = extractErrorDetail(htmlPage, "fallback");
    expect(result.length).toBeLessThanOrEqual(503); // 500 chars + "..."
    expect(result.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(result.endsWith("...")).toBe(true);
  });
});
