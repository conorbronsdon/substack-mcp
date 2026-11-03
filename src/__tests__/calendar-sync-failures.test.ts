import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeSyncFailure, SyncFailure, toolFailure } from "../calendar-sync.js";
import { AuthenticationError, mapHttpStatusToError } from "../utils/errors.js";
import { contractRegistrar } from "../output-contracts.js";

const REAUTH_DETAIL = "For your security, please sign out and sign back in to do this.";

describe("Substack reauthentication 403", () => {
  it("maps Substack's reauthentication body to its own reason", () => {
    const error = mapHttpStatusToError(403, REAUTH_DETAIL, "/api/v1/subscriber-stats");
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).reason).toBe("reauthentication_required");
    expect(error.message).toContain("reauthentication_required");
  });

  it("keeps the expired-session reason for other 401/403 responses", () => {
    expect((mapHttpStatusToError(403, "Forbidden", "/api") as AuthenticationError).reason).toBe("invalid_or_expired");
    expect((mapHttpStatusToError(401, REAUTH_DETAIL, "/api") as AuthenticationError).reason).toBe("invalid_or_expired");
  });
});

describe("calendar sync failure reasons", () => {
  it("names the reason from a tool error payload without echoing other fields", () => {
    const content = [{ type: "text", text: JSON.stringify({ code: "upstream_error", status: 403, auth_reason: "reauthentication_required", message: "reader@example.org leaked?" }) }];
    const { reason, line } = describeSyncFailure(toolFailure("get_subscriber", content));
    expect(reason).toBe("substack_reauthentication_required");
    expect(line).toContain("reason=substack_reauthentication_required, status=403");
    expect(line).not.toContain("@");
  });

  it("falls back to the tool code, then a generic code, for unusable payloads", () => {
    expect(toolFailure("t", [{ type: "text", text: JSON.stringify({ code: "result_too_large" }) }]).reason).toBe("substack_result_too_large");
    expect(toolFailure("t", [{ type: "text", text: JSON.stringify({ code: "Bad Code <x@y.z>" }) }]).reason).toBe("substack_upstream_error");
    expect(toolFailure("t", [{ type: "text", text: "not json" }]).reason).toBe("substack_upstream_error");
    expect(toolFailure("t", undefined).reason).toBe("substack_upstream_error");
  });

  it("classifies lock, validation and unknown failures", () => {
    expect(describeSyncFailure(Object.assign(new Error("exists"), { code: "EEXIST" })).reason).toBe("lock_held");
    expect(describeSyncFailure(z.string().safeParse(1).error).reason).toBe("invalid_config_or_state");
    expect(describeSyncFailure(new SyntaxError("bad json")).reason).toBe("invalid_config_or_state");
    expect(describeSyncFailure(new SyncFailure("scan_cap", "x")).reason).toBe("scan_cap");
    const unknown = describeSyncFailure(new Error("reader@example.org exploded"));
    expect(unknown.reason).toBe("unexpected");
    expect(unknown.line).not.toContain("@");
  });
});

describe("tool error contract", () => {
  async function errorPayload(thrown: unknown) {
    let handler: ((...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    const fake = { registerTool: (_name: string, _config: unknown, cb: typeof handler) => { handler = cb; } };
    contractRegistrar(fake as never)("get_subscriber", {}, async () => { throw thrown; });
    return JSON.parse((await handler!()).content[0].text) as Record<string, unknown>;
  }

  it("carries auth_reason for authentication errors", async () => {
    const payload = await errorPayload(mapHttpStatusToError(403, REAUTH_DETAIL, "/api/v1/subscriber-stats"));
    expect(payload).toMatchObject({ code: "upstream_error", status: 403, auth_reason: "reauthentication_required" });
  });

  it("omits auth_reason for other errors", async () => {
    const payload = await errorPayload(mapHttpStatusToError(500, "boom", "/api"));
    expect(payload.status).toBe(500);
    expect(payload).not.toHaveProperty("auth_reason");
  });
});
