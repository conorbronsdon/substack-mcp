import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type PublicationConfig } from "../server.js";
import { SubstackClient } from "../api/client.js";

/**
 * Multi-publication routing and schema behavior. Separate from server.ts's
 * #28 pagination-clamp suite — different concern, same in-memory-transport
 * pattern.
 */
describe("multi-publication support", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    const body = { sections: [] };
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function connect(publications: PublicationConfig[]) {
    const server = createServer(publications);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return client;
  }

  it("adds no `publication` field to any tool when only one publication is configured", async () => {
    const client = await connect([
      { key: "default", label: "Default", client: new SubstackClient("https://a.substack.com", "tok", "1") },
    ]);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_sections");
    const schema = tool!.inputSchema as any;
    expect(schema.properties?.publication).toBeUndefined();
    expect(schema.required ?? []).not.toContain("publication");
  });

  it("requires `publication` (enum of configured keys) once 2+ publications are configured", async () => {
    const client = await connect([
      { key: "kevin-muldoon", label: "Kevin Muldoon", client: new SubstackClient("https://a.substack.com", "tok", "1") },
      { key: "sapere", label: "Sapere", client: new SubstackClient("https://b.substack.com", "tok", "2") },
    ]);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_sections");
    const schema = tool!.inputSchema as any;
    expect(schema.required).toContain("publication");
    expect(schema.properties.publication.enum?.sort()).toEqual(["kevin-muldoon", "sapere"]);
  });

  it("rejects an unconfigured publication value before any network call", async () => {
    const fetchMock = stubFetch();
    const client = await connect([
      { key: "kevin-muldoon", label: "Kevin Muldoon", client: new SubstackClient("https://a.substack.com", "tok", "1") },
      { key: "sapere", label: "Sapere", client: new SubstackClient("https://b.substack.com", "tok", "2") },
    ]);

    const result = await client.callTool({
      name: "get_sections",
      arguments: { publication: "not-a-real-publication" },
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes a call to the client matching the given publication key", async () => {
    const fetchMock = stubFetch();
    const client = await connect([
      { key: "kevin-muldoon", label: "Kevin Muldoon", client: new SubstackClient("https://a.substack.com", "tok", "1") },
      { key: "sapere", label: "Sapere", client: new SubstackClient("https://b.substack.com", "tok", "2") },
    ]);

    const result = await client.callTool({
      name: "get_sections",
      arguments: { publication: "sapere" },
    });

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("b.substack.com");
  });
});
