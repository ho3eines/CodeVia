import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The signed-in user for the current HTTP request, when that user has a stored
 * GitHub OAuth token.
 *
 * Project file sync, conversation persist, and `readProject` all go through
 * `githubForProject(project)` with no request object. Interactive project
 * routes pass `requestUserId` explicitly; conversation/chat and the project
 * state hook historically did not, so a `server-token` project kept using
 * `GITHUB_TOKEN` (the OAuth-app / login PAT) against the owner's private
 * repos — GitHub 404, chat send 500.
 *
 * Background work (workers, webhooks) has no store and keeps using the
 * connection saved on the project.
 */
const githubRequestActor = new AsyncLocalStorage<string>();

export function githubRequestActorId(): string | undefined {
  return githubRequestActor.getStore();
}

/** Run `fn` (Fastify `done`, or a test body) as this GitHub identity. */
export function runWithGitHubRequestActor<T>(userId: string, fn: () => T): T {
  return githubRequestActor.run(userId, fn);
}
