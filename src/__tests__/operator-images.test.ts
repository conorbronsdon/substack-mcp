import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runOperator } from "../operator-cli.js";
import { convertMarkdown } from "../utils/markdown-to-prosemirror.js";
import { RemoteImageError } from "../utils/remote-image-errors.js";

const remote = vi.hoisted(() => ({ fetchRemoteImage: vi.fn() }));
vi.mock("../utils/remote-image.js", () => remote);

const credentials = { key: "example", label: "Example", publicationUrl: "https://example.substack.com", sessionToken: "example-private-token", userId: "1", source: "env" as const, missing: [] };
const second = { ...credentials, key: "second", publicationUrl: "https://second.substack.com" };
const cdn = "https://substack-post-media.s3.amazonaws.com/public/images/example_1200x630.png";
const io = () => ({ out: vi.fn(), error: vi.fn() });
const dir = mkdtempSync(join(tmpdir(), "substack-operator-images-"));
const png = join(dir, "pic.png");
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); remote.fetchRemoteImage.mockReset(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("operator images upload", () => {
  it("uploads a local file once and prints its public URL and a Markdown image line", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ url: cdn }));
    vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["images", "upload", relative(process.cwd(), png)], () => [credentials], output)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(String(url)).href).toBe("https://example.substack.com/api/v1/image");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ image: "data:image/png;base64,iVBORw==" });
    expect(remote.fetchRemoteImage).not.toHaveBeenCalled(); expect(output.error).not.toHaveBeenCalled();
    const result = JSON.parse(output.out.mock.calls[0][0]);
    expect(result).toEqual({ format_version: 1, ok: true, command: "images upload", publication: "example",
      data: { image_url: cdn, markdown: `![](${cdn})`, visibility: "public_unlisted" } });
    expect(output.out.mock.calls[0][0]).not.toContain(credentials.sessionToken);
  });

  it("prints a Markdown line that drafts create converts to a Substack image", () => {
    const { document: doc, unsupported_nodes } = convertMarkdown(`![](${cdn})`);
    expect(unsupported_nodes).toEqual([]);
    expect(doc.content[0]).toMatchObject({ type: "captionedImage", content: [{ type: "image2", attrs: { src: cdn } }] });
  });

  it("downloads --url through the guarded fetcher, then uploads to the selected publication", async () => {
    remote.fetchRemoteImage.mockResolvedValue({ data_uri: "data:image/png;base64,AA==", mime: "image/png", bytes: 1, final_url: "https://images.example.com/a.png", redirects: 0 });
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ url: cdn }));
    vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["images", "upload", "--url", "https://images.example.com/a.png", "--publication", "second"], () => [credentials, second], output)).toBe(0);
    expect(remote.fetchRemoteImage).toHaveBeenCalledExactlyOnceWith("https://images.example.com/a.png");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetch.mock.calls[0][0])).origin).toBe("https://second.substack.com");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ image: "data:image/png;base64,AA==" });
    expect(JSON.parse(output.out.mock.calls[0][0])).toMatchObject({ ok: true, publication: "second", data: { image_url: cdn } });
  });

  it("reports a refused remote image as not attempted without uploading or echoing the fetcher message", async () => {
    remote.fetchRemoteImage.mockRejectedValue(new RemoteImageError("blocked_destination", "private-detail-marker"));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["images", "upload", "--url", "https://images.example.com/a.png"], () => [credentials], output)).toBe(1);
    expect(fetch).not.toHaveBeenCalled(); expect(output.out).not.toHaveBeenCalled();
    const line = output.error.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toMatchObject({ format_version: 1, ok: false, command: "images upload", code: "upload_not_attempted", upstream_code: "blocked_destination", upload_attempts: 0 });
    expect(line).not.toContain("private-detail-marker");
  });

  it.each([["missing.png"], ["notes.txt"]])("reports an unreadable local image as not attempted: %s", async name => {
    if (name === "notes.txt") writeFileSync(join(dir, name), "text");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["images", "upload", join(dir, name)], () => [credentials], output)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ code: "upload_not_attempted", upstream_code: "local_image_unreadable", upload_attempts: 0 });
  });

  it("reports an ambiguous upload failure as unverified without retrying or printing upstream text", async () => {
    const fetch = vi.fn(async () => new Response("private-body-marker", { status: 500 })); vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["images", "upload", png], () => [credentials], output)).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1); expect(output.out).not.toHaveBeenCalled();
    const line = output.error.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toMatchObject({ format_version: 1, ok: false, command: "images upload", code: "upload_unverified", category: "upstream_unavailable", status: 500 });
    expect(JSON.parse(line).message).toContain("publicly fetchable");
    expect(line).not.toContain("private-body-marker"); expect(line).not.toContain(credentials.sessionToken);
  });

  it("rejects an upload response without a valid URL as unverified", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ url: "not a url" })));
    const output = io();
    expect(await runOperator(["images", "upload", png], () => [credentials], output)).toBe(1);
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ code: "upload_unverified", category: "response_invalid" });
  });

  it.each(["http://example.com/image.png", "https://user:password@example.com/image.png"])("reports an unusable uploaded URL as unverified: %s", async url => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ url })));
    const output = io();
    expect(await runOperator(["images", "upload", png], () => [credentials], output)).toBe(1);
    expect(output.out).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ code: "upload_unverified", category: "response_invalid" });
  });

  it("encodes URL parentheses so the Markdown round-trips into a draft image", async () => {
    const url = "https://example.com/image(1).png";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ url })));
    const output = io();
    expect(await runOperator(["images", "upload", png], () => [credentials], output)).toBe(0);
    const result = JSON.parse(output.out.mock.calls[0][0]);
    const converted = convertMarkdown(result.data.markdown);
    expect(converted.unsupported_nodes).toEqual([]);
    expect(converted.document.content[0]).toMatchObject({ type: "captionedImage", content: [{ type: "image2", attrs: { src: "https://example.com/image%281%29.png" } }] });
  });

  it.each(["https://example.com/image.png?x=1&amp;y=2", "https://example.com/image.png?x=1&y=2", "https://example.com/image.png?q=a\\*b"])("preserves URL query bytes in generated Markdown: %s", async url => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ url })));
    const output = io();
    expect(await runOperator(["images", "upload", png], () => [credentials], output)).toBe(0);
    const result = JSON.parse(output.out.mock.calls[0][0]);
    const converted = convertMarkdown(result.data.markdown);
    expect(converted.unsupported_nodes).toEqual([]);
    expect(converted.document.content[0]).toMatchObject({ type: "captionedImage", content: [{ type: "image2", attrs: { src: url } }] });
  });

  it("reports configuration failures as not attempted", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["images", "upload", png], () => { throw new Error("example-private-token"); }, output)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    const line = output.error.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toMatchObject({ code: "upload_not_attempted", category: "configuration", upload_attempts: 0 });
    expect(line).not.toContain("example-private-token");
  });

  it("requires an explicit selector with multiple publications", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const output = io();
    expect(await runOperator(["images", "upload", png], () => [credentials, second], output)).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ code: "publication_required", command: "images upload" });
  });

  it.each([
    [["images", "upload"]], [["images", "upload", "--publication", "example"]], [["images", "upload", "a.png", "--url", "https://images.example.com/a.png"]],
    [["images", "upload", "--url", "http://images.example.com/a.png"]], [["images", "upload", "--url", "not a url"]], [["images", "upload", "--url"]],
    [["images", "upload", "--url", "https://a.example.com/a.png", "--url", "https://b.example.com/b.png"]], [["images", "upload", "a.png", "b.png"]],
    [["images", "upload", "a.png", "--title", "T"]], [["images", "delete", "a.png"]],
  ])("rejects invalid arguments without resolving credentials: %j", async args => {
    const output = io(), load = vi.fn();
    expect(await runOperator(args, load, output)).toBe(2);
    expect(load).not.toHaveBeenCalled(); expect(output.out).not.toHaveBeenCalled();
    expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({ format_version: 1, ok: false, code: "invalid_arguments" });
  });

  it.each([[["images", "--help"]], [["images", "upload", "--help"]]])("shows help offline: %j", async args => {
    const output = io(), load = vi.fn();
    expect(await runOperator(args, load, output)).toBe(0);
    expect(load).not.toHaveBeenCalled();
    expect(output.out.mock.calls[0][0]).toContain("images upload <image-file>");
    expect(output.out.mock.calls[0][0]).toContain("publicly fetchable");
    expect(output.out.mock.calls[0][0]).toContain("file contents are not inspected");
  });
});
