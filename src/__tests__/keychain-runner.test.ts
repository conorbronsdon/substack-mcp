import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import { runKeychainCommand } from "../auth/keychain.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("delivers the secret on stdin, caps time at ten seconds, and hides process output", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(),
  });
  child.kill.mockImplementation(() => { child.emit("close", null); return true; });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  let written = "";
  child.stdin.on("data", chunk => { written += chunk.toString(); });
  const promise = runKeychainCommand("secret-tool", ["store", "service", "substack-mcp"], "example-secret\n");
  const rejected = expect(promise).rejects.toMatchObject({ code: "keychain_unavailable" });
  expect(spawn).toHaveBeenCalledWith("secret-tool", ["store", "service", "substack-mcp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  expect(written).toBe("example-secret\n");
  expect(JSON.stringify(vi.mocked(spawn).mock.calls[0][1])).not.toContain("example-secret");
  await vi.advanceTimersByTimeAsync(10_001);
  await rejected;
  expect(child.kill).toHaveBeenCalledOnce();
});
