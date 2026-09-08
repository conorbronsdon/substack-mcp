import { resolvePublications } from "./auth/resolve-publications.js";
import { AuthenticationError, RateLimitError, ResponseError, SubstackAPIError, TimeoutError } from "./utils/errors.js";
import { requestJson } from "./api/request.js";
import { publicationOrigin, validateCredentials } from "./auth/validate-credentials.js";

export async function doctor(checkAuth = false, resolve = resolvePublications) {
  let publications: ReturnType<typeof resolvePublications>;
  try { publications = resolve(); }
  catch { return { ok: false, code: "invalid_configuration", publications: [], guidance: "Check publication triplets, duplicate keys and selected profiles. SUBSTACK_PROFILES cannot be combined with publication credential variables. No credential values are printed." }; }
  const reports = [];
  for (const p of publications) {
    const origin = publicationOrigin(p.publicationUrl);
    let validated: ReturnType<typeof validateCredentials> | null = null;
    try {
      validated = validateCredentials(p.publicationUrl, p.sessionToken, p.userId);
    } catch { /* Report static codes, never supplied credential values. */ }
    const valid = validated !== null && p.missing.length === 0;
    let authentication = "not_checked";
    if (checkAuth && valid && validated) {
      try {
        const body = await requestJson<unknown>(`${origin}/api/v1/post_management/drafts?offset=0&limit=1&order_by=draft_updated_at&order_direction=desc`, {
          headers: { Cookie: validated.cookie, Accept: "application/json",
            "User-Agent": "Mozilla/5.0", Referer: `${origin}/publish/home` },
        }, 5000, 1024 * 1024);
        authentication = body && typeof body === "object" && "posts" in body && Array.isArray(body.posts) ? "authenticated_read_succeeded" : "unexpected_response";
      } catch (error) {
        authentication = error instanceof AuthenticationError ? "unauthorized_or_blocked"
          : error instanceof RateLimitError ? "rate_limited"
          : error instanceof TimeoutError ? "timeout"
          : error instanceof ResponseError ? error.code
          : error instanceof SubstackAPIError ? "upstream_error"
          : "network_or_response_error";
      }
    }
    reports.push({ publication: p.key, origin, credential_source: p.source,
      configuration: valid ? "valid" : "invalid", missing: p.missing, authentication,
      user_identity: "not_verified" });
  }
  return { ok: reports.every(p => p.configuration === "valid" && (!checkAuth || p.authentication === "authenticated_read_succeeded")),
    mode: checkAuth ? "authenticated_read" : "configuration_only", publications: reports,
    guidance: "Use an HTTPS publication origin and a positive numeric user ID. For expired sessions run substack-mcp login; use --profile for a named session. Authenticated reads do not verify the configured user ID or write permissions." };
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
