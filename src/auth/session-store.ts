/**
 * Local, machine-bound storage for Substack credentials captured by the
 * `substack-mcp-login` browser flow, so the server can run without pasting a
 * session token into your MCP client config.
 *
 * SECURITY — read this before trusting it. The stored file is written
 * `0600` (owner read/write only) and its contents are encrypted with
 * AES-256-GCM. The key is DERIVED (scrypt) from this OS account + machine
 * identity, not stored. That means:
 *
 *   - A copied file is useless on another machine/user (the key won't
 *     re-derive), and casual disk/backup snooping sees only ciphertext.
 *   - It is NOT protection against code running AS YOU on this machine, which
 *     can re-derive the same key. It is obfuscation + machine-binding, not a
 *     secret vault. This is on par with — and slightly better than — the
 *     existing plaintext `SUBSTACK_SESSION_TOKEN` env-var path.
 *
 * If you need real secret storage, keep using the env-var path with your MCP
 * client's own secret handling, or an OS keychain.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import {
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

export interface StoredSession {
  publicationUrl: string;
  sessionToken: string;
  userId: string;
  savedAt: string;
}

/** On-disk envelope: everything needed to decrypt except the derived key. */
interface Envelope {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

/** Directory holding the session file. Overridable for tests via env. */
export function sessionDir(): string {
  return process.env.SUBSTACK_MCP_HOME || join(homedir(), ".substack-mcp");
}

function sessionFile(): string {
  return join(sessionDir(), "session.json");
}

/**
 * Derive the AES key from a per-write random salt bound to this OS account and
 * machine. The salt is stored alongside the ciphertext; the account/machine
 * identity is not — so the key cannot be re-derived elsewhere.
 */
function deriveKey(salt: Buffer): Buffer {
  const identity = `${userInfo().username}@${hostname()}::substack-mcp`;
  return scryptSync(identity, salt, 32);
}

/** Encrypt and write the session `0600`. Returns the file path. */
export function saveSession(session: Omit<StoredSession, "savedAt">): string {
  const dir = sessionDir();
  mkdirSync(dir, { recursive: true });

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(salt);

  const plaintext = JSON.stringify({
    ...session,
    savedAt: new Date().toISOString(),
  } satisfies StoredSession);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const envelope: Envelope = {
    v: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  };

  const file = sessionFile();
  writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
  // writeFileSync's mode is ignored if the file already existed; force it.
  try {
    chmodSync(file, 0o600);
  } catch {
    // chmod is a best-effort hardening step (e.g. a no-op on some Windows
    // filesystems). The file is still written; do not fail the login over it.
  }
  return file;
}

/**
 * Read and decrypt the stored session. Returns null when there is no file, or
 * when the file cannot be authenticated/decrypted — a wrong machine/user, a
 * tampered file, or a corrupt/older format. Never throws.
 */
export function loadSession(): StoredSession | null {
  const file = sessionFile();
  if (!existsSync(file)) return null;

  try {
    const envelope = JSON.parse(readFileSync(file, "utf8")) as Envelope;
    if (envelope.v !== 1) return null;

    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const data = Buffer.from(envelope.data, "base64");
    const key = deriveKey(salt);

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(data),
      decipher.final(),
    ]).toString("utf8");

    const parsed = JSON.parse(plaintext) as StoredSession;
    if (
      typeof parsed.publicationUrl !== "string" ||
      typeof parsed.sessionToken !== "string" ||
      typeof parsed.userId !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    // GCM auth failure (wrong key / tampered), bad base64, or malformed JSON.
    return null;
  }
}

/** Delete the stored session file. No-op if it doesn't exist. */
export function clearSession(): void {
  const file = sessionFile();
  if (existsSync(file)) rmSync(file);
}
