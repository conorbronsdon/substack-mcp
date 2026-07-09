#!/usr/bin/env node
/**
 * `substack-mcp-login` — a one-time browser login that captures your Substack
 * session and stores it locally (encrypted, machine-bound) so the MCP server
 * can run without pasting a session token into your client config.
 *
 * Playwright is NOT a dependency of this package (it is large and downloads
 * browsers). It is imported lazily and indirectly below; if it isn't
 * installed, this prints install instructions and exits. This keeps
 * `npx @conorbronsdon/substack-mcp` small for the common env-var path.
 *
 * NOTE: The browser-automation portion talks to Substack's live login UI,
 * which changes over time and can present a CAPTCHA. It cannot be covered by
 * automated tests. The encrypted store and credential resolution it feeds ARE
 * unit-tested (see src/__tests__).
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { saveSession } from "./auth/session-store.js";

const SESSION_COOKIE_NAMES = ["connect.sid", "substack.sid"];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Read the first present Substack session cookie from the browser context. */
async function readSessionCookie(context: any): Promise<string> {
  const cookies = await context.cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    const hit = cookies.find((c: any) => c.name === name && c.value);
    if (hit) return hit.value;
  }
  return "";
}

/** Poll the context until a session cookie appears or the timeout elapses. */
async function waitForSessionCookie(context: any): Promise<string> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const token = await readSessionCookie(context);
    if (token) return token;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "";
}

async function main(): Promise<void> {
  console.log("substack-mcp browser login\n");

  // Lazy + indirect import so tsc never needs the playwright types and the
  // package never hard-depends on it.
  let chromium: any;
  try {
    const moduleName = "playwright";
    ({ chromium } = await import(moduleName));
  } catch {
    console.error(
      "This login flow needs Playwright, which is not bundled with substack-mcp.\n" +
        "Install it once, then re-run:\n\n" +
        "  npm i -g playwright && npx playwright install chromium\n" +
        "  npx --package @conorbronsdon/substack-mcp substack-mcp-login\n",
    );
    process.exit(1);
    return;
  }

  const publicationUrl = (
    process.argv[2] ||
    (await ask("Publication URL (e.g. https://yourblog.substack.com): "))
  ).replace(/\/+$/, "");

  if (!/^https?:\/\//.test(publicationUrl)) {
    console.error("That doesn't look like a URL (needs http/https). Aborting.");
    process.exit(1);
    return;
  }

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log(
      "\nA browser window opened. Sign in to Substack there (including any CAPTCHA).",
    );
    console.log("Waiting for sign-in to complete (up to 5 minutes)...\n");
    await page.goto("https://substack.com/sign-in");

    const token = await waitForSessionCookie(context);
    if (!token) {
      console.error("Timed out waiting for sign-in. Nothing was saved.");
      process.exit(1);
      return;
    }

    console.log("Signed in. Resolving your user id from the publication...");
    await page.goto(publicationUrl, { waitUntil: "domcontentloaded" });
    const userId: string = await page.evaluate(async () => {
      try {
        const res = await fetch("/api/v1/archive?sort=new&limit=1", {
          credentials: "include",
        });
        const data = await res.json();
        return String(data?.[0]?.publishedBylines?.[0]?.id ?? "");
      } catch {
        return "";
      }
    });

    // Prefer the cookie as seen in the publication's own context (custom
    // domains use connect.sid); fall back to the substack.com one.
    const publicationToken = (await readSessionCookie(context)) || token;

    if (!userId) {
      console.error(
        "\nSigned in, but could not auto-resolve your user id from " +
          `${publicationUrl}. Find it via DevTools (see the README) and set ` +
          "SUBSTACK_USER_ID manually, or re-run with the correct publication URL.",
      );
      process.exit(1);
      return;
    }

    const file = saveSession({
      publicationUrl,
      sessionToken: publicationToken,
      userId,
    });

    console.log(
      `\nSaved. Credentials stored (encrypted, machine-bound) at:\n  ${file}\n`,
    );
    console.log(
      "substack-mcp will now use these automatically when SUBSTACK_* env vars are unset.",
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Login failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
