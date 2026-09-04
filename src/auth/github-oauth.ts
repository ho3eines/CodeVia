import { createHmac, randomBytes } from "node:crypto";
import { getEnv } from "../config/env.js";

/* ------------------------------------------------------------------ *
 * GitHub OAuth login helpers (zero-dependency, fetch-based).
 *
 * Flow:
 *   1. GET /auth/github/login      -> 302 to github.com authorize URL (signed state)
 *   2. GET /auth/github/callback?code&state -> exchange code for token,
 *      fetch GitHub profile, upsert local user, issue signed session.
 *   3. Client sends session via `Authorization: Bearer <token>` or the
 *      HttpOnly `cv_session` cookie; GET /auth/me reports the current user.
 * ------------------------------------------------------------------ */

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_BASE = "https://api.github.com";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

export function getOAuthRedirectUri(): string {
  const env = getEnv();
  if (env.GITHUB_OAUTH_CALLBACK_URL) return env.GITHUB_OAUTH_CALLBACK_URL;
  const base = env.PUBLIC_WEB_BASE_URL ?? env.WEB_BASE_URL;
  return `${String(base).replace(/\/$/, "")}/auth/github/callback`;
}

/**
 * Production guard for the most common Railway misconfiguration:
 * `PUBLIC_WEB_BASE_URL` left as `http://localhost:8080`, so the OAuth callback
 * is derived from a local address. After authorizing on GitHub the browser can
 * never be redirected back to a localhost URL, the login silently never
 * completes, and no session cookie is ever set (401 on `/auth/me`).
 * Returns an actionable warning message, or undefined when the callback is
 * fine (or cannot be parsed).
 */
export function getLocalhostCallbackWarning(redirectUri: string): string | undefined {
  let host = "";
  try {
    host = new URL(redirectUri).hostname;
  } catch {
    return undefined;
  }
  if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(host)) return undefined;
  return (
    `GitHub OAuth callback resolves to a local address: ${redirectUri}. ` +
    `In production the browser can never be redirected back to it, so the login ` +
    `will never complete and no session cookie will be set (401 on /auth/me). ` +
    `Set PUBLIC_WEB_BASE_URL (or GITHUB_OAUTH_CALLBACK_URL / the Admin "Callback URL") to ` +
    `your public URL (e.g. https://<app>.up.railway.app) and make the GitHub OAuth App's ` +
    `"Authorization callback URL" match it exactly.`
  );
}

export function getOAuthConfig(): OAuthConfig | undefined {
  const env = getEnv();
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return undefined;
  return {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    redirectUri: getOAuthRedirectUri(),
    scope: env.GITHUB_OAUTH_SCOPE || "read:user user:email",
  };
}

export function isGitHubOAuthConfigured(): boolean {
  return !!getOAuthConfig();
}

/** Secret used to sign sessions + OAuth state. Falls back (dev only) with a warning. */
export function getAuthSecret(): string {
  const env = getEnv();
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  if (env.GITHUB_WEBHOOK_SECRET) return env.GITHUB_WEBHOOK_SECRET;
  if (env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is required in production (set AUTH_SECRET env var)");
  }
  return "dev-insecure-auth-secret-change-me";
}

/* ---------------- base64url helpers ---------------- */

export function b64urlEncode(input: string | Buffer): string {
  const b = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(input: string): Buffer {
  const s = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(s, "base64");
}

function signPayload(payloadB64: string, secret: string): string {
  return b64urlEncode(createHmac("sha256", secret).update(payloadB64).digest());
}

function verifySignedPayload(token: string, secret: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [payloadB64, sig] = parts;
  const expected = signPayload(payloadB64, secret);
  if (sig.length !== expected.length) return undefined;
  let equal = false;
  try {
    equal = Buffer.from(sig).equals(Buffer.from(expected));
  } catch {
    return undefined;
  }
  if (!equal) return undefined;
  try {
    return JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/* ---------------- OAuth state (CSRF protection) ---------------- */

/**
 * Only in-app hash routes may be used as a post-login destination — this
 * prevents open redirects (e.g. `next=https://evil.example`).
 */
const SAFE_NEXT_RE = /^#\/[A-Za-z0-9_\-/.%?=&]*$/;

export function sanitizeNextLocation(next: unknown): string | undefined {
  if (typeof next !== "string") return undefined;
  const t = next.trim();
  if (!t || t.length > 200 || !SAFE_NEXT_RE.test(t)) return undefined;
  return t;
}

export function createOAuthState(secret?: string, opts?: { next?: string }): string {
  const s = secret ?? getAuthSecret();
  const next = sanitizeNextLocation(opts?.next);
  const payload = JSON.stringify({
    nonce: randomBytes(16).toString("hex"),
    iat: Date.now(),
    exp: Date.now() + OAUTH_STATE_TTL_MS,
    ...(next ? { next } : {}),
  });
  const payloadB64 = b64urlEncode(payload);
  return `${payloadB64}.${signPayload(payloadB64, s)}`;
}

export function verifyOAuthState(state: string | undefined, secret?: string, now = Date.now()): boolean {
  return readOAuthState(state, secret, now) !== undefined;
}

/** Verify the state and return its (sanitized) payload, or undefined when invalid/expired. */
export function readOAuthState(
  state: string | undefined,
  secret?: string,
  now = Date.now(),
): { nonce: string; next?: string } | undefined {
  if (!state) return undefined;
  const s = secret ?? getAuthSecret();
  const payload = verifySignedPayload(state, s);
  if (!payload) return undefined;
  const exp = Number(payload.exp ?? 0);
  if (!Number.isFinite(exp) || now > exp) return undefined;
  if (typeof payload.nonce !== "string" || payload.nonce.length === 0) return undefined;
  const next = sanitizeNextLocation(payload.next);
  return { nonce: payload.nonce, ...(next ? { next } : {}) };
}

/* ---------------- authorize URL ---------------- */

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scope,
    state: opts.state,
    allow_signup: "true",
  });
  return `${GITHUB_AUTHORIZE_URL}?${q.toString()}`;
}

/* ---------------- code <-> token exchange ---------------- */

export interface GitHubTokenResponse {
  accessToken: string;
  scope: string;
  tokenType: string;
}

export async function exchangeCodeForToken(
  code: string,
  opts?: { clientId?: string; clientSecret?: string; redirectUri?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubTokenResponse> {
  const cfg = getOAuthConfig();
  const clientId = opts?.clientId ?? cfg?.clientId;
  const clientSecret = opts?.clientSecret ?? cfg?.clientSecret;
  const redirectUri = opts?.redirectUri ?? cfg?.redirectUri;
  if (!clientId || !clientSecret) {
    throw new Error("GitHub OAuth is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)");
  }
  const res = await fetchImpl(GITHUB_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed: ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  if (data.error) {
    throw new Error(`GitHub token exchange failed: ${String(data.error_description ?? data.error)}`);
  }
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new Error("GitHub token exchange returned no access_token");
  return {
    accessToken,
    scope: String(data.scope ?? ""),
    tokenType: String(data.token_type ?? "bearer"),
  };
}

/* ---------------- GitHub profile ---------------- */

export interface GitHubProfile {
  id: number;
  login: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

export async function fetchGitHubUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubProfile> {
  const res = await fetchImpl(`${GITHUB_API_BASE}/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub user fetch failed: ${res.status}`);
  const u = (await res.json()) as Record<string, unknown>;
  const id = Number(u.id);
  const login = String(u.login ?? "");
  if (!id || !login) throw new Error("GitHub user response missing id/login");
  let email = typeof u.email === "string" ? u.email : "";
  if (!email) {
    try {
      email = await fetchPrimaryEmail(accessToken, fetchImpl);
    } catch {
      email = "";
    }
  }
  return {
    id,
    login,
    name: typeof u.name === "string" && u.name ? u.name : login,
    email: email || `${login}@users.noreply.github.com`,
    avatarUrl: typeof u.avatar_url === "string" ? u.avatar_url : undefined,
  };
}

async function fetchPrimaryEmail(accessToken: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`${GITHUB_API_BASE}/user/emails`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return "";
  const list = (await res.json()) as Array<{ email: string; primary?: boolean; verified?: boolean }>;
  if (!Array.isArray(list) || list.length === 0) return "";
  const primary = list.find((e) => e.primary && e.verified) ?? list.find((e) => e.verified) ?? list[0];
  return primary?.email ?? "";
}

/* ---------------- sessions ---------------- */

export interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

export function signSession(userId: string, opts?: { secret?: string; ttlMs?: number; now?: number }): string {
  const secret = opts?.secret ?? getAuthSecret();
  const now = opts?.now ?? Date.now();
  const ttl = opts?.ttlMs ?? SESSION_TTL_MS;
  const payload: SessionPayload = { sub: userId, iat: now, exp: now + ttl };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  return `${payloadB64}.${signPayload(payloadB64, secret)}`;
}

export function verifySession(
  token: string | undefined,
  opts?: { secret?: string; now?: number },
): SessionPayload | undefined {
  if (!token) return undefined;
  const secret = opts?.secret ?? getAuthSecret();
  const payload = verifySignedPayload(token.trim(), secret);
  if (!payload) return undefined;
  const sub = String(payload.sub ?? "");
  const exp = Number(payload.exp ?? 0);
  const iat = Number(payload.iat ?? 0);
  if (!sub || !Number.isFinite(exp) || !Number.isFinite(iat)) return undefined;
  if ((opts?.now ?? Date.now()) > exp) return undefined;
  return { sub, iat, exp };
}

/** Extract a session token from `Authorization: Bearer …` or the `cv_session` cookie. */
export function extractSessionToken(headers: Record<string, unknown>): string | undefined {
  const auth = headers["authorization"] ?? headers["Authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const cookie = headers["cookie"] ?? headers["Cookie"];
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k === "cv_session" && v) {
        try {
          return decodeURIComponent(v);
        } catch {
          return v;
        }
      }
    }
  }
  return undefined;
}

export function buildSessionCookie(token: string, opts?: { secure?: boolean; maxAgeMs?: number }): string {
  const maxAge = Math.floor((opts?.maxAgeMs ?? SESSION_TTL_MS) / 1000);
  const secure = opts?.secure ? "; Secure" : "";
  return `cv_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function buildClearSessionCookie(): string {
  return `cv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
