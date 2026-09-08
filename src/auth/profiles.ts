import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decodeSession, encodeSession, loadSession, sessionDir, type StoredSession } from "./session-store.js";
import { validateCredentials } from "./validate-credentials.js";

const MAX_BYTES = 128 * 1024;
export function profileKey(key: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw new Error("Profile keys must be lowercase ASCII letters, digits or hyphens, starting with a letter, at most 64 characters.");
  return key;
}
const fileFor = (key: string) => join(sessionDir(), `profile-${profileKey(key)}.json`);
function valid(session: StoredSession | null): StoredSession {
  if (!session || session.sessionToken.length > 16_384 || session.publicationUrl.length > 2048 || !Number.isFinite(Date.parse(session.savedAt))) throw new Error("Invalid profile credentials.");
  validateCredentials(session.publicationUrl, session.sessionToken, session.userId);
  return session;
}

/** Explicit selection never falls back to another session when a profile fails. */
export function loadProfile(key: string): StoredSession {
  const path = fileFor(key);
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_BYTES + 1); let count = 0;
    while (count < bytes.length) {
      const size = readSync(fd, bytes, count, bytes.length - count, null);
      if (!size) break; count += size;
    }
    if (count > MAX_BYTES) throw new Error();
    return valid(decodeSession(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))));
  } catch { throw new Error(`Profile "${key}" is missing, invalid or unreadable. Check local storage and permissions; no fallback session was selected.`); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Early usability check only; exclusive creation still enforces the race boundary. */
export function assertProfileAvailable(key: string, force = false): void {
  try {
    const stat = lstatSync(fileFor(key));
    if (!force) throw Object.assign(new Error("Profile already exists; choose another key or use --force."), { code: "EEXIST" });
    if (!stat.isFile()) throw new Error("Existing profile must be a regular file.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Complete encrypted file, exclusive by default. Existing profiles require force. */
export function saveProfile(key: string, session: Omit<StoredSession, "savedAt">, force = false): void {
  const target = fileFor(key);
  assertProfileAvailable(key, force);
  valid({ ...session, savedAt: new Date().toISOString() });
  const encoded = encodeSession(session);
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error("Profile exceeds storage bounds.");
  mkdirSync(sessionDir(), { recursive: true, mode: 0o700 });
  const temporary = join(sessionDir(), `.profile-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, encoded); fsyncSync(fd); closeSync(fd); fd = undefined;
    if (force) {
      try { if (!lstatSync(target).isFile()) throw new Error("Existing profile must be a regular file."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      renameSync(temporary, target);
    } else linkSync(temporary, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Profile cleanup failed. Inspect local profile storage before retrying; the save may have completed."); }
  }
}

export function migrateProfile(key: string, force = false): void {
  profileKey(key);
  const session = valid(loadSession());
  saveProfile(key, session, force);
}

export function listProfiles(): { key: string; status: "readable" | "unreadable"; origin?: string; saved_at?: string }[] {
  let names: string[];
  try { names = readdirSync(sessionDir()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("Profile directory is unreadable."); }
  const keys = names.filter(name => /^profile-[a-z][a-z0-9-]{0,63}\.json$/.test(name)).map(name => name.slice(8, -5)).sort();
  if (keys.length > 32) throw new Error("At most 32 profiles can be listed at once.");
  return keys.map(key => {
    try { const session = loadProfile(key); return { key, status: "readable" as const, origin: new URL(session.publicationUrl).origin, saved_at: session.savedAt }; }
    catch { return { key, status: "unreadable" as const }; }
  });
}
