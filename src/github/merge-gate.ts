import type { Project } from "../domain/entities.js";
import type { GithubCheck, GithubRepoRef, IGitHubService } from "./types.js";

/**
 * Pre-merge verification gate — "test before applying".
 *
 * Every path that lands code on a base branch (the project page Merge button,
 * the approval-gated `merge_pull_request` tool, and the worker's `merge_pr`
 * job) runs this first. A merge is only allowed when GitHub CI for the pull
 * request's CURRENT head commit is green:
 *
 *   - at least one successful check/status, none failing, none pending,
 *   - every required check (`settings.metadata.requiredChecks` /
 *     `requiredChecksByRepo[repo]`) present and successful,
 *   - the head is the one that was reviewed (`expectedSha`, when given).
 *
 * The merge itself is then pinned to that head SHA, so a push that lands after
 * verification can never be merged under a stale green result.
 *
 * A repository without any CI can only be merged when the project explicitly
 * opts in (`settings.metadata.allowMergeWithoutCi = true`); failing or pending
 * checks always block. Simulation (mock GitHub) reports `simulated` and is
 * allowed, because nothing real is merged.
 */
export type MergeVerification = "passed" | "failed" | "pending" | "no-ci" | "simulated" | "unavailable";

export interface MergeGateResult {
  ok: boolean;
  verification: MergeVerification;
  repo: string;
  number: number;
  headSha?: string;
  checks: GithubCheck[];
  missing: string[];
  message: string;
}

function requiredChecksFor(project: Project | undefined, repoName: string): string[] {
  const metadata = project?.settings?.metadata as Record<string, unknown> | undefined;
  const byRepo = metadata?.requiredChecksByRepo;
  const value =
    byRepo && typeof byRepo === "object" && Object.hasOwn(byRepo, repoName)
      ? (byRepo as Record<string, unknown>)[repoName]
      : metadata?.requiredChecks;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v.trim()) : [];
}

export function allowsMergeWithoutCi(project: Project | undefined): boolean {
  const metadata = project?.settings?.metadata as Record<string, unknown> | undefined;
  return metadata?.allowMergeWithoutCi === true;
}

export async function verifyPullRequestBeforeMerge(opts: {
  github: IGitHubService;
  repo: GithubRepoRef;
  number: number;
  project?: Project;
  /** The head commit a human reviewed/approved; a moved head is refused. */
  expectedSha?: string;
}): Promise<MergeGateResult> {
  const { github, repo, number, project } = opts;
  const repoName = `${repo.owner}/${repo.name}`;
  const base = { repo: repoName, number, checks: [] as GithubCheck[], missing: [] as string[] };
  const result = (r: Omit<MergeGateResult, "repo" | "number" | "checks" | "missing"> & Partial<MergeGateResult>) => ({
    ...base,
    ...r,
  });

  if (!github.getPullRequest) {
    return result({
      ok: false,
      verification: "unavailable",
      message: `Cannot verify PR #${number}: the GitHub adapter cannot read pull requests.`,
    });
  }
  const pr = await github.getPullRequest(repo, number);
  if (!pr) {
    return result({
      ok: false,
      verification: "unavailable",
      message: `Cannot verify PR #${number} in ${repoName}: the pull request could not be read.`,
    });
  }
  if (pr.state && pr.state !== "open") {
    return result({
      ok: false,
      verification: "unavailable",
      headSha: pr.headSha,
      message: `PR #${number} is ${pr.state}; only open pull requests can be merged.`,
    });
  }
  const headSha = pr.headSha;
  if (opts.expectedSha && headSha && !headSha.toLowerCase().startsWith(opts.expectedSha.toLowerCase())) {
    return result({
      ok: false,
      verification: "unavailable",
      headSha,
      message: `PR #${number} moved to ${headSha.slice(0, 7)} after it was reviewed at ${opts.expectedSha.slice(0, 7)}; review and verify the new head first.`,
    });
  }
  if (github.kind === "mock") {
    return result({
      ok: true,
      verification: "simulated",
      headSha,
      message: `Simulation only: no build or tests were executed for PR #${number}.`,
    });
  }
  if (!headSha || !github.getChecks) {
    return result({
      ok: false,
      verification: "unavailable",
      headSha,
      message: `Cannot verify PR #${number}: CI results for its head commit are unavailable.`,
    });
  }
  const checks = await github.getChecks(repo, headSha);
  const required = requiredChecksFor(project, repoName);
  const failed = checks.filter((c) => c.status === "failure");
  const pending = checks.filter((c) => c.status === "pending");
  const missing = required.filter((name) => !checks.some((c) => c.name === name && c.status === "success"));
  const succeeded = checks.some((c) => c.status === "success");
  const summary = checks.length
    ? checks.map((c) => `${c.name}: ${c.status}`).join(", ")
    : "no CI checks reported for this commit";
  const short = headSha.slice(0, 7);
  if (failed.length) {
    return result({
      ok: false,
      verification: "failed",
      headSha,
      checks,
      missing,
      message: `CI failed for PR #${number} @ ${short} (${failed.map((c) => c.name).join(", ")}). Fix the failures before merging.`,
    });
  }
  if (pending.length || (missing.length && checks.length)) {
    return result({
      ok: false,
      verification: "pending",
      headSha,
      checks,
      missing,
      message: `CI has not finished for PR #${number} @ ${short}${missing.length ? ` (required: ${missing.join(", ")})` : ""}. Wait for the checks to pass, then merge. [${summary}]`,
    });
  }
  if (!succeeded || missing.length) {
    const allowed = allowsMergeWithoutCi(project) && missing.length === 0;
    return result({
      ok: allowed,
      verification: "no-ci",
      headSha,
      checks,
      missing,
      message: allowed
        ? `No CI ran for PR #${number} @ ${short}; merging is allowed because this project opted in (allowMergeWithoutCi).`
        : `No passing CI for PR #${number} @ ${short}${missing.length ? ` (required: ${missing.join(", ")})` : ""}: changes must be tested before they are applied. Add a GitHub Actions build/test workflow, or explicitly allow merging without CI in the project settings.`,
    });
  }
  return result({
    ok: true,
    verification: "passed",
    headSha,
    checks,
    missing,
    message: `CI passed for PR #${number} @ ${short}: ${summary}.`,
  });
}
