import { setTimeout as delay } from "node:timers/promises";
import type { ToolContext, ToolResult } from "./types.js";
import { parseRepoFullName } from "../github/types.js";
import { BudgetExceededError, TaskCancelledError } from "../agents/execution.js";

/** Verify the exact feature-branch commit in GitHub CI, never shell out on the platform host. */
export async function verifyGithubChecks(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const repoName = String(input.repo ?? ctx.project.configRepo);
  const ref = String(input.ref ?? input.branch ?? ctx.project.branch);
  const unverified = (output: string, data: Record<string, unknown> = {}): ToolResult => ({
    ok: false,
    output,
    data: { verification: "unverified", fixable: false, repo: repoName, ref, ...data },
  });
  if (input.command !== undefined || input.cwd !== undefined)
    return unverified(
      "Host shell execution is disabled. Configure build/test commands in the project's GitHub CI workflow and supply a ref.",
    );
  const repo = parseRepoFullName(repoName);
  if (!repo || !(repoName === ctx.project.configRepo || ctx.project.repositories?.some((r) => r.repo === repoName)))
    return unverified("CI repository must be linked to this project");
  try {
    ctx.checkActive?.();
    const branchHead = async () => (await ctx.github.listBranches(repo)).find((branch) => branch.name === ref)?.sha;
    const head = await branchHead();
    const sha = head ?? (/^[a-f0-9]{40}$/i.test(ref) ? ref : undefined);
    if (!sha) return unverified(`Verification ref not found: ${ref}`);
    if (input.expectedSha !== undefined && input.expectedSha !== sha)
      return unverified("Working branch changed since implementation; inspect the new HEAD before verification", {
        sha,
      });
    if (ctx.github.kind === "mock")
      return {
        ok: true,
        output: `Simulation only: no build or tests were executed for ${repoName}@${ref}. Real verification requires GitHub CI.`,
        data: { verification: "simulated", repo: repoName, ref, sha, checks: [] },
      };
    if (!ctx.github.getChecks) return unverified("GitHub adapter cannot supply CI evidence", { sha });
    const configured = Number(input.waitMs ?? ctx.project.settings.metadata?.ciWaitMs ?? 60_000);
    const waitMs = Number.isFinite(configured) ? Math.max(0, Math.min(90_000, configured)) : 60_000;
    const deadline = Date.now() + waitMs;
    const metadata = ctx.project.settings.metadata;
    const byRepo = metadata?.requiredChecksByRepo;
    const requiredValue =
      byRepo && typeof byRepo === "object" && Object.hasOwn(byRepo, repoName)
        ? (byRepo as Record<string, unknown>)[repoName]
        : metadata?.requiredChecks;
    if (
      requiredValue !== undefined &&
      (!Array.isArray(requiredValue) || requiredValue.some((v) => typeof v !== "string" || !v.trim()))
    )
      return unverified("Required CI checks must be an array of nonempty check names", { sha });
    const required = (requiredValue ?? []) as string[];
    for (;;) {
      ctx.checkActive?.();
      const checks = await ctx.github.getChecks(repo, sha);
      ctx.checkActive?.();
      const failed = checks.filter((c) => c.status === "failure");
      const missing = required.filter((name) => !checks.some((c) => c.name === name && c.status === "success"));
      const detail = checks
        .map((c) => `${c.name}: ${c.status}${c.detail ? ` — ${c.detail}` : ""}${c.url ? ` (${c.url})` : ""}`)
        .join("\n");
      const passed =
        checks.some((c) => c.status === "success") &&
        !checks.some((c) => c.status === "pending") &&
        missing.length === 0;
      if (failed.length || passed) {
        // A green old commit must not attest a newer, uninspected branch HEAD.
        if (head && (await branchHead()) !== sha)
          return unverified(
            "Working branch changed while CI was running; previous check results no longer attest its HEAD",
            { sha, checks },
          );
        ctx.checkActive?.();
        return {
          ok: !failed.length,
          output: `GitHub CI ${failed.length ? "failed" : "passed"} for ${repoName}@${sha}:\n${detail}`,
          data: {
            verification: failed.length ? "failed" : "passed",
            fixable: failed.length > 0,
            repo: repoName,
            ref,
            sha,
            checks,
          },
        };
      }
      if (Date.now() >= deadline)
        return unverified(
          `Not verified: CI is missing, pending or skipped for ${repoName}@${sha}.${missing.length ? ` Required checks: ${missing.join(", ")}.` : ""} Configure/finish GitHub build and test workflows, then retry.\n${detail}`,
          { sha, checks },
        );
      await delay(Math.min(2000, Math.max(1, deadline - Date.now())));
    }
  } catch (err) {
    if (err instanceof TaskCancelledError || err instanceof BudgetExceededError) throw err;
    // Authentication, network and API failures are infrastructure errors, not
    // evidence of faulty generated code. Never start a code-fix loop for them.
    return unverified(`Unable to read CI evidence: ${String(err)}`);
  }
}
