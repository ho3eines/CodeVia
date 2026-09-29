import type { Project } from "../domain/entities.js";
import type { IGitHubService } from "./types.js";
import { parseRepoFullName } from "./types.js";
import { githubAuthorizationRequired, GITHUB_WRITE_SCOPE, isGitHubAuthorizationRequired } from "./authorization.js";

/**
 * "Can CodeVia apply changes to this project as this user?"
 *
 * Checked BEFORE an agent task / workflow starts spending model budget, so the
 * user is asked for write access up front instead of learning at the very end
 * (after research and implementation) that the commit was rejected:
 *
 *   1. The token itself may write: OAuth tokens report their scopes in
 *      `x-oauth-scopes`; `repo` writes everything, `public_repo` only public
 *      repositories. Tokens without a scope header (GitHub App / fine-grained
 *      tokens) are judged by the repository permission alone.
 *   2. The account may push to every linked repository (`permissions.push`).
 *
 * A missing scope raises `GitHubAuthorizationRequiredError` (the SPA then asks
 * for write access automatically). A missing push permission cannot be fixed
 * by re-authorizing — it is reported per repository so the owner can add the
 * account as a collaborator.
 */
export interface RepoWriteAccess {
  repo: string;
  readable: boolean;
  canPush: boolean;
  private?: boolean;
  error?: string;
}

export interface ProjectWriteAccess {
  ok: boolean;
  login?: string;
  scopes: string[];
  simulated: boolean;
  repos: RepoWriteAccess[];
  problem?: string;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: ProjectWriteAccess }>();

export function clearWriteAccessCache(): void {
  cache.clear();
}

export async function checkProjectWriteAccess(opts: {
  github: IGitHubService;
  project: Project;
  /** Cache key scope (the acting account); omit to skip caching. */
  cacheScope?: string;
}): Promise<ProjectWriteAccess> {
  const { github, project } = opts;
  const repoNames = (project.repositories?.length ? project.repositories.map((r) => r.repo) : [project.configRepo])
    .filter((r): r is string => typeof r === "string" && !!r)
    .filter((r, i, all) => all.indexOf(r) === i);
  if (github.kind === "mock") return { ok: true, scopes: [], simulated: true, repos: [] };

  const key = opts.cacheScope ? `${opts.cacheScope}|${repoNames.join(",")}` : undefined;
  const hit = key ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const viewer = await github.getViewer();
  const scopes = viewer.scopes ?? [];
  const scopeKnown = scopes.length > 0;
  const repos: RepoWriteAccess[] = [];
  for (const name of repoNames) {
    const ref = parseRepoFullName(name);
    if (!ref) {
      repos.push({ repo: name, readable: false, canPush: false, error: "invalid repository name" });
      continue;
    }
    try {
      const info = github.getRepository ? await github.getRepository(ref) : undefined;
      if (!info) {
        repos.push({ repo: name, readable: false, canPush: false, error: "not found or not visible to this account" });
        continue;
      }
      const tokenMayWrite =
        !scopeKnown || scopes.includes(GITHUB_WRITE_SCOPE) || (scopes.includes("public_repo") && !info.private);
      repos.push({
        repo: name,
        readable: true,
        private: info.private,
        canPush: tokenMayWrite && info.permissions?.push !== false,
        ...(tokenMayWrite ? {} : { error: "token lacks the 'repo' scope" }),
      });
    } catch (err) {
      if (isGitHubAuthorizationRequired(err)) throw err;
      repos.push({
        repo: name,
        readable: false,
        canPush: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const scopeBlocked = repos.some((r) => r.error === "token lacks the 'repo' scope");
  // Private repositories hidden from a token without `repo` look "not found".
  const hiddenByScope = scopeKnown && !scopes.includes(GITHUB_WRITE_SCOPE) && repos.some((r) => !r.readable);
  if (scopeBlocked || hiddenByScope) {
    throw githubAuthorizationRequired({ reason: "missing-scope", grantedScopes: scopes, login: viewer.login });
  }
  const blocked = repos.filter((r) => !r.canPush);
  const value: ProjectWriteAccess = {
    ok: blocked.length === 0,
    login: viewer.login,
    scopes,
    simulated: false,
    repos,
    ...(blocked.length
      ? {
          problem: `GitHub account ${viewer.login} cannot push to ${blocked
            .map((r) => `${r.repo}${r.error ? ` (${r.error})` : ""}`)
            .join(
              ", ",
            )}. Ask the repository owner to grant write access (collaborator), or connect the account that owns it.`,
        }
      : {}),
  };
  if (key) cache.set(key, { at: Date.now(), value });
  return value;
}
