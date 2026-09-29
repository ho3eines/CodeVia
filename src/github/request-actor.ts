import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request GitHub identity context.
 *
 * `userId` is the signed-in user for the current HTTP request **when that user
 * has a stored GitHub OAuth token** — the identity every
 * `githubForProject(project)` call on that request uses.
 *
 * `signedInUserId` is the authenticated user regardless of whether a token is
 * stored. It exists so the resolver can tell "a real user is acting but has
 * not granted CodeVia GitHub access yet" apart from background work: in that
 * case the platform must ask the user to authorize (with write scope) instead
 * of silently falling back to the site-wide `GITHUB_TOKEN`.
 *
 * `authorization` records that, while serving this request, GitHub access had
 * to be (re-)authorized. The HTTP layer attaches it to any error response so
 * the SPA can start the GitHub authorization flow automatically, even when a
 * route caught the original error and answered with its own message.
 *
 * Project file sync, conversation persist, and `readProject` all go through
 * `githubForProject(project)` with no request object, which is why this is an
 * AsyncLocalStorage rather than a parameter. Background work (workers,
 * webhooks) has no store and keeps using the connection saved on the project.
 */
export interface GitHubAuthorizationNotice {
  code: "github_authorization_required";
  reason: "no-token" | "missing-scope" | "token-rejected";
  message: string;
  requiredScopes: string[];
  grantedScopes: string[];
  /** Relative URL that starts the GitHub OAuth flow requesting write access. */
  authorizeUrl: string;
  login?: string;
}

interface GitHubRequestContext {
  userId?: string;
  signedInUserId?: string;
  authorization?: GitHubAuthorizationNotice;
}

const githubRequestContext = new AsyncLocalStorage<GitHubRequestContext>();

/** Signed-in user with a stored GitHub token for this request (if any). */
export function githubRequestActorId(): string | undefined {
  return githubRequestContext.getStore()?.userId;
}

/** Signed-in user for this request, whether or not a GitHub token is stored. */
export function githubRequestSignedInUserId(): string | undefined {
  const store = githubRequestContext.getStore();
  return store?.signedInUserId ?? store?.userId;
}

/** Run `fn` (Fastify `done`, or a test body) as this GitHub identity. */
export function runWithGitHubRequestActor<T>(userId: string, fn: () => T): T {
  return githubRequestContext.run({ userId, signedInUserId: userId }, fn);
}

/** Run `fn` with a full request context (the HTTP layer binds one per request). */
export function runWithGitHubRequestContext<T>(ctx: { userId?: string; signedInUserId?: string }, fn: () => T): T {
  return githubRequestContext.run({ ...ctx }, fn);
}

/** Remember that GitHub (write) authorization is required to finish this request. */
export function noteGitHubAuthorizationRequired(notice: GitHubAuthorizationNotice): void {
  const store = githubRequestContext.getStore();
  if (store && !store.authorization) store.authorization = notice;
}

/** The authorization notice recorded for this request, if any. */
export function pendingGitHubAuthorization(): GitHubAuthorizationNotice | undefined {
  return githubRequestContext.getStore()?.authorization;
}
