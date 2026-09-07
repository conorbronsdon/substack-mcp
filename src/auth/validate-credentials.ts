/** Configuration checks only: these do not establish identity or permissions. */
export function publicationOrigin(value: string): string | null {
  // URL parsing removes some whitespace/control characters. Reject those before
  // parsing so a pasted credential or header delimiter is never normalized away.
  if (/[\s\u0000-\u001f\u007f\\]/u.test(value) || !/^https:\/\/[^/?#]+\/?$/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || url.port) return null;
    return url.origin;
  } catch { return null; }
}

export function validateCredentials(publicationUrl: string, sessionToken: string, userId: string) {
  const origin = publicationOrigin(publicationUrl);
  if (!origin) throw new Error("Invalid publication URL: use an HTTPS origin without a path, query, credentials or custom port.");
  if (!/^\d+$/.test(userId) || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) {
    throw new Error("Invalid SUBSTACK_USER_ID: use a positive safe integer containing only digits.");
  }
  // RFC 6265 cookie-octet, unquoted. Preserve percent-encoded session values;
  // never decode/re-encode them or accept an entire Cookie header.
  if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(sessionToken)) {
    throw new Error("Invalid session token: use the cookie value without quotes, whitespace or cookie separators.");
  }
  return { origin, userId: Number(userId), cookie: `connect.sid=${sessionToken}; substack.sid=${sessionToken};` };
}
