import { z } from "zod";
import { getEnv } from "../config/env.js";
import type { KvStore } from "../db/kv.js";
import { DEFAULT_GITHUB_OAUTH_SCOPE, getOAuthRedirectUri } from "./github-oauth.js";
import type { OAuthConfig } from "./github-oauth.js";

/* ------------------------------------------------------------------ *
 * Admin-managed GitHub login settings.
 *
 * Only NON-SECRET values live here (persisted in the kv store, editable
 * from the Admin panel). Secrets (GITHUB_CLIENT_SECRET, GITHUB_TOKEN,
 * GITHUB_WEBHOOK_SECRET, AUTH_SECRET) stay env-only per the platform's
 * security principle — the API/UI only ever report whether each one is set.
 *
 * Precedence per field: environment variable wins when set, otherwise the
 * admin-panel value is used. Every resolved field reports its `source`
 * ("env" | "admin" | "default") so the UI can show what is editable.
 * ------------------------------------------------------------------ */

export const ADMIN_GITHUB_SETTINGS_KEY = "admin.settings.github";

const GitHubAdminSettingsSchema = z.object({
  /** OAuth App Client ID (public identifier, safe to store). Empty = unset. */
  clientId: z.string().max(64).optional(),
  /** Explicit OAuth callback URL override. Empty = auto-derived. */
  callbackUrl: z.string().max(256).optional(),
  /** OAuth scope. Empty = platform default. */
  scope: z.string().max(200).optional(),
  /** Strict login mode. Undefined = fall back to REQUIRE_AUTH env. */
  requireAuth: z.boolean().optional(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
});

export type GitHubAdminSettings = z.infer<typeof GitHubAdminSettingsSchema>;

const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Read the raw admin-panel values (no env merging, no validation). */
export function getGitHubAdminSettings(kv: KvStore): GitHubAdminSettings {
  const raw = kv.get<GitHubAdminSettings>(ADMIN_GITHUB_SETTINGS_KEY);
  if (!raw || typeof raw !== "object") return {};
  const parsed = GitHubAdminSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export interface SaveGitHubAdminSettingsInput {
  clientId?: string;
  callbackUrl?: string;
  scope?: string;
  requireAuth?: boolean;
}

/**
 * Validate + persist admin-panel GitHub settings. Empty strings clear a field
 * back to "follow environment/default". Throws on invalid input.
 */
export function saveGitHubAdminSettings(
  kv: KvStore,
  input: SaveGitHubAdminSettingsInput,
  updatedBy?: string,
): GitHubAdminSettings {
  const clean = (v: string | undefined): string | undefined => {
    if (v === undefined) return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  };
  const clientId = clean(input.clientId);
  const callbackUrl = clean(input.callbackUrl);
  const scope = clean(input.scope);

  if (clientId !== undefined && !CLIENT_ID_RE.test(clientId)) {
    throw Object.assign(new Error("Invalid Client ID format"), { statusCode: 400 });
  }
  if (callbackUrl !== undefined && !isValidHttpUrl(callbackUrl)) {
    throw Object.assign(new Error("Callback URL must be a valid http(s) URL"), { statusCode: 400 });
  }
  if (scope !== undefined && scope.length > 200) {
    throw Object.assign(new Error("Scope is too long (max 200 chars)"), { statusCode: 400 });
  }

  const prev = getGitHubAdminSettings(kv);
  const next: GitHubAdminSettings = {
    ...prev,
    ...(input.clientId !== undefined ? { clientId } : {}),
    ...(input.callbackUrl !== undefined ? { callbackUrl } : {}),
    ...(input.scope !== undefined ? { scope } : {}),
    ...(input.requireAuth !== undefined ? { requireAuth: input.requireAuth } : {}),
    updatedAt: new Date().toISOString(),
    ...(updatedBy ? { updatedBy } : {}),
  };
  // Drop cleared fields entirely so "follow env" is explicit in storage.
  if (input.clientId !== undefined && clientId === undefined) delete next.clientId;
  if (input.callbackUrl !== undefined && callbackUrl === undefined) delete next.callbackUrl;
  if (input.scope !== undefined && scope === undefined) delete next.scope;
  const parsed = GitHubAdminSettingsSchema.parse(next);
  kv.set(ADMIN_GITHUB_SETTINGS_KEY, parsed);
  return parsed;
}

export type SettingSource = "env" | "admin" | "default";

export interface EffectiveGitHubLoginSettings {
  configured: boolean;
  clientId?: string;
  clientIdSource?: SettingSource;
  /** True when the OAuth client secret is present (env only — value never exposed). */
  clientSecretConfigured: boolean;
  redirectUri: string;
  redirectUriSource: SettingSource;
  scope: string;
  scopeSource: SettingSource;
  requireAuth: boolean;
  requireAuthSource: SettingSource;
  /** Presence flags for related secrets (env only — values never exposed). */
  secrets: {
    githubToken: boolean;
    githubWebhookSecret: boolean;
    authSecret: boolean;
  };
  /** Detailed diagnostics for actionable error messages (never exposes secret values). */
  diagnostics: {
    clientIdMissing: boolean;
    clientSecretMissing: boolean;
    authSecretMissing: boolean;
    callbackUrlMismatchRisk: boolean;
  };
  setupHint?: string;
  setupSteps?: string[];
}

/** Resolve the effective GitHub login configuration (env > admin > default). */
export function getEffectiveGitHubLoginSettings(kv?: KvStore): EffectiveGitHubLoginSettings {
  const env = getEnv();
  const admin = kv ? getGitHubAdminSettings(kv) : {};

  const clientId = env.GITHUB_CLIENT_ID || admin.clientId || undefined;
  const clientSecretConfigured = !!env.GITHUB_CLIENT_SECRET;
  const authSecretConfigured = !!env.AUTH_SECRET || !!env.GITHUB_WEBHOOK_SECRET || env.NODE_ENV !== "production";
  const configured = !!clientId && clientSecretConfigured;

  let redirectUri: string;
  let redirectUriSource: SettingSource;
  if (env.GITHUB_OAUTH_CALLBACK_URL) {
    redirectUri = env.GITHUB_OAUTH_CALLBACK_URL;
    redirectUriSource = "env";
  } else if (admin.callbackUrl) {
    redirectUri = admin.callbackUrl;
    redirectUriSource = "admin";
  } else {
    redirectUri = getOAuthRedirectUri();
    redirectUriSource = "default";
  }

  let scope: string;
  let scopeSource: SettingSource;
  if (admin.scope) {
    scope = admin.scope;
    scopeSource = "admin";
  } else {
    scope = env.GITHUB_OAUTH_SCOPE || DEFAULT_GITHUB_OAUTH_SCOPE;
    scopeSource = env.GITHUB_OAUTH_SCOPE ? "env" : "default";
  }

  let requireAuth: boolean;
  let requireAuthSource: SettingSource;
  if (admin.requireAuth !== undefined) {
    requireAuth = admin.requireAuth;
    requireAuthSource = "admin";
  } else {
    requireAuth = env.REQUIRE_AUTH;
    requireAuthSource = "env";
  }

  const diagnostics = {
    clientIdMissing: !clientId,
    clientSecretMissing: !clientSecretConfigured,
    authSecretMissing: !authSecretConfigured,
    callbackUrlMismatchRisk: false,
  };

  // Build actionable hints
  let setupHint: string | undefined;
  const setupSteps: string[] = [];
  if (!configured) {
    if (!clientId && !clientSecretConfigured) {
      setupHint = "GitHub login is not configured: Client ID and Client Secret are both missing.";
      setupSteps.push("1) Create a GitHub OAuth App at https://github.com/settings/developers → OAuth Apps → New OAuth App");
      setupSteps.push(`2) Authorization callback URL must be exactly: ${redirectUri}`);
      setupSteps.push("3) Set Client ID in Admin → GitHub Login (this page) OR as GITHUB_CLIENT_ID env variable");
      setupSteps.push("4) Set GITHUB_CLIENT_SECRET and AUTH_SECRET (any random 32+ char string) in Railway Variables / .env and redeploy");
    } else if (!clientId) {
      setupHint = "Client ID is missing — set it below (or as GITHUB_CLIENT_ID env).";
      setupSteps.push("Set the Client ID from your GitHub OAuth App here and Save.");
      if (!clientSecretConfigured) setupSteps.push("Also set GITHUB_CLIENT_SECRET in environment and redeploy.");
    } else if (!clientSecretConfigured) {
      setupHint = "Client ID is set, but GITHUB_CLIENT_SECRET is missing in environment — login will fail until it is set.";
      setupSteps.push("Go to Railway → Your Service → Variables (or .env locally) and add GITHUB_CLIENT_SECRET=<your OAuth App Client Secret>");
      setupSteps.push("Also ensure AUTH_SECRET is set (e.g. openssl rand -hex 32) — required to sign sessions");
      setupSteps.push("Redeploy / restart the service after adding variables");
      setupSteps.push(`Verify: Authorization callback URL in GitHub OAuth App must be exactly ${redirectUri}`);
    }
    if (diagnostics.authSecretMissing && env.NODE_ENV === "production") {
      setupSteps.push("⚠️ AUTH_SECRET is missing in production — sessions cannot be signed. Set AUTH_SECRET env (any 32+ random chars).");
    }
  } else if (diagnostics.authSecretMissing) {
    setupHint = "GitHub login is configured, but AUTH_SECRET is missing in production — sessions will fail.";
  }

  // Heuristic: if redirectUri looks like localhost but PUBLIC_WEB_BASE_URL is set to something else, warn
  try {
    const envBase = (env.PUBLIC_WEB_BASE_URL ?? env.WEB_BASE_URL ?? "").replace(/\/$/, "");
    if (envBase && !redirectUri.startsWith(envBase)) {
      diagnostics.callbackUrlMismatchRisk = true;
      if (configured) {
        setupHint = `Login is configured but callback URL mismatch risk: GitHub OAuth App callback is ${redirectUri} but PUBLIC_WEB_BASE_URL is ${envBase}/auth/github/callback`;
        setupSteps.push(`Ensure GitHub OAuth App → Authorization callback URL = ${redirectUri}`);
      }
    }
  } catch {}

  return {
    configured,
    clientId,
    clientIdSource: env.GITHUB_CLIENT_ID ? "env" : admin.clientId ? "admin" : undefined,
    clientSecretConfigured,
    redirectUri,
    redirectUriSource,
    scope,
    scopeSource,
    requireAuth,
    requireAuthSource,
    secrets: {
      githubToken: !!env.GITHUB_TOKEN,
      githubWebhookSecret: !!env.GITHUB_WEBHOOK_SECRET,
      authSecret: !!env.AUTH_SECRET,
    },
    diagnostics,
    setupHint: configured && !diagnostics.authSecretMissing ? undefined : setupHint,
    setupSteps: setupSteps.length ? setupSteps : undefined,
  };
}

/** Effective strict-auth flag (admin panel overrides REQUIRE_AUTH env). */
export function getEffectiveRequireAuth(kv?: KvStore): boolean {
  return getEffectiveGitHubLoginSettings(kv).requireAuth;
}

/**
 * Effective OAuth credentials for the login flow (env > admin > default).
 * The client secret always comes from the environment — it is never stored
 * in admin settings. Returns undefined when login is not configured.
 */
export function getEffectiveOAuthConfig(kv?: KvStore): OAuthConfig | undefined {
  const eff = getEffectiveGitHubLoginSettings(kv);
  const env = getEnv();
  if (!eff.configured || !eff.clientId || !env.GITHUB_CLIENT_SECRET) return undefined;
  return {
    clientId: eff.clientId,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    redirectUri: eff.redirectUri,
    scope: eff.scope,
  };
}
