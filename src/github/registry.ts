import { MockGitHubService } from "./mock-service.js";
import { RealGitHubService } from "./real-service.js";
import type { IGitHubService } from "./types.js";
import { getEnv } from "../config/env.js";
import { logger } from "../logger.js";
import type { KvStore } from "../db/kv.js";
import { getUserGitHubToken, hasRepoScope } from "../auth/github-tokens.js";

/** A configured GitHub connection bound to a project. */
export interface GithubConnection {
  id: string;
  projectId?: string;
  provider: "github-app" | "oauth" | "token";
  owner: string;
  /** The token is always a secret reference, never stored literally. */
  secretRef: string;
}

/** Is the server-wide GITHUB_TOKEN active (production or GITHUB_ENABLED=true)? */
export function isServerGitHubEnabled(): boolean {
  const env = getEnv();
  const token = process.env.GITHUB_TOKEN;
  const enabled = env.NODE_ENV === "production" || env.GITHUB_ENABLED === "true" || process.env.GITHUB_ENABLED === "true";
  return !!token && enabled;
}

/**
 * Resolves the platform-wide GitHub service (agents, workers, webhooks). Uses
 * the real REST adapter when a token is configured (production), otherwise the
 * mock for dev/test/Simulation Mode.
 */
export function resolveGitHubService(): IGitHubService {
  // Use the real REST adapter in production (or when explicitly enabled) with a
  // token. Local dev/test defaults to the mock so the platform never requires
  // GitHub credentials to boot — a project can still connect to real GitHub via
  // the integration settings in production.
  // (GITHUB_CLIENT_SECRET is intentionally NOT accepted here: it is the OAuth
  // app secret, not an API token, and the old fallback caused confusing 401s.)
  if (isServerGitHubEnabled()) {
    logger.info("Using RealGitHubService");
    return new RealGitHubService({ label: "GITHUB_TOKEN" });
  }
  logger.info("Using MockGitHubService (no active GitHub token config)");
  return new MockGitHubService();
}

export function createMockGitHubService(): MockGitHubService {
  return new MockGitHubService();
}

export type GithubSource = "user-oauth" | "server-token" | "mock";

/** fetch used by per-user GitHub adapters — overridable in tests (no network). */
let userGitHubFetch: typeof fetch | undefined;
export function setUserGitHubFetchForTest(impl: typeof fetch | undefined): void {
  userGitHubFetch = impl;
}

export interface ResolvedGitHub {
  service: IGitHubService;
  source: GithubSource;
  /** OAuth scopes of the user token (when source = user-oauth). */
  scopes: string[];
  /** Human hint explaining how the connection was chosen / how to improve it. */
  hint?: string;
}

/**
 * Resolve the GitHub service for an interactive request (repo picker, GitHub
 * page). Preference order:
 *   1. the logged-in user's own OAuth token (their repositories — the thing the
 *      UI actually needs),
 *   2. the server-wide GITHUB_TOKEN (shared bot/PAT),
 *   3. the platform default (mock in dev).
 */
export function resolveGitHubForUser(opts: {
  kv: KvStore;
  userId?: string;
  authenticated: boolean;
  fallback: IGitHubService;
}): ResolvedGitHub {
  if (opts.authenticated && opts.userId) {
    const stored = getUserGitHubToken(opts.kv, opts.userId);
    if (stored) {
      const service = new RealGitHubService({ token: stored.token, label: "user GitHub session", fetchImpl: userGitHubFetch });
      const hint = hasRepoScope(stored.scopes)
        ? undefined
        : "Your GitHub login only granted public access (scope 'public_repo'/none). Private repositories are hidden — an admin can set the OAuth scope to 'repo read:user user:email' and you can log in again to see them.";
      return { service, source: "user-oauth", scopes: stored.scopes, hint };
    }
  }
  if (opts.fallback.kind === "real") {
    return {
      service: opts.fallback,
      source: "server-token",
      scopes: [],
      hint: opts.authenticated
        ? "Listing repositories with the server GITHUB_TOKEN (your login session has no GitHub token yet — log out and in again to use your own account)."
        : "Listing repositories visible to the server GITHUB_TOKEN. Log in with GitHub to see your own repositories.",
    };
  }
  return {
    service: opts.fallback,
    source: "mock",
    scopes: [],
    hint: opts.authenticated
      ? "No GitHub token is available for your session yet — log out and log in with GitHub again (the login now stores a repository-access token)."
      : "Demo repositories (mock GitHub). Log in with GitHub to pick from your real repositories, or set GITHUB_TOKEN + GITHUB_ENABLED=true on the server.",
  };
}

export type { IGitHubService, GithubRepoRef } from "./types.js";
