import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SubscriberService } from "../api/subscribers.js";
import { SubstackClient } from "../api/client.js";
import { ValidationError, SubstackAPIError } from "../utils/errors.js";
import { createServer } from "../server.js";

const email = "reader@example.org";
const evidence = { source: "booking:test-message-id", recorded_at: "2026-09-01T00:00:00Z" };
const row = { user_email_address: email, subscription_id: 42, subscription_interval: "free", is_subscribed: false };
const empty = { count: 0, subscribers: [], lastSync: "2026-09-01T00:00:00Z" };
const found = { count: 1, subscribers: [row] };

describe("subscriber management", () => {
  it("uses the exact-email filter and does not mistake free membership for unsubscribed", async () => {
    const request = vi.fn().mockResolvedValue(found);
    const result = await new SubscriberService(request).add(" Reader@Example.org ", true, false, evidence);
    expect(result.status).toBe("existing");
    expect(result.subscriber?.subscription_id).toBe(42);
    expect(result.subscriber).not.toHaveProperty("is_subscribed");
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ filters: { user_email_address_string_is: email }, limit: 2, offset: 0 });
  });

  it("defaults to dry run", async () => {
    const request = vi.fn().mockResolvedValue(empty);
    expect((await new SubscriberService(request).add(email, true)).status).toBe("dry_run");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sends the free/no-welcome contract and verifies membership", async () => {
    const request = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce({}).mockResolvedValueOnce(found);
    expect((await new SubscriberService(request).add(email, true, false, evidence)).status).toBe("verified");
    expect(request.mock.calls[1]).toEqual(["/api/v1/subscriber/add", { method: "POST", body: JSON.stringify({ email, subscription: false, sendEmail: false }) }]);
  });

  it("does not treat an empty acknowledgement as success or repeat an uncertain write", async () => {
    const request = vi.fn().mockResolvedValue(empty);
    request.mockResolvedValueOnce(empty).mockResolvedValueOnce({});
    const service = new SubscriberService(request);
    expect((await service.add(email, true, false, evidence)).status).toBe("unverified");
    expect((await service.add(email, true, false, evidence)).status).toBe("unverified");
    expect(request.mock.calls.filter(c => c[0].endsWith("/add"))).toHaveLength(1);
  });

  it("can reconcile a prior uncertain write without a second add", async () => {
    const request = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce({}).mockResolvedValueOnce(empty).mockResolvedValueOnce(found);
    const service = new SubscriberService(request);
    await service.add(email, true, false, evidence);
    expect((await service.add(email, true, false, evidence)).status).toBe("existing");
    expect(request.mock.calls.filter(c => c[0].endsWith("/add"))).toHaveLength(1);
  });

  it("respects Substack rejection without a suppression override", async () => {
    const request = vi.fn().mockResolvedValueOnce(empty).mockRejectedValueOnce(new ValidationError("/add", "No valid emails found. This could be because an email previously unsubscribed."));
    const result = await new SubscriberService(request).add(email, true, false, evidence);
    expect(result.status).toBe("blocked");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([new Error("network failure"), new SyntaxError("invalid JSON")])("retains unknown outcomes after a write failure", async error => {
    const request = vi.fn().mockResolvedValue(empty).mockResolvedValueOnce(empty).mockRejectedValueOnce(error);
    const service = new SubscriberService(request);
    expect((await service.add(email, true, false, evidence)).status).toBe("unverified");
    await service.add(email, true, false, evidence);
    expect(request.mock.calls.filter(c => c[0].endsWith("/add"))).toHaveLength(1);
  });

  it("reports verification failure separately from write acceptance", async () => {
    const request = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("read failed"));
    expect((await new SubscriberService(request).add(email, true, false, evidence)).status).toBe("unverified");
  });

  it.each([{}, { count: 0, subscribers: [row] }, { count: 1, subscribers: [] }, { count: 1, subscribers: [{ ...row, user_email_address: "different@example.org" }] }])("fails closed on malformed or ignored lookup filters", async page => {
    const request = vi.fn().mockResolvedValue(page);
    await expect(new SubscriberService(request).add(email, true, false, evidence)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], { error: "blocked" }])("does not call an unexpected add response verified", async reply => {
    const request = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(reply);
    expect((await new SubscriberService(request).add(email, true, false, evidence)).status).toBe("unverified");
  });

  it("requires valid consent and a single email before touching the API", async () => {
    const request = vi.fn();
    const service = new SubscriberService(request);
    await expect(service.add(email, true, false)).rejects.toThrow();
    await expect(service.add(email, true, false, { source: " ", recorded_at: "invalid" })).rejects.toThrow();
    await expect(service.add(email, false, false)).rejects.toThrow(/opt-in/);
    await expect(service.add("a@example.org,b@example.org", true, false, evidence)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks concurrent writes for one email but permits another email", async () => {
    let release!: (value: unknown) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(empty);
    const service = new SubscriberService(request);
    const first = service.add(email, true);
    expect((await service.add(email, true, false, evidence)).status).toBe("busy");
    expect((await service.add("other@example.org", true)).status).toBe("dry_run");
    release(empty);
    await first;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds pagination before an API call", async () => {
    const request = vi.fn().mockResolvedValue(empty);
    const service = new SubscriberService(request);
    for (const [offset, limit] of [[-1, 10], [0, 51], [0, 0], [0.5, 10]]) await expect(service.list(offset, limit)).rejects.toThrow();
    await service.list(50, 10);
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ filters: { order_by_desc_nulls_last: "subscription_created_at" }, offset: 50, limit: 10 });
  });

  it.each([401, 403, 429])("allows an explicit retry after a known %i rejection", async code => {
    const request = vi.fn().mockResolvedValueOnce(empty).mockRejectedValueOnce(new SubstackAPIError(code, "rejected", "/add")).mockResolvedValueOnce(empty).mockResolvedValueOnce({}).mockResolvedValueOnce(found);
    const service = new SubscriberService(request);
    expect((await service.add(email, true, false, evidence)).status).toBe("retryable");
    expect((await service.add(email, true, false, evidence)).status).toBe("verified");
    expect(request.mock.calls.filter(c => c[0].endsWith("/add"))).toHaveLength(2);
  });

  it("keeps blocked terminal without misreporting it as an unknown write", async () => {
    const request = vi.fn().mockResolvedValueOnce(empty).mockRejectedValueOnce(new ValidationError("/add", "No valid emails")).mockResolvedValue(empty);
    const service = new SubscriberService(request);
    expect((await service.add(email, true, false, evidence)).status).toBe("blocked");
    expect((await service.add(email, true, false, evidence)).status).toBe("blocked");
    expect(request.mock.calls.filter(c => c[0].endsWith("/add"))).toHaveLength(1);
  });

  it("does not assume a 500 proves the write was rolled back", async () => {
    const request = vi.fn().mockResolvedValueOnce(empty).mockRejectedValueOnce(new SubstackAPIError(500, "server failed", "/add")).mockResolvedValue(empty);
    const service = new SubscriberService(request);
    expect((await service.add(email, true, false, evidence)).status).toBe("unverified");
    await service.add(email, true, false, evidence);
    expect(request.mock.calls.filter(c => c[0].endsWith("/add"))).toHaveLength(1);
  });
});

describe("subscriber tools over MCP", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("routes to the selected publication and rejects missing consent/publication without requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => empty });
    vi.stubGlobal("fetch", fetchMock);
    const server = createServer(["one", "two"].map(key => ({ key, label: key, client: new SubstackClient(`https://${key}.substack.com`, "token", "1") })));
    const client = new Client({ name: "test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const result = await client.callTool({ name: "add_free_subscriber", arguments: { email, consent_confirmed: true, publication: "two" } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse((result.content as Array<{text: string}>)[0].text).status).toBe("dry_run");
      expect(fetchMock.mock.calls[0][0]).toBe("https://two.substack.com/api/v1/subscriber-stats");
      const missing = await client.callTool({ name: "add_free_subscriber", arguments: { email, publication: "two" } });
      expect(missing.isError).toBe(true);
      const wrongPub = await client.callTool({ name: "get_subscriber", arguments: { email } });
      expect(wrongPub.isError).toBe(true);
      const missingEvidence = await client.callTool({ name: "add_free_subscriber", arguments: { email, consent_confirmed: true, dry_run: false, publication: "two" } });
      expect(missingEvidence.isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fetchMock.mockResolvedValue({ ok: true, json: async () => found });
      const audited = await client.callTool({ name: "add_free_subscriber", arguments: { email, consent_confirmed: true, consent_evidence: evidence, dry_run: false, publication: "one" } });
      expect(JSON.parse((audited.content as Array<{text: string}>)[0].text)).toMatchObject({ status: "existing", publication: "one", consent_evidence: evidence });
      const tools = (await client.listTools()).tools;
      expect(tools.find(t => t.name === "add_free_subscriber")?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true, destructiveHint: false });
    } finally { await client.close(); await server.close(); }
  });
});
