import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { SubstackClient } from "./api/client.js";
import { doctor } from "./doctor.js";
import { resolveSelectedPublications, type PublicationCredentials } from "./auth/resolve-publications.js";
import packageMetadata from "../package.json" with { type: "json" };

const usage = "Usage: substack-mcp compatibility report [--json] [--check-auth] [--publication key]\nPrint a shareable, allowlisted JSON diagnostic report. Offline by default: checks configuration and MCP SDK initialization/catalog in memory. --check-auth adds one bounded authenticated GET for the explicitly selected publication. No writes, uploads, browser launch, submission or telemetry. A local SDK probe does not verify your GUI client, browser login, account identity, tier or write permission. Review before sharing.";
const authCodes = new Set(["not_checked", "authenticated_read_succeeded", "unexpected_response", "unauthorized_or_blocked", "rate_limited", "timeout", "redirect_rejected", "unexpected_html", "malformed_json", "response_too_large", "request_cancelled", "upstream_error", "network_or_response_error"]);
type Dependencies = {
  resolve?: () => Promise<PublicationCredentials[]>;
  now?: () => Date;
  io?: { out: (text: string) => void; error: (text: string) => void };
};

export async function runCompatibility(args: string[], deps: Dependencies = {}): Promise<number> {
  const io = deps.io ?? { out: (text: string) => console.log(text), error: (text: string) => console.error(text) };
  if ((args.length === 1 && ["--help", "-h"].includes(args[0])) || (args.length === 2 && args[0] === "report" && ["--help", "-h"].includes(args[1]))) {
    io.out(usage); return 0;
  }
  let checkAuth = false, publication: string | undefined;
  const seen = new Set<string>();
  try {
    if (args[0] !== "report") throw new Error();
    for (let i = 1; i < args.length; i++) {
      const flag = args[i];
      if (seen.has(flag)) throw new Error();
      seen.add(flag);
      if (flag === "--check-auth") checkAuth = true;
      else if (flag === "--json") continue;
      else if (flag === "--publication") {
        publication = args[++i];
        if (!publication || publication.startsWith("--") || publication.length > 128 || /[\x00-\x1f\x7f]/.test(publication)) throw new Error();
      } else throw new Error();
    }
  } catch { io.error(usage); return 2; }

  // The report is an allowlist built here, never a redacted copy of raw doctor
  // output. In particular, no origin, profile key, label, user ID or error text.
  const report = {
    format_version: 1, command: "compatibility report", generated_at: (deps.now?.() ?? new Date()).toISOString(),
    server: { name: packageMetadata.name, version: packageMetadata.version },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    ok: false, code: "invalid_configuration",
    selection: { configured_publications: 0, explicit: publication !== undefined },
    configuration: { status: "not_checked", credential_source: "unknown" },
    authentication: { status: "not_checked", user_identity: "not_verified", write_permissions: "not_checked" },
    protocol: { client: "MCP TypeScript SDK", transport: "in_memory", scope: "selected_publication_only", initialize: "not_run", tools_list: "not_run", tool_count: 0, annotated_tool_count: 0, output_schema_count: 0 },
    manual_observations: { client_name: "unknown", client_version: "unknown", client_transport: "unknown", client_workflows: "untested", browser_login: "untested", account_tier: "unknown", publication_role: "unknown" },
    limitations: "Local configuration/catalog observations only; authentication is observed only with --check-auth. Does not establish GUI/stdio/HTTP client compatibility, browser login, account identity, tier, role or write permissions. No report is submitted. Review before sharing.",
  };
  const finish = () => { io.out(JSON.stringify(report)); return report.ok ? 0 : 1; };
  let pubs: PublicationCredentials[];
  try { pubs = await (deps.resolve ?? resolveSelectedPublications)(); }
  catch { return finish(); }
  report.selection.configured_publications = pubs.length;
  if (pubs.length > 1 && publication === undefined) { report.code = "publication_selection_required"; return finish(); }
  const selected = publication === undefined ? pubs[0] : pubs.find(p => p.key === publication);
  if (!selected) { report.code = publication === undefined ? "invalid_configuration" : "unknown_publication"; return finish(); }
  if (["env", "stored", "mixed", "none"].includes(selected.source)) report.configuration.credential_source = selected.source;
  let substack: SubstackClient;
  try {
    if (selected.missing.length) throw new Error();
    substack = new SubstackClient(selected.publicationUrl, selected.sessionToken, selected.userId);
    report.configuration.status = "valid";
  } catch { report.configuration.status = "invalid"; return finish(); }

  const client = new Client({ name: "substack-compatibility-report", version: packageMetadata.version });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    server = createServer([{ key: selected.key, label: selected.label, client: substack }]);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct, { timeout: 5000 }), server.connect(st)]);
    report.protocol.initialize = "pass";
    const { tools } = await client.listTools({}, { timeout: 5000 });
    report.protocol.tools_list = "pass";
    report.protocol.tool_count = tools.length;
    report.protocol.annotated_tool_count = tools.filter(t => typeof t.annotations?.readOnlyHint === "boolean").length;
    report.protocol.output_schema_count = tools.filter(t => t.outputSchema !== undefined).length;
  } catch {
    if (report.protocol.initialize === "pass") report.protocol.tools_list = "fail";
    else report.protocol.initialize = "fail";
    report.code = "local_protocol_failed"; return finish();
  } finally {
    await client.close().catch(() => {});
    await server?.close().catch(() => {});
  }
  if (checkAuth) {
    try {
      // Selection already resolved and validated these credentials. An unrelated
      // vault availability probe must not turn a successful auth read into failure.
      const result = await doctor(true, () => [selected], async () => true);
      const auth = result.publications[0]?.authentication;
      report.authentication.status = auth && authCodes.has(auth) ? auth : "not_verified";
      if (!result.ok) { report.code = "authenticated_read_failed"; return finish(); }
    } catch { report.authentication.status = "not_verified"; report.code = "authenticated_read_failed"; return finish(); }
  }
  report.ok = true; report.code = checkAuth ? "authenticated_read_observed" : "offline_report";
  return finish();
}
