import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getPublication } from "../api/publication.js";
import { SubstackClient } from "../api/client.js";
import { createServer } from "../server.js";

afterEach(() => vi.unstubAllGlobals());
const publication = { id: 42, name: "Sample", subdomain: "sample" };

describe("publication context", () => {
  it("projects only known fields and distinguishes absent, null and false", async () => {
    const read = vi.fn(async () => ({ ...publication, hero_text: null, paused: false, private_payload: "excluded" }));
    const result = await getPublication("https://sample.substack.com", read);
    expect(read).toHaveBeenCalledExactlyOnceWith("/api/v1/publication");
    expect(result.data).toEqual({ ...publication, hero_text: null, paused: false });
    expect(result.fields_not_returned_by_api).toContain("language");
    expect(result.fields_not_returned_by_api).not.toContain("hero_text");
    expect(result.fields_not_returned_by_api).not.toContain("paused");
    expect(JSON.stringify(result)).not.toContain("excluded");
    expect(result.identity_scope).toContain("role are not verified");
  });
  it("accepts an exact custom domain", async () => {
    expect((await getPublication("https://news.example.com", async () => ({ ...publication, custom_domain: "news.example.com" }))).data.id).toBe(42);
  });
  it.each([
    ["https://sample.substack.com.", null],
    ["https://news.example.com", "NEWS.EXAMPLE.COM."],
    ["https://bücher.example", "bücher.example"],
  ])("normalizes equivalent hostname representations for %s", async (url, custom_domain) => {
    expect((await getPublication(url, async () => ({ ...publication, custom_domain }))).data.id).toBe(42);
  });
  it.each(["https://ample.substack.com", "https://sample.substack.com.attacker.example", "https://unrelated.example"])("rejects wrong publication %s", async url => {
    await expect(getPublication(url, async () => publication)).rejects.toThrow(/does not match/);
  });
  it.each([{}, null, { ...publication, id: -1 }, { ...publication, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...publication, name: "x".repeat(1001) }, { ...publication, paused: "false" },
    { ...publication, custom_domain: "https://example.com" }, { ...publication, custom_domain: "news..example.com" },
    { ...publication, custom_domain: "news.example.com/path" }])("fails closed on malformed context", async response => {
    await expect(getPublication("https://sample.substack.com", async () => response)).rejects.toThrow(/cannot be verified/);
  });
  it("propagates read failures without inventing context", async () => {
    await expect(getPublication("https://sample.substack.com", async () => { throw new Error("read failed"); })).rejects.toThrow("read failed");
  });
  it("exposes structured output and routes only the selected publication without writes", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ ...publication, subdomain: "b" })));
    vi.stubGlobal("fetch", fetchMock);
    const server = createServer(["a", "b"].map(key => ({ key, label: key, client: new SubstackClient(`https://${key}.substack.com`, "fixture", "1") })));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const tool = (await client.listTools()).tools.find(t => t.name === "get_publication")!;
      expect(tool.inputSchema.required).toContain("publication");
      expect(tool.outputSchema?.required).toContain("data");
      expect(tool.annotations?.readOnlyHint).toBe(true);
      for (const args of [{}, { publication: "unknown" }]) {
        expect((await client.callTool({ name: "get_publication", arguments: args })).isError).toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      const result = await client.callTool({ name: "get_publication", arguments: { publication: "b" } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ publication: "b", data: { id: 42, subdomain: "b" } });
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(result.structuredContent);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://b.substack.com/api/v1/publication");
      expect(fetchMock.mock.calls[0][1]?.method ?? "GET").toBe("GET");
      expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Referer: "https://b.substack.com/publish/settings" });
    } finally { await client.close(); await server.close(); }
  });
});
