import { requestJson } from "../api/request.js";
import { DEFAULT_BROWSER_USER_AGENT } from "../api/browser-user-agent.js";
import { validateCredentials } from "./validate-credentials.js";

/** Exact publication origin only. Never infer identity from a post or public profile. */
export async function readAuthenticatedUserId(publicationUrl: string, sessionToken: string): Promise<number> {
  // The placeholder is used only to validate the origin/cookie syntax. It is
  // never sent, saved, or treated as the authenticated identity.
  const { origin, cookie } = validateCredentials(publicationUrl, sessionToken, "1");
  const body = await requestJson<unknown>(`${origin}/api/v1/user/profile/self`, {
    method: "GET", headers: { Cookie: cookie, Accept: "application/json", "User-Agent": DEFAULT_BROWSER_USER_AGENT, Referer: `${origin}/publish/home` },
  }, 5000, 1024 * 1024);
  const id = body && typeof body === "object" && "id" in body ? body.id : undefined;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("Authenticated identity response did not contain a positive safe integer ID.");
  return id;
}
