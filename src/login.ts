#!/usr/bin/env node
/** Browser login is interactive; the legacy binary remains a supported alias. */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { saveSession } from "./auth/session-store.js";
import { profileKey, saveProfile } from "./auth/profiles.js";
import { publicationOrigin, validateCredentials } from "./auth/validate-credentials.js";
import { doctor } from "./doctor.js";

const usage = "Usage: substack-mcp-login [publication-url] [--user-id id] [--profile key] [--force]\nAlias: substack-mcp login [same options]\nInteractive browser sign-in. Missing URL/user ID are prompted. User ID must be your own configured Substack ID; a post byline is not identity verification. --profile stores a named session; existing profiles require --force. Requires Playwright. --help is offline.";
const COOKIE_NAMES = ["connect.sid", "substack.sid"];
interface CookieContext { cookies(url: string): Promise<{ name: string; value: string }[]> }
interface LoginBrowser { newContext(): Promise<CookieContext & { newPage(): Promise<{ goto(url: string, options?: { waitUntil: "domcontentloaded" }): Promise<unknown> }> }>; close(): Promise<void> }
interface Chromium { launch(options: { headless: boolean }): Promise<LoginBrowser> }

export function parseLoginArguments(args: string[]) {
  let publicationUrl: string | undefined, userId: string | undefined, profile: string | undefined;
  let force = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--") && i === 0) { publicationUrl = publicationOrigin(arg) ?? undefined; if (!publicationUrl) throw new Error("Invalid publication URL."); continue; }
    if (seen.has(arg)) throw new Error("Duplicate login option."); seen.add(arg);
    if (arg === "--force") { force = true; continue; }
    if (!["--user-id", "--profile"].includes(arg) || !args[i + 1]) throw new Error("Unknown or incomplete login option.");
    const value = args[++i];
    if (arg === "--profile") profile = profileKey(value);
    else { validateCredentials("https://example.invalid", "validation-only", value); userId = value; }
  }
  if (force && !profile) throw new Error("--force requires --profile.");
  return { publicationUrl, userId, profile, force };
}

/** Only inspect cookies that apply to the requested URL; never pick another host's session. */
export async function readSessionCookie(context: CookieContext, url: string): Promise<string> {
  const cookies = await context.cookies(url);
  for (const name of COOKIE_NAMES) {
    const values = [...new Set(cookies.filter(c => c.name === name && c.value).map(c => c.value))];
    if (values.length > 1) throw new Error("Ambiguous session cookies; sign in with a fresh browser context.");
    if (values.length === 1) return values[0];
  }
  return "";
}
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}
async function loadChromium(): Promise<Chromium> {
  const moduleName = "playwright";
  try { return (await import(moduleName)).chromium; }
  catch { throw new Error("Install the package and Playwright together in a local tools directory: npm install @conorbronsdon/substack-mcp playwright; then npx playwright install chromium; then npx substack-mcp login."); }
}
const defaults = { ask, loadChromium, out: (text: string) => console.log(text), error: (text: string) => console.error(text) };
export async function runLogin(args: string[], deps = defaults): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { deps.out(usage); return 0; }
  let options: ReturnType<typeof parseLoginArguments>;
  try { options = parseLoginArguments(args); } catch { deps.error(usage); return 2; }
  let browser: LoginBrowser | undefined;
  try {
    const publicationUrl = options.publicationUrl ?? publicationOrigin(await deps.ask("Publication HTTPS origin: "));
    const userId = options.userId ?? await deps.ask("Your Substack user ID (not a publication author's byline ID): ");
    if (!publicationUrl) { deps.error("Use a direct HTTPS publication origin."); return 2; }
    try { validateCredentials(publicationUrl, "validation-only", userId); } catch { deps.error("Use your positive numeric Substack user ID."); return 2; }
    let chromium: Chromium;
    try { chromium = await deps.loadChromium(); } catch { deps.error("Browser login needs Playwright. In a local tools directory run npm install @conorbronsdon/substack-mcp playwright, then npx playwright install chromium, then npx substack-mcp login."); return 1; }
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext(), page = await context.newPage();
    deps.out("Sign in to Substack in the opened browser, including any CAPTCHA. Waiting up to five minutes.");
    await page.goto("https://substack.com/sign-in");
    const deadline = Date.now() + 5 * 60 * 1000;
    while (!(await readSessionCookie(context, "https://substack.com"))) {
      if (Date.now() >= deadline) throw new Error("Login timed out.");
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    await page.goto(publicationUrl, { waitUntil: "domcontentloaded" });
    const sessionToken = await readSessionCookie(context, `${publicationUrl}/api/v1/post_management/drafts`);
    validateCredentials(publicationUrl, sessionToken, userId);
    const credentials = { publicationUrl, sessionToken, userId };
    const check = await doctor(true, () => [{ ...credentials, key: options.profile ?? "default", label: "login", source: "stored", missing: [] }]);
    if (!check.ok) throw new Error("Authenticated read did not succeed.");
    if (options.profile) saveProfile(options.profile, credentials, options.force);
    else saveSession(credentials);
    deps.out(JSON.stringify({ format_version: 1, ok: true, command: "login", profile: options.profile ?? null, authentication: "authenticated_read_succeeded", user_identity: "not_verified", storage: "machine_bound_file" }));
    deps.out(options.profile ? `Select this profile with SUBSTACK_PROFILES=${options.profile}. Remove publication credential env vars first.` : "Stored legacy session is used when publication credential env vars are unset.");
    return 0;
  } catch {
    deps.error("Login or local saving failed. Check sign-in, publication access, your configured user ID and profile overwrite choice. Inspect local status before retrying; user identity is not independently verified."); return 1;
  } finally {
    try { await browser?.close(); }
    catch { deps.error("Browser cleanup failed. Close the login window manually; inspect local status to confirm whether saving completed."); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLogin(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => { console.error("Login failed."); process.exitCode = 1; });
}
