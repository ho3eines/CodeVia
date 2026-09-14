import type { GithubRepoRef, GithubTreeEntry, IGitHubService } from "./types.js";
import { GitHubAuthError } from "./real-service.js";

/**
 * Shared read-side resolution for repository listings.
 *
 * Two real-world failure classes used to surface as "the AI silently knows
 * nothing about the repo" (and the model then invented excuses such as a
 * made-up 404):
 *
 *  1. The project stores a stale branch (`main`) while the repository's
 *     default branch has another name (`master`, `develop`…). GitHub answers
 *     404 for the unknown ref, indistinguishable from a missing repo.
 *  2. The credential in use cannot see the repository (expired OAuth token,
 *     missing `repo` scope, server PAT for a private user repo).
 *
 * `listRepoPaths` heals class 1 automatically (retry once with the real
 * default branch) and reports class 2 with its exact cause so surfaces like
 * the project chat can state facts instead of guessing.
 */

export type RepoReadFailure = "repo-not-found" | "branch-not-found" | "auth" | "forbidden" | "timeout" | "error";

export interface RepoListing {
  ok: boolean;
  /** Blob paths (directories excluded). Empty when the repo is empty/unreadable. */
  paths: string[];
  /** The branch actually read (may differ from the requested one after fallback). */
  branch: string;
  /** Whether the default-branch fallback kicked in. */
  fellBackToDefault: boolean;
  /** Total blob count, when known. */
  totalFiles: number;
  failure?: RepoReadFailure;
  /** Human-readable cause, safe to show to the user / feed to the model. */
  failureDetail?: string;
}

function classify(err: unknown, branch: string): { failure: RepoReadFailure; detail: string } {
  if (err instanceof GitHubAuthError) {
    return err.status === 403
      ? { failure: "forbidden", detail: `GitHub rejected the credential with 403 (${branch})` }
      : { failure: "auth", detail: `GitHub rejected the credential with 401 (${branch})` };
  }
  const status = (err as { status?: number })?.status;
  const msg = err instanceof Error ? err.message : String(err);
  if (status === 404) return { failure: "branch-not-found", detail: `GitHub 404 for ref "${branch}"` };
  if (status === 403) return { failure: "forbidden", detail: `GitHub 403 for ref "${branch}"` };
  if (status === 401) return { failure: "auth", detail: `GitHub 401 for ref "${branch}"` };
  if (/timeout|aborted|ETIMEDOUT|ECONNRESET/i.test(msg)) return { failure: "timeout", detail: msg };
  return { failure: "error", detail: msg };
}

/**
 * List the repository's blob paths, healing a stale configured branch by
 * retrying once with the repository's real default branch. Never throws —
 * every failure is captured in the result so callers decide how to surface it.
 */
export async function listRepoPaths(
  github: IGitHubService,
  repo: GithubRepoRef,
  branch: string | undefined,
): Promise<RepoListing> {
  const wanted = branch || "main";
  const attempt = async (ref: string): Promise<GithubTreeEntry[]> => github.listFiles(repo, ref);

  let entries: GithubTreeEntry[];
  try {
    entries = await attempt(wanted);
  } catch (err) {
    const first = classify(err, wanted);
    // A 404 can be "repo missing" OR "branch missing" — only the repository
    // metadata endpoint can tell them apart. Heal the branch case silently.
    if (first.failure === "branch-not-found" && github.getRepository) {
      try {
        const info = await github.getRepository(repo);
        if (!info) return { ...empty(wanted), failure: "repo-not-found", failureDetail: first.detail };
        if (info.defaultBranch && info.defaultBranch !== wanted) {
          try {
            entries = await attempt(info.defaultBranch);
            return toListing(entries, info.defaultBranch, true);
          } catch (err2) {
            const second = classify(err2, info.defaultBranch);
            return { ...empty(info.defaultBranch), failure: second.failure, failureDetail: second.detail };
          }
        }
      } catch {
        /* metadata lookup failed — report the original listing failure */
      }
    }
    return { ...empty(wanted), failure: first.failure, failureDetail: first.detail };
  }
  return toListing(entries, wanted, false);
}

function toListing(entries: GithubTreeEntry[], branch: string, fellBackToDefault: boolean): RepoListing {
  const blobs = entries.filter((e) => e.type === "blob").filter((e) => !e.path.startsWith(".git/"));
  return {
    ok: true,
    paths: blobs.map((e) => e.path),
    branch,
    fellBackToDefault,
    totalFiles: blobs.length,
  };
}

function empty(branch: string): RepoListing {
  return { ok: false, paths: [], branch, fellBackToDefault: false, totalFiles: 0 };
}

/**
 * Factual, instruction-carrying note for when the repository could not be
 * read. Feeding the model the real cause (instead of nothing) stops it from
 * fabricating errors and makes the chat answer with the exact fix.
 */
export function repoUnreadableNote(input: {
  repo: string;
  branch: string;
  failure: RepoReadFailure;
  detail?: string;
}): string {
  const fixes: Record<RepoReadFailure, string> = {
    "repo-not-found":
      "the repository does not exist or is not visible to the connected GitHub account. Fix: check the repository name in the project settings, or reconnect GitHub with an account that has access.",
    "branch-not-found": `branch "${input.branch}" was not found and the default branch could not be read either. Fix: correct the project's branch setting.`,
    auth: "the stored GitHub credential was rejected (expired or revoked). Fix: log out and log in with GitHub again to refresh the connection.",
    forbidden:
      "the stored GitHub credential lacks permission for this repository (missing `repo` scope for a private repo). Fix: reconnect GitHub with the full scope.",
    timeout: "GitHub did not respond in time. Fix: retry in a moment; the connection itself is configured correctly.",
    error: `an unexpected error occurred${input.detail ? ` (${String(input.detail).slice(0, 160)})` : ""}.`,
  };
  return [
    `Repository status: ${input.repo} could NOT be read by the platform right now — ${fixes[input.failure]}`,
    "No file tree, README or source of this repository was available for this answer.",
    "HARD RULE: do not guess, invent or assume anything about the repository's files, structure or errors, and do not claim any specific HTTP error unless it is quoted above. Tell the user honestly that the repository is currently unreadable, relay the exact cause and fix above, and offer to continue once the connection/repo is fixed.",
  ].join("\n");
}
