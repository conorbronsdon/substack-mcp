import { describe, it, expect } from "vitest";
import { SubstackAPIError, AuthenticationError } from "../utils/errors.js";

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
