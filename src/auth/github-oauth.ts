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

export function createOAuthState(secret?: string): string {
  const s = secret ?? getAuthSecret();
  const payload = JSON.stringify({
    nonce: randomBytes(16).toString("hex"),
    iat: Date.now(),
    exp: Date.now() + OAUTH_STATE_TTL_MS,
  });
  const payloadB64 = b64urlEncode(payload);
  return `${payloadB64}.${signPayload(payloadB64, s)}`;
}

export function verifyOAuthState(state: string | undefined, secret?: string, now = Date.now()): boolean {
  if (!state) return false;
  const s = secret ?? getAuthSecret();
  const payload = verifySignedPayload(state, s);
  if (!payload) return false;
  const exp = Number(payload.exp ?? 0);
  if (!Number.isFinite(exp) || now > exp) return false;
  return typeof payload.nonce === "string" && payload.nonce.length > 0;
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
