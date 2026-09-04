import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { KvStore } from "../db/kv.js";
import { getAuthSecret } from "./github-oauth.js";

/* ------------------------------------------------------------------ *
 * Per-user GitHub access tokens.
 *
 * The OAuth login used to discard the access token right after fetching the
 * profile, so the platform could never list *the user's* repositories — the
 * GitHub page and the project form always fell back to the server-wide
 * GITHUB_TOKEN (or the mock). The token is a session credential, not a
 * configuration secret, so it is kept encrypted at rest (AES-256-GCM, key
 * derived from AUTH_SECRET) in the runtime kv store and never exported
 * (backups only include the admin settings key).
 *
 * Rotating AUTH_SECRET makes stored tokens undecryptable; they are then
 * treated as absent and the user simply logs in again.
 * ------------------------------------------------------------------ */

export const GITHUB_TOKEN_KV_PREFIX = "auth.github.token:";

export interface StoredGitHubToken {
  token: string;
  scopes: string[];
  login?: string;
  updatedAt: string;
}

interface EncryptedRecord {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
  scopes: string[];
  login?: string;
  updatedAt: string;
}

function keyFor(secret?: string): Buffer {
  return createHash("sha256").update(`${secret ?? getAuthSecret()}:github-user-token`).digest();
}

export function encryptToken(token: string, secret?: string): Pick<EncryptedRecord, "iv" | "tag" | "ct"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function decryptToken(rec: Pick<EncryptedRecord, "iv" | "tag" | "ct">, secret?: string): string | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), Buffer.from(rec.iv, "base64"));
    decipher.setAuthTag(Buffer.from(rec.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(rec.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

export function storeUserGitHubToken(
  kv: KvStore,
  userId: string,
  token: string,
  meta: { scopes?: string[] | string; login?: string } = {},
): void {
  const scopes = Array.isArray(meta.scopes)
    ? meta.scopes
    : String(meta.scopes ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  const rec: EncryptedRecord = {
    v: 1,
    ...encryptToken(token),
    scopes,
    login: meta.login,
    updatedAt: new Date().toISOString(),
  };
  kv.set(GITHUB_TOKEN_KV_PREFIX + userId, rec);
}

export function getUserGitHubToken(kv: KvStore, userId: string | undefined): StoredGitHubToken | undefined {
  if (!userId) return undefined;
  const rec = kv.get<EncryptedRecord>(GITHUB_TOKEN_KV_PREFIX + userId);
  if (!rec || rec.v !== 1) return undefined;
  const token = decryptToken(rec);
  if (!token) return undefined;
  return { token, scopes: rec.scopes ?? [], login: rec.login, updatedAt: rec.updatedAt };
}

export function deleteUserGitHubToken(kv: KvStore, userId: string): void {
  kv.delete(GITHUB_TOKEN_KV_PREFIX + userId);
}

/** Non-secret summary for status endpoints (never includes the token). */
export function describeUserGitHubToken(kv: KvStore, userId: string | undefined): { stored: boolean; scopes: string[]; login?: string; updatedAt?: string; canReadPrivateRepos: boolean } {
  const t = getUserGitHubToken(kv, userId);
  if (!t) return { stored: false, scopes: [], canReadPrivateRepos: false };
  return { stored: true, scopes: t.scopes, login: t.login, updatedAt: t.updatedAt, canReadPrivateRepos: hasRepoScope(t.scopes) };
}

/** `repo` grants private-repo access; `public_repo` only public ones. */
export function hasRepoScope(scopes: string[]): boolean {
  return scopes.includes("repo");
}
