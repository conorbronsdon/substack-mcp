import { resolvePublications } from "./auth/resolve-publications.js";
import { isAbortError } from "./utils/errors.js";

export async function doctor(checkAuth = false, resolve = resolvePublications) {
  let publications: ReturnType<typeof resolvePublications>;
  try { publications = resolve(); }
  catch { return { ok: false, code: "invalid_configuration", publications: [], guidance: "Check named publication triplets and duplicate publication keys. No credential values are printed." }; }
  const reports = [];
  for (const p of publications) {
    let origin: string | null = null;
    try {
      const url = new URL(p.publicationUrl);
      if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && !url.port) origin = url.origin;
    } catch { /* Report a static code, never the supplied URL. */ }
    const valid = !!origin && p.missing.length === 0 && /^\d+$/.test(p.userId) && Number.isSafeInteger(Number(p.userId)) && Number(p.userId) > 0 && !!p.sessionToken.trim() && !/[\r\n]/.test(p.sessionToken);
    let authentication = "not_checked";
    if (checkAuth && valid) {
      try {
        // No redirects: never forward the session cookie to a redirected host.
        const response = await fetch(`${origin}/api/v1/post_management/drafts?offset=0&limit=1&order_by=draft_updated_at&order_direction=desc`, {
          headers: { Cookie: `connect.sid=${p.sessionToken}; substack.sid=${p.sessionToken}`, Accept: "application/json",
            "User-Agent": "Mozilla/5.0", Referer: `${origin}/publish/home` },
          redirect: "error", signal: AbortSignal.timeout(5000),
        });
        if (response.status === 401 || response.status === 403) authentication = "unauthorized_or_blocked";
        else if (response.status === 429) authentication = "rate_limited";
        else if (!response.ok) authentication = "upstream_error";
        else {
          const body: unknown = await response.json();
          authentication = body && typeof body === "object" && "posts" in body && Array.isArray(body.posts) ? "authenticated_read_succeeded" : "unexpected_response";
        }
      } catch (error) { authentication = isAbortError(error) ? "timeout" : "network_or_response_error"; }
    }
    reports.push({ publication: p.key, origin, credential_source: p.source,
      configuration: valid ? "valid" : "invalid", missing: p.missing, authentication,
      user_identity: "not_verified" });
  }
  return { ok: reports.every(p => p.configuration === "valid" && (!checkAuth || p.authentication === "authenticated_read_succeeded")),
    mode: checkAuth ? "authenticated_read" : "configuration_only", publications: reports,
    guidance: "Use an HTTPS publication origin and a positive numeric user ID. For expired sessions run substack-mcp-login. Authenticated reads do not verify the configured user ID or write permissions." };
}

export async function runDoctor(args: string[]) {
  if (args.some(a => a !== "--json" && a !== "--check-auth")) {
    console.error("Usage: substack-mcp doctor [--json] [--check-auth]");
    process.exitCode = 2;
    return;
  }
  const result = await doctor(args.includes("--check-auth"));
  console.log(args.includes("--json") ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
