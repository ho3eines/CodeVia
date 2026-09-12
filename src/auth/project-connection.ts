import type { Project } from "../domain/entities.js";
import type { ProjectRepository } from "../domain/repos.js";
import type { KvStore } from "../db/kv.js";
import { describeUserGitHubToken, getUserGitHubToken } from "./github-tokens.js";
import { DEMO_USER_ID } from "./identity.js";
import { isServerGitHubEnabled } from "../github/registry.js";

/**
 * Bind a project's GitHub connection to the account that is actually using it.
 *
 * Why this matters: CodeVia state writes (creating/editing a workflow, agent,
 * skill, memory…) commit into the project's repository with whatever credential
 * is stored on the project. A project that was created pre-login, in mock/sim
 * mode, or with a stale/absent owner token can therefore be written with the
 * wrong credential — a server PAT or another account — which GitHub reports as
 * `404 Not Found` ("no access"). Read/browse routes already repaired this by
 * adopting the caller; the write path must do the same so "the account that
 * added the project is the account that writes it".
 *
 * Guardrails keep accounts separate:
 *   - Only the project's own owner (or a shared/demo project) is ever rebound;
 *     a foreign account can never steal another owner's live connection.
 *   - A working `user-oauth` connection is never reassigned to someone else.
 *   - A `server-token` connection is rebound onto the owner's OAuth token
 *     (`GITHUB_TOKEN` is login-only and must not write the owner's repos).
 *
 * Returns true when the stored connection was changed.
 */
export function adoptProjectConnection(deps: {
  kv: KvStore;
  projectRepo: Pick<ProjectRepository, "update">;
  project: Project;
  userId: string | undefined;
}): boolean {
  const { kv, projectRepo, project, userId } = deps;
  // Only the project's own owner — or a shared/demo (adoptable) project — may
  // drive it. A foreign account can never take over another owner's project.
  const ownerId = project.ownerId;
  const allowed = !userId || !ownerId || ownerId === DEMO_USER_ID || ownerId === userId;
  if (!allowed) return false;
  const current = project.githubConnection;
  // A working per-owner connection is already correct — never touch it.
  if (current?.kind === "user-oauth" && current.userId && getUserGitHubToken(kv, current.userId)) return false;
  // Without a caller or a caller token there is nothing to adopt to.
  if (!userId || !getUserGitHubToken(kv, userId)) return false;
  const login = describeUserGitHubToken(kv, userId).login;
  if (current?.kind === "user-oauth" && current.userId === userId && current.login === login) return false;
  const next: Project = { ...project, githubConnection: { kind: "user-oauth", userId, login } };
  try {
    projectRepo.update(next);
    return true;
  } catch {
    // Never fail the request over bookkeeping — the token above still works.
    return false;
  }
}

/**
 * Hand a whole stranded project to the connected account — owner AND
 * connection.
 *
 * A project is stranded when it predates GitHub login: it is owned by the
 * pre-login `user-demo` identity, or by nobody at all, and its connection is
 * dead (`mock`) or belongs to a token that no longer exists. Project lists and
 * every project route filter on `ownerId`, so such a project is invisible to
 * every signed-in account — and its background runs keep failing against a
 * credential nobody owns.
 *
 * This runs BEFORE the ownership gate (see `registerProjectStateHook` and the
 * `/projects/:id` routes): adopting after the gate is useless, because the
 * gate has already answered 404 for a project the caller is entitled to take.
 *
 * Guardrails — an account can only ever take a project nobody else is using:
 *   - the caller must be authenticated and hold a stored GitHub token,
 *   - a project owned by another real account is never touched,
 *   - a working `user-oauth` connection of another account is never stolen,
 *   - a `server-token` project keeps working while the server token is set.
 *
 * Returns the adopted project (already persisted) or `undefined` when there is
 * nothing to adopt.
 */
export function adoptStrandedProject(deps: {
  kv: KvStore;
  projectRepo: Pick<ProjectRepository, "update">;
  project: Project;
  userId: string | undefined;
}): Project | undefined {
  const { kv, projectRepo, project, userId } = deps;
  // Only a connected, signed-in account can take a project over.
  if (!userId || userId === DEMO_USER_ID || !getUserGitHubToken(kv, userId)) return undefined;
  const ownerId = project.ownerId;
  // Owned by another real account — never touch it.
  if (ownerId && ownerId !== DEMO_USER_ID && ownerId !== userId) return undefined;
  const connection = project.githubConnection;
  // A live connection of another account is not stranded.
  if (connection?.kind === "user-oauth" && connection.userId && connection.userId !== userId && getUserGitHubToken(kv, connection.userId)) return undefined;
  // A server-token project still works while GITHUB_TOKEN is configured.
  if (connection?.kind === "server-token" && isServerGitHubEnabled()) return undefined;
  const login = describeUserGitHubToken(kv, userId).login;
  const next: Project = { ...project, ownerId: userId, githubConnection: { kind: "user-oauth", userId, login } };
  try {
    projectRepo.update(next);
    return next;
  } catch {
    // Never fail the request over bookkeeping — the identity above still works.
    return next;
  }
}
