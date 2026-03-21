import { describe, it, expect } from "vitest";
import { SubstackClient } from "../api/client.js";

describe("SubstackClient constructor", () => {
  it("parses valid numeric userId without throwing", () => {
    expect(
      () => new SubstackClient("https://example.substack.com", "tok123", "42")
    ).not.toThrow();
  });

  it("throws with clear message for invalid userId", () => {
    expect(
      () => new SubstackClient("https://example.substack.com", "tok123", "abc")
    ).toThrow('Invalid SUBSTACK_USER_ID: "abc" — must be a number');
  });

  it("strips trailing slash from publication URL", () => {
    // Access the private field via any cast to verify behavior
    const client = new SubstackClient(
      "https://example.substack.com/",
      "tok",
      "1"
    ) as any;
    expect(client.publicationUrl).toBe("https://example.substack.com");
  });

  it("sets cookie string with both connect.sid and substack.sid", () => {
    const client = new SubstackClient(
      "https://example.substack.com",
      "mytoken",
      "1"
    ) as any;
    expect(client.cookie).toContain("connect.sid=mytoken");
    expect(client.cookie).toContain("substack.sid=mytoken");
  });
});
