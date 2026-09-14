import { createServer as createHttpServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerOptions } from "../server.js";
import { SubstackClient } from "../api/client.js";
import { createGuardedLookup, fetchRemoteImage, isPublicAddress, sniffImageType, type RemoteImageOptions } from "../utils/remote-image.js";
import { RemoteImageError } from "../utils/remote-image-errors.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(24, 1)]);

describe("remote image address policy", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fe80::1%eth0", "fc00::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254",
    "64:ff9b::7f00:1", "2002:7f00:1::1", "2001::1", "2001:db8::1", "ff02::1", "not-an-ip", "",
  ])("rejects non-public address %s", address => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"])("allows public address %s", address => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("rejects a host when any resolved address is private, and honors family and all", async () => {
    const resolve = (addresses: { address: string; family: number }[]) => (_h: string, _o: unknown, cb: (e: null, a: typeof addresses) => void) => cb(null, addresses);
    const run = (addresses: { address: string; family: number }[], options: Record<string, unknown>) => new Promise<{ error: unknown; address: unknown; family: unknown }>(done =>
      createGuardedLookup(resolve(addresses))("img.example", options as never, (error, address, family) => done({ error, address, family })));
    const mixed = await run([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }], {});
    expect(mixed.error).toBeInstanceOf(RemoteImageError);
    expect((mixed.error as RemoteImageError).code).toBe("blocked_destination");
    const publicHosts = [{ address: "2606:4700:4700::1111", family: 6 }, { address: "93.184.216.34", family: 4 }];
    expect(await run(publicHosts, {})).toEqual({ error: null, address: "2606:4700:4700::1111", family: 6 });
    expect(await run(publicHosts, { family: 4 })).toEqual({ error: null, address: "93.184.216.34", family: 4 });
    expect((await run(publicHosts, { all: true })).address).toEqual(publicHosts);
    expect(((await run([], {})).error as RemoteImageError).code).toBe("dns_failed");
  });

  it("identifies only allowed raster signatures", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))).toBe("image/webp");
    expect(sniffImageType(Buffer.from("\0\0\0\x1cftypavif", "latin1"))).toBe("image/avif");
    expect(sniffImageType(Buffer.from("\0\0\0\x18ftypheic", "latin1"))).toBeNull();
    expect(sniffImageType(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"))).toBeNull();
  });
});

describe("fetchRemoteImage", () => {
  let server: Server, base: string;
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const routes = new Map<string, (res: ServerResponse) => void>();
  beforeAll(async () => {
    server = createHttpServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      const route = routes.get(req.url ?? "");
      if (route) route(res); else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  afterEach(() => { seen.length = 0; routes.clear(); });

  // Loopback is allowed ONLY for this local fixture; the production policy is covered above.
  const local: RemoteImageOptions = { allowHttp: true, allowAddress: address => address === "127.0.0.1" || isPublicAddress(address) };
  const code = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error instanceof RemoteImageError ? error.code : `unexpected:${String(error)}`; } return "resolved"; };

  it("downloads a matching image without cookies or credentials", async () => {
    routes.set("/a.png", res => { res.writeHead(200, { "content-type": "image/png; charset=binary", "content-length": PNG.length }); res.end(PNG); });
    const image = await fetchRemoteImage(`${base}/a.png`, local);
    expect(image).toEqual({ data_uri: `data:image/png;base64,${PNG.toString("base64")}`, mime: "image/png", bytes: PNG.length, final_url: `${base}/a.png`, redirects: 0 });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].headers).filter(name => ["cookie", "authorization", "referer"].includes(name))).toEqual([]);
  });

  it.each([
    ["http scheme", "http://example.com/a.png"],
    ["credentials", "https://user:pass@example.com/a.png"],
    ["non-default port", "https://example.com:8443/a.png"],
    ["relative", "/a.png"],
    ["data URI", "data:image/png;base64,AAAA"],
  ])("rejects %s with the production policy", async (_name, url) => {
    expect(await code(fetchRemoteImage(url))).toBe("invalid_url");
  });

  it.each(["https://127.0.0.1/a.png", "https://[::1]/a.png", "https://169.254.169.254/latest/meta-data", "https://[::ffff:169.254.169.254]/", "https://2130706433/a.png", "https://0x7f.1/a.png"])(
    "rejects literal private destinations before connecting: %s", async url => {
      expect(await code(fetchRemoteImage(url))).toBe("blocked_destination");
    });

  it("rejects hostnames that resolve to private addresses in production", async () => {
    const resolve = (_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: "169.254.169.254", family: 4 }]);
    expect(await code(fetchRemoteImage("https://metadata.example/latest", { resolve: resolve as never }))).toBe("blocked_destination");
  });

  it("validates every redirect, including redirects to private literals and hostnames", async () => {
    routes.set("/to-literal", res => { res.writeHead(302, { location: "http://10.0.0.1/a.png" }); res.end(); });
    expect(await code(fetchRemoteImage(`${base}/to-literal`, local))).toBe("blocked_destination");
    routes.set("/to-https-literal", res => { res.writeHead(307, { location: "https://[fd00:ec2::254]/" }); res.end(); });
    expect(await code(fetchRemoteImage(`${base}/to-https-literal`, local))).toBe("blocked_destination");
    const port = (server.address() as AddressInfo).port;
    routes.set("/to-host", res => { res.writeHead(301, { location: `http://internal.example:${port}/a.png` }); res.end(); });
    const resolve = (_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: "10.0.0.8", family: 4 }]);
    expect(await code(fetchRemoteImage(`${base}/to-host`, { ...local, resolve: resolve as never }))).toBe("blocked_destination");
    expect(seen.map(entry => entry.url)).toEqual(["/to-literal", "/to-https-literal", "/to-host"]);
  });

  it("checks DNS at each connection, so a rebinding host is refused on its second connection", async () => {
    const port = (server.address() as AddressInfo).port;
    routes.set("/first", res => { res.writeHead(302, { location: `http://rebind.example:${port}/second` }); res.end(); });
    routes.set("/second", res => { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); });
    let calls = 0;
    const resolve = (_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: ++calls === 1 ? "127.0.0.1" : "10.0.0.9", family: 4 }]);
    expect(await code(fetchRemoteImage(`http://rebind.example:${port}/first`, { ...local, resolve: resolve as never }))).toBe("blocked_destination");
    expect(calls).toBe(2);
    expect(seen.map(entry => entry.url)).toEqual(["/first"]);
  });

  it("follows a bounded number of redirects", async () => {
    routes.set("/r0", res => { res.writeHead(302, { location: "/r1" }); res.end(); });
    routes.set("/r1", res => { res.writeHead(302, { location: "/r2" }); res.end(); });
    routes.set("/r2", res => { res.writeHead(302, { location: "/r3" }); res.end(); });
    routes.set("/r3", res => { res.writeHead(200, { "content-type": "image/gif" }); res.end(GIF); });
    expect((await fetchRemoteImage(`${base}/r0`, local)).redirects).toBe(3);
    routes.set("/r3", res => { res.writeHead(302, { location: "/r4" }); res.end(); });
    expect(await code(fetchRemoteImage(`${base}/r0`, local))).toBe("too_many_redirects");
    routes.set("/no-location", res => { res.writeHead(302); res.end(); });
    expect(await code(fetchRemoteImage(`${base}/no-location`, local))).toBe("http_status");
    expect(await code(fetchRemoteImage(`${base}/missing`, local))).toBe("http_status");
  });

  it("enforces the byte cap for declared, chunked and dishonest lengths", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2048)]);
    routes.set("/declared", res => { res.writeHead(200, { "content-type": "image/png", "content-length": big.length }); res.end(big); });
    routes.set("/chunked", res => { res.writeHead(200, { "content-type": "image/png" }); res.write(big.subarray(0, 1000)); setTimeout(() => res.end(big.subarray(1000)), 10); });
    routes.set("/dishonest", res => {
      res.writeHead(200, { "content-type": "image/png", "content-length": 40 });
      res.flushHeaders();
      // Writes past the declared length directly to the socket, as a hostile server could.
      res.socket?.write(big);
      res.socket?.end();
    });
    const small = { ...local, maxBytes: 1024 };
    expect(await code(fetchRemoteImage(`${base}/declared`, small))).toBe("too_large");
    expect(await code(fetchRemoteImage(`${base}/chunked`, small))).toBe("too_large");
    // Node's HTTP parser rejects bytes beyond the declared length, so the download fails rather than returning a truncated or oversized image.
    expect(await code(fetchRemoteImage(`${base}/dishonest`, small))).toBe("network");
  });

  it("requires the declared type to match allowed image bytes", async () => {
    routes.set("/spoof", res => { res.writeHead(200, { "content-type": "image/png" }); res.end(GIF); });
    routes.set("/undeclared", res => { res.writeHead(200); res.end(PNG); });
    routes.set("/octet", res => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(PNG); });
    routes.set("/svg", res => { res.writeHead(200, { "content-type": "image/svg+xml" }); res.end("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"); });
    routes.set("/html", res => { res.writeHead(200, { "content-type": "image/png" }); res.end("<html></html>"); });
    routes.set("/gzip", res => { res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" }); res.end(PNG); });
    routes.set("/jpg-alias", res => { res.writeHead(200, { "content-type": "image/jpg" }); res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])); });
    expect(await code(fetchRemoteImage(`${base}/spoof`, local))).toBe("type_mismatch");
    expect(await code(fetchRemoteImage(`${base}/undeclared`, local))).toBe("type_mismatch");
    expect(await code(fetchRemoteImage(`${base}/octet`, local))).toBe("type_mismatch");
    expect(await code(fetchRemoteImage(`${base}/svg`, local))).toBe("unsupported_type");
    expect(await code(fetchRemoteImage(`${base}/html`, local))).toBe("unsupported_type");
    expect(await code(fetchRemoteImage(`${base}/gzip`, local))).toBe("unsupported_encoding");
    expect((await fetchRemoteImage(`${base}/jpg-alias`, local)).mime).toBe("image/jpeg");
  });

  it("enforces one total deadline across a slow response", async () => {
    routes.set("/slow", res => { res.writeHead(200, { "content-type": "image/png" }); res.write(PNG.subarray(0, 4)); });
    const started = Date.now();
    expect(await code(fetchRemoteImage(`${base}/slow`, { ...local, deadlineMs: 150 }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

afterEach(() => vi.restoreAllMocks());

async function withMcp(options: ServerOptions, run: (mcp: Client, api: SubstackClient) => Promise<void>) {
  const api = new SubstackClient("https://example.substack.com", "test-only", "1");
  const server = createServer([{ key: "example", label: "Example", client: api }], options);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "remote-image-test", version: "1" });
  await Promise.all([mcp.connect(ct), server.connect(st)]);
  try { await run(mcp, api); } finally { await mcp.close(); await server.close(); }
}
const body = (result: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((result.content as { text: string }[])[0].text);

describe("upload_image with image_url through MCP", () => {
  it("uploads the downloaded data URI and returns the CDN URL", async () => {
    const fetchRemote = vi.fn(async () => ({ data_uri: "data:image/png;base64,AAAA", mime: "image/png", bytes: 3, final_url: "https://img.example/a.png", redirects: 0 }));
    await withMcp({ fetchRemoteImage: fetchRemote }, async (mcp, api) => {
      const upload = vi.spyOn(api, "uploadImage").mockResolvedValue({ url: "https://substackcdn.com/image/a.png" } as never);
      const result = await mcp.callTool({ name: "upload_image", arguments: { image_url: "https://img.example/a.png" } });
      expect(result.isError).toBeFalsy();
      expect(body(result)).toEqual({ image_url: "https://substackcdn.com/image/a.png" });
      expect(fetchRemote).toHaveBeenCalledWith("https://img.example/a.png");
      expect(upload).toHaveBeenCalledWith("data:image/png;base64,AAAA");
    });
  });

  it("returns a typed error and uploads nothing when the download is refused", async () => {
    const fetchRemote = vi.fn(async () => { throw new RemoteImageError("blocked_destination", "Refused."); });
    await withMcp({ fetchRemoteImage: fetchRemote }, async (mcp, api) => {
      const upload = vi.spyOn(api, "uploadImage");
      const result = await mcp.callTool({ name: "upload_image", arguments: { image_url: "https://internal.example/a.png" } });
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ code: "blocked_destination", message: "Refused. Nothing was uploaded.", upload_attempts: 0 });
      expect(upload).not.toHaveBeenCalled();
    });
  });

  it("reports remote images as unavailable when the deployment provides no fetcher", async () => {
    await withMcp({}, async (mcp, api) => {
      const upload = vi.spyOn(api, "uploadImage");
      const result = await mcp.callTool({ name: "upload_image", arguments: { image_url: "https://img.example/a.png" } });
      expect(result.isError).toBe(true);
      expect(body(result).code).toBe("remote_image_unavailable");
      expect(upload).not.toHaveBeenCalled();
    });
  });

  it("requires exactly one image source and keeps base64 uploads unchanged", async () => {
    const fetchRemote = vi.fn();
    await withMcp({ fetchRemoteImage: fetchRemote }, async (mcp, api) => {
      const upload = vi.spyOn(api, "uploadImage").mockResolvedValue({ url: "https://substackcdn.com/image/b.png" } as never);
      for (const args of [{}, { image_url: "https://img.example/a.png", image_base64: "data:image/png;base64,AAAA" }, { image_url: "https://img.example/a.png", image_path: "/tmp/a.png" }]) {
        const result = await mcp.callTool({ name: "upload_image", arguments: args });
        // Existing contract: argument conflicts surface as a generic tool failure before any fetch or upload.
        expect(result.isError).toBe(true);
        expect(body(result).code).toBe("tool_execution_failed");
      }
      expect(fetchRemote).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
      const result = await mcp.callTool({ name: "upload_image", arguments: { image_base64: "data:image/png;base64,AAAA" } });
      expect(body(result)).toEqual({ image_url: "https://substackcdn.com/image/b.png" });
      expect(fetchRemote).not.toHaveBeenCalled();
    });
  });

  it("keeps the public-CDN side effect in the tool description", async () => {
    await withMcp({}, async mcp => {
      const tool = (await mcp.listTools()).tools.find(t => t.name === "upload_image")!;
      expect(tool.description).toContain("publicly fetchable");
      expect(tool.inputSchema.properties).toHaveProperty("image_url");
    });
  });
});
