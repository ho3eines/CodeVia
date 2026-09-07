import { MockGitHubService } from "./mock-service.js";
import { RealGitHubService } from "./real-service.js";
import type { IGitHubService } from "./types.js";
import { getEnv } from "../config/env.js";
import { logger } from "../logger.js";
import type { KvStore } from "../db/kv.js";
import { getUserGitHubToken, hasRepoScope, GITHUB_TOKEN_KV_PREFIX } from "../auth/github-tokens.js";
import { getEffectiveOAuthConfig } from "../auth/admin-settings.js";

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

/**
 * Find a logged-in GitHub user token for a project without requiring
 * GITHUB_TOKEN. The OAuth login exchanges GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET
 * for a real user access token and stores it per user, so this is the intended
 * "use the OAuth credentials" path — not the server PAT.
 *
 * An explicit connection user is authoritative; otherwise use the project
 * owner. A missing/undecryptable token for either identity must NOT select a
 * different user's token. Only legacy projects with neither identity may use
 * the sole stored user token for backwards compatibility.
 * Returns the userId when a decryptable token exists, otherwise undefined.
 */
export function resolveProjectUserIdWithGitHubToken(kv: KvStore, project: import("../domain/entities.js").Project, allowSoleUser = true): string | undefined {
  const explicit = project.githubConnection?.userId || project.ownerId;
  if (explicit) return getUserGitHubToken(kv, explicit) ? explicit : undefined;
  if (!allowSoleUser) return undefined;
  const stored = kv.all();
  const userKeys = Object.keys(stored).filter((k) => k.startsWith(GITHUB_TOKEN_KV_PREFIX));
  if (userKeys.length === 1) {
    const userId = userKeys[0].slice(GITHUB_TOKEN_KV_PREFIX.length);
    return getUserGitHubToken(kv, userId) ? userId : undefined;
  }
  return undefined;
}

/** Resolve the connection saved on a project for background work, without borrowing another user's token. */
export function resolveGitHubForProject(opts: {
  project: import("../domain/entities.js").Project;
  kv: KvStore;
  fallback: IGitHubService;
  /**
   * The signed-in user behind the current request, when there is one.
   *
   * Each user must act as themselves: the repositories listed on the GitHub
   * page come from *this* user's OAuth token, so project actions have to use
   * the same credential. Resolving by `project.ownerId` instead meant a project
   * created by (or seeded for) another identity — including the pre-login
   * `user-demo` owner — kept using a foreign token or fell back to the mock,
   * even though the caller was properly connected to GitHub.
   *
   * Background work (workers, webhooks, schedules) has no request user and
   * keeps using the connection stored on the project.
   */
  requestUserId?: string;
}): IGitHubService {
  // A signed-in user always acts as themselves, whoever owns the project. This
  // is also the safer default: the caller can only ever reach repositories
  // their own token already grants.
  if (opts.requestUserId && getUserGitHubToken(opts.kv, opts.requestUserId)) {
    const userId = opts.requestUserId;
    return new RealGitHubService({ token: () => getUserGitHubToken(opts.kv, userId)?.token, label: "GitHub OAuth connection", fetchImpl: userGitHubFetch });
  }
  const connection = opts.project.githubConnection;
  if (!connection) return opts.fallback; // legacy installations
  if (connection.kind === "user-oauth") {
    const userId = resolveProjectUserIdWithGitHubToken(opts.kv, opts.project, false);
    if (!userId) {
      throw new Error(`GitHub connection for project ${opts.project.name} needs to be reconnected by its owner`);
    }
    return new RealGitHubService({ token: () => getUserGitHubToken(opts.kv, userId)?.token, label: "GitHub OAuth connection", fetchImpl: userGitHubFetch });
  }
  if (connection.kind === "server-token") {
    if (opts.fallback.kind === "real") return opts.fallback;
    if (isServerGitHubEnabled()) return new RealGitHubService();
    throw new Error(`Server GitHub connection is unavailable for project ${opts.project.name}; refusing a mock fallback`);
  }
  // `mock` was persisted while the platform ran in demo/simulation mode. Use the
  // real OAuth user token obtained from GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET
  // login; never reach for GITHUB_TOKEN here. If login is configured but no user
  // token exists yet, fail with an actionable message instead of silent mock.
  if (connection.kind === "mock") {
    const userId = resolveProjectUserIdWithGitHubToken(opts.kv, opts.project);
    if (userId) {
      return new RealGitHubService({ token: () => getUserGitHubToken(opts.kv, userId)?.token, label: "GitHub OAuth connection", fetchImpl: userGitHubFetch });
    }
    if (getEffectiveOAuthConfig(opts.kv)) {
      throw new Error(`GitHub OAuth is configured, but no user token is stored for project ${opts.project.name}. Log in with GitHub once; then project actions use your repository access without GITHUB_TOKEN.`);
    }
    if (opts.fallback.kind === "mock") return opts.fallback;
  }
  let mock = projectMocks.get(opts.fallback);
  if (!mock) { mock = new MockGitHubService(); projectMocks.set(opts.fallback, mock); }
  return mock;
}
const projectMocks = new WeakMap<IGitHubService, MockGitHubService>();
