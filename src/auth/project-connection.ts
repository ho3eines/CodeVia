import type { Project } from "../domain/entities.js";
import type { ProjectRepository } from "../domain/repos.js";
import type { KvStore } from "../db/kv.js";
import { describeUserGitHubToken, getUserGitHubToken } from "./github-tokens.js";
import { DEMO_USER_ID } from "./identity.js";

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
