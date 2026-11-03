/**
 * Substack's "Confirm it's you" step-up for sensitive admin reads (#190 follow-up).
 *
 * Substack refuses some reads, notably POST /api/v1/subscriber-stats, with
 * 403 {"type":"reauthentication_required"} until the session has passed a
 * one-time-code check. A fresh sign-in does not satisfy it. Substack's own
 * dashboard bundle handles that 403 by calling, on the publication origin:
 *   POST /api/v1/reauthenticate/start    -> {method: "email" | "totp"} or no method (already satisfied)
 *   POST /api/v1/reauthenticate/complete {code}
 * and then retrying the original request once. The code comes from the account
 * email or the account's authenticator app, so a person must supply it: this
 * module never stores, derives or generates codes or authenticator secrets.
 */
import { requestJson, readBounded } from "../api/request.js";
import { DEFAULT_BROWSER_USER_AGENT } from "../api/browser-user-agent.js";
import { AuthenticationError } from "../utils/errors.js";
import { validateCredentials } from "./validate-credentials.js";

export type SubscriberAccess = "granted" | "reauthentication_required" | "unavailable";
export type StepUpMethod = "email" | "totp";
export type StepUpFailure = "start_failed" | "method_unsupported" | "cancelled" | "code_rejected" | "complete_failed";

export class StepUpError extends Error {
  constructor(public code: StepUpFailure) { super(`Substack step-up failed (${code}).`); this.name = "StepUpError"; }
}

/** Reserved TLD (RFC 2606), used to request a filter that should not match a real subscriber. */
export const PROBE_EMAIL = "subscriber-access-probe@example.invalid";
export const MAX_CODE_ATTEMPTS = 3;
const STEP_UP_TIMEOUT_MS = 15_000, STEP_UP_BODY_BYTES = 64 * 1024;

function headers(origin: string, sessionToken: string, referer: string) {
  return {
    Cookie: validateCredentials(origin, sessionToken, "1").cookie,
    Accept: "application/json", "Content-Type": "application/json",
    "User-Agent": DEFAULT_BROWSER_USER_AGENT, Referer: `${origin}${referer}`,
  };
}

/** Read-only check using a reserved address; fail closed on unexpected response contents. */
export async function probeSubscriberAccess(origin: string, sessionToken: string): Promise<SubscriberAccess> {
  try {
    const body = await requestJson<unknown>(`${origin}/api/v1/subscriber-stats`, {
      method: "POST", headers: headers(origin, sessionToken, "/publish/subscribers"),
      body: JSON.stringify({ filters: { user_email_address_string_is: PROBE_EMAIL }, limit: 1, offset: 0 }),
    }, STEP_UP_TIMEOUT_MS, STEP_UP_BODY_BYTES);
    return body && typeof body === "object" && "count" in body && body.count === 0
      && (!("subscribers" in body) || (Array.isArray(body.subscribers) && body.subscribers.length === 0)) ? "granted" : "unavailable";
  } catch (error) {
    return error instanceof AuthenticationError && error.reason === "reauthentication_required" ? "reauthentication_required" : "unavailable";
  }
}

/** Carry a rotated session cookie forward; the client sends one value under both cookie names. */
export function rotatedSessionToken(response: Response, current: string): string {
  const values = new Map<string, string>();
  for (const raw of response.headers.getSetCookie()) {
    const parts = raw.split(";"), pair = parts[0], eq = pair.indexOf("=");
    const attributes = parts.slice(1).map(part => part.trim());
    const maxAge = attributes.find(part => /^max-age=/i.test(part))?.slice(8).trim();
    const expires = attributes.find(part => /^expires=/i.test(part))?.slice(8).trim();
    if (maxAge !== undefined && /^-?\d+$/.test(maxAge) && Number(maxAge) <= 0) continue;
    if (maxAge === undefined && expires && !Number.isNaN(Date.parse(expires)) && Date.parse(expires) <= Date.now()) continue;
    if (eq > 0) values.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  for (const name of ["connect.sid", "substack.sid"]) {
    const value = values.get(name);
    // An empty or unparseable value is a cookie deletion or noise, never a replacement session.
    if (value && /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(value)) return value;
  }
  return current;
}

async function post(origin: string, path: string, sessionToken: string, body?: unknown) {
  const url = `${origin}${path}`, signal = AbortSignal.timeout(STEP_UP_TIMEOUT_MS);
  const response = await fetch(url, {
    method: "POST", redirect: "manual", signal,
    headers: headers(origin, sessionToken, "/publish/subscribers"),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const token = rotatedSessionToken(response, sessionToken);
  let payload: unknown;
  try { payload = JSON.parse(await readBounded(response, STEP_UP_BODY_BYTES, signal, url)); } catch { payload = undefined; }
  const valid = payload !== null && typeof payload === "object" && !Array.isArray(payload);
  const ok = valid && response.status >= 200 && response.status < 300
    && !("error" in payload || ("success" in payload && payload.success === false) || ("errors" in payload && Array.isArray(payload.errors) && payload.errors.length > 0));
  return { ok, valid, payload, token };
}

/**
 * Run Substack's step-up once, asking a person for the one-time code.
 * Returns the (possibly rotated) session token and the method used, or null when none was needed.
 */
export async function completeStepUp(origin: string, sessionToken: string, askCode: (method: StepUpMethod, attempt: number) => Promise<string>): Promise<{ sessionToken: string; method: StepUpMethod | null }> {
  let start: Awaited<ReturnType<typeof post>>;
  try { start = await post(origin, "/api/v1/reauthenticate/start", sessionToken); }
  catch { throw new StepUpError("start_failed"); }
  if (!start.ok) throw new StepUpError("start_failed");
  let token = start.token;
  const method = start.payload && typeof start.payload === "object" && "method" in start.payload ? start.payload.method : undefined;
  if (method === undefined || method === null || method === "") return { sessionToken: token, method: null };
  if (method !== "email" && method !== "totp") throw new StepUpError("method_unsupported");
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    const code = (await askCode(method, attempt)).replace(/\s+/g, "");
    if (!code) throw new StepUpError("cancelled");
    // Codes are short alphanumerics; anything else is a paste mistake, not something to send.
    if (!/^[0-9A-Za-z-]{4,16}$/.test(code)) continue;
    let complete: Awaited<ReturnType<typeof post>>;
    try { complete = await post(origin, "/api/v1/reauthenticate/complete", token, { code }); }
    catch { throw new StepUpError("complete_failed"); }
    if (!complete.valid) throw new StepUpError("complete_failed");
    if (complete.ok) return { sessionToken: complete.token, method };
  }
  throw new StepUpError("code_rejected");
}
