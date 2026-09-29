import { GitHubAuthError } from "./real-service.js";
import { noteGitHubAuthorizationRequired, type GitHubAuthorizationNotice } from "./request-actor.js";

/**
 * GitHub write authorization.
 *
 * CodeVia applies changes to a project by committing through the GitHub API
 * **as the signed-in user** (their OAuth token), never with the site-wide
 * `GITHUB_TOKEN`. When the user has not granted CodeVia a token yet — or the
 * token they granted cannot write (no `repo` scope) — the platform raises
 * `GitHubAuthorizationRequiredError`. The HTTP layer turns it into a 403 with
 * a `githubAuthorization` block, and the SPA automatically asks the user to
 * grant write access on GitHub (`/auth/github/login?scope=write`).
 */

/** The OAuth scope that lets CodeVia commit / open PRs on the user's repositories. */
export const GITHUB_WRITE_SCOPE = "repo";
export const GITHUB_AUTHORIZATION_CODE = "github_authorization_required" as const;

export type GitHubAuthorizationReason = GitHubAuthorizationNotice["reason"];

/** Does this scope list allow writing to (private and public) repositories? */
export function hasGitHubWriteScope(scopes: readonly string[] | undefined): boolean {
  return (scopes ?? []).map((s) => s.trim()).includes(GITHUB_WRITE_SCOPE);
}

/** Merge extra scopes into a space/comma separated scope string, without duplicates. */
export function mergeOAuthScopes(base: string, extra: readonly string[]): string {
  const out: string[] = [];
  for (const s of [...String(base ?? "").split(/[\s,]+/), ...extra]) {
    const t = s.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.join(" ");
}

/** Relative URL that starts the OAuth flow asking for write access and returns to `next`. */
export function buildWriteAuthorizeUrl(next?: string): string {
  const q = new URLSearchParams({ scope: "write" });
  if (next) q.set("next", next);
  return `/auth/github/login?${q.toString()}`;
}

const MESSAGES: Record<GitHubAuthorizationReason, string> = {
  "no-token":
    "CodeVia needs access to your GitHub account to apply changes to this project. Authorize GitHub (with repository write access) — the site token is never used to write your repositories.",
  "missing-scope":
    "Your GitHub authorization is read-only, so CodeVia cannot write to this repository. Grant repository write access (scope 'repo') on GitHub to apply changes.",
  "token-rejected":
    "GitHub rejected your stored authorization (revoked or expired). Authorize GitHub again with repository write access to apply changes.",
};

export class GitHubAuthorizationRequiredError extends GitHubAuthError {
  readonly code = GITHUB_AUTHORIZATION_CODE;
  /** Fastify reads `statusCode` when an error escapes a route. */
  readonly statusCode = 403;
  constructor(readonly notice: GitHubAuthorizationNotice) {
    super(notice.message, notice.reason === "token-rejected" ? 401 : 403);
    this.name = "GitHubAuthorizationRequiredError";
  }
  toJSON(): Record<string, unknown> {
    return {
      error: this.notice.message,
      code: GITHUB_AUTHORIZATION_CODE,
      githubAuthorization: this.notice,
    };
  }
}

export function isGitHubAuthorizationRequired(err: unknown): err is GitHubAuthorizationRequiredError {
  return (
    err instanceof GitHubAuthorizationRequiredError ||
    (!!err && typeof err === "object" && (err as { code?: unknown }).code === GITHUB_AUTHORIZATION_CODE)
  );
}

/**
 * Build the error AND record it on the current request so the SPA gets the
 * authorization prompt even if a route catches the error and answers with its
 * own status/message.
 */
export function githubAuthorizationRequired(opts: {
  reason: GitHubAuthorizationReason;
  grantedScopes?: string[];
  login?: string;
  detail?: string;
  next?: string;
}): GitHubAuthorizationRequiredError {
  const notice: GitHubAuthorizationNotice = {
    code: GITHUB_AUTHORIZATION_CODE,
    reason: opts.reason,
    message: opts.detail ? `${MESSAGES[opts.reason]} (${opts.detail})` : MESSAGES[opts.reason],
    requiredScopes: [GITHUB_WRITE_SCOPE],
    grantedScopes: opts.grantedScopes ?? [],
    authorizeUrl: buildWriteAuthorizeUrl(opts.next),
    ...(opts.login ? { login: opts.login } : {}),
  };
  noteGitHubAuthorizationRequired(notice);
  return new GitHubAuthorizationRequiredError(notice);
}
