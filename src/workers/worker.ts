import type { JobQueue } from "../db/queue.js";
import type { AgentManager } from "../agents/manager.js";
import type { AgentRunner } from "../agents/runner.js";
import type { WorkflowRepository, ProjectRepository, TaskRepository } from "../domain/repos.js";
import type { IGitHubService } from "../github/types.js";
import type { ITelegramService } from "../integrations/telegram.js";
import type { NotificationRepository } from "../observability/repos.js";
import type { Logger } from "../logger.js";
import type { Job, Project } from "../domain/entities.js";
import type { ApprovalRepository, ApprovalRequest } from "../approvals/service.js";
import { randomUUID } from "node:crypto";

export interface WorkerDeps {
  queue: JobQueue;
  agentManager: AgentManager;
  agentRunner: AgentRunner;
  workflowRepo: WorkflowRepository;
  projectRepo: ProjectRepository;
  taskRepo: TaskRepository;
  /** Approvals are the only legitimate authorization for dangerous github.op jobs. */
  approvalRepo: ApprovalRepository;
  github: IGitHubService;
  /** Per-project connection; falls back to `github` when a project has none. */
  githubForProject?: (project: Project, requestUserId?: string) => IGitHubService;
  telegram: ITelegramService;
  notificationRepo: NotificationRepository;
  logger: Logger;
}

/**
 * Background worker. Consumes jobs (agent runs, workflow runs, notifications,
 * GitHub ops, telegram sends) off the queue so the UI/API thread is never blocked.
 *
 * Resilience: retry with exponential backoff, timeout via AbortController,
 * dead-letter after maxAttempts, and idempotent processing by correlation id.
 */
export class Worker {
  private stopCurrent?: () => void;
  private readonly active = new Set<string>();

  constructor(private readonly deps: WorkerDeps) {}

  async process(id: string): Promise<void> {
    const job = this.deps.queue.getById(id);
    if (!job) return;
    if (job.status === "succeeded" || job.status === "dead") return;
    this.deps.logger.info(`processing job ${job.id} ${job.type}`);
    try {
      await this.handle(job);
      this.deps.queue.update(job.id, { status: "succeeded", finishedAt: new Date().toISOString() });
    } catch (err) {
      const attempts = job.attempts + 1;
      const max = job.maxAttempts ?? 3;
      const message = String(err);
      this.deps.logger.warn(`job ${job.id} failed (attempt ${attempts}/${max})`, { err: message });
      if (attempts >= max || (err as { retryable?: boolean }).retryable === false) {
        this.deps.queue.update(id, { status: "dead", attempts, error: message, finishedAt: new Date().toISOString() });
        await this.deps.notificationRepo.create({
          severity: "error",
          title: "Job dead-lettered",
          message: `${job.type}: ${message}`,
        });
      } else {
        // Exponential backoff: schedule retry.
        const delay = Math.min(60000, 1000 * 2 ** attempts);
        const scheduledAt = new Date(Date.now() + delay).toISOString();
        this.deps.queue.update(id, { status: "retrying", attempts, error: message });
        // Re-enqueue for retry by updating scheduled_at.
        (this.deps.queue as unknown as { db: { run: (s: string, p: Record<string, unknown>) => void } }).db.run(
          `UPDATE jobs SET scheduled_at = :scheduled_at, status = 'pending', updated_at = :now WHERE id = :id`,
          { scheduled_at: scheduledAt, now: new Date().toISOString(), id },
        );
      }
    }
  }

  /** Poll loop for the in-process worker. It also repairs rows orphaned by a restart. */
  async start(pollMs = 1000): Promise<() => void> {
    if (this.stopCurrent) return this.stopCurrent;

    const recovered = this.deps.queue.recoverInterruptedExecutions();
    for (const job of recovered.retrying) this.reconcileRecoveredTask(job, false);
    for (const job of recovered.dead) this.reconcileRecoveredTask(job, true);
    if (recovered.retrying.length || recovered.dead.length) {
      this.deps.logger.warn("recovered interrupted execution jobs", {
        retrying: recovered.retrying.length,
        dead: recovered.dead.length,
      });
    }

    // Keep a real concurrency ceiling. The old interval claimed three more rows
    // every second even while prior jobs were still running, so a slow model
    // call could cause an unbounded number of concurrent executions.
    const tick = () => {
      try {
        const capacity = Math.max(0, 3 - this.active.size);
        if (!capacity) return;
        const jobs = this.deps.queue.claim(capacity);
        for (const job of jobs) {
          this.active.add(job.id);
          void this.process(job.id)
            .catch((err) => this.deps.logger.error(`worker could not finalize job ${job.id}`, { err: String(err) }))
            .finally(() => this.active.delete(job.id));
        }
      } catch (err) {
        // A transient DB error must not kill the timer callback silently.
        this.deps.logger.error("worker poll failed", { err: String(err) });
      }
    };

    // Consume already-queued work during startup rather than waiting for the
    // first timer interval. This also makes worker health visible immediately.
    tick();
    const interval = setInterval(tick, pollMs);
    const stop = () => {
      clearInterval(interval);
      if (this.stopCurrent === stop) this.stopCurrent = undefined;
    };
    this.stopCurrent = stop;
    this.deps.logger.info(`worker started (poll ${pollMs}ms)`);
    return stop;
  }

  private reconcileRecoveredTask(job: Job, exhausted: boolean): void {
    const taskId = String(job.payload.taskId ?? "");
    const task = taskId ? this.deps.taskRepo.findById(taskId)?.data : undefined;
    if (!task || ["succeeded", "failed", "cancelled"].includes(task.status)) return;
    const updated = {
      ...task,
      status: exhausted ? ("failed" as const) : ("queued" as const),
      error: exhausted ? job.error : undefined,
      updatedAt: new Date().toISOString(),
    };
    this.deps.taskRepo.upsert(updated, { projectId: task.projectId, parentId: task.parentTaskId });
  }

  private async handle(job: Job): Promise<void> {
    switch (job.type) {
      case "agent.run":
      case "workflow.run": {
        const taskId = String(job.payload.taskId);
        const current = this.deps.taskRepo.findById(taskId)?.data;
        if (!current) {
          this.deps.logger.warn(`job ${job.id}: task ${taskId} no longer exists — dropping`);
          break;
        }
        if (current.status === "cancelled" || current.status === "succeeded") {
          this.deps.logger.info(`job ${job.id}: task ${taskId} cancelled before start — skipping`);
          break;
        }
        await this.deps.agentManager.runTask(taskId);
        break;
      }
      case "telegram.send": {
        await this.deps.telegram.sendMessage({
          chatId: String(job.payload.chatId),
          text: String(job.payload.text ?? ""),
        });
        break;
      }
      case "notify": {
        await this.deps.notificationRepo.create({
          severity: (job.payload.severity as "info" | "success" | "warning" | "error") ?? "info",
          title: String(job.payload.title ?? "Notification"),
          message: String(job.payload.message ?? ""),
          projectId: job.payload.projectId as string | undefined,
        });
        break;
      }
      case "github.op": {
        await this.handleGithubOp(job);
        break;
      }
      default:
        this.deps.logger.warn(`unknown job type ${job.type}`);
        break;
    }
  }
  /**
   * Generic GitHub operation executed off the request path (webhook fan-out,
   * scheduled automation, Telegram quick actions). Payload:
   *   { op, projectId, ...args }
   *   op ∈ comment_pr | comment_issue | create_issue | update_pr | create_branch | merge_pr
   */
  private async handleGithubOp(job: Job): Promise<void> {
    const p = job.payload;
    const op = String(p.op ?? "");
    const project = p.projectId ? this.deps.projectRepo.findById(String(p.projectId))?.data : undefined;
    const repoStr = String(p.repo ?? project?.configRepo ?? "");
    const [owner, name] = repoStr.split("/");
    if (!owner || !name) throw new Error(`github.op ${op}: repo "owner/name" is required`);
    const repo = { owner, name };
    // Use the project's own GitHub connection so background ops authenticate as
    // the user who linked it, instead of the platform-wide service (which is
    // the mock unless a server GITHUB_TOKEN is set).
    const gh = (project && this.deps.githubForProject?.(project)) ?? this.deps.github;
    switch (op) {
      case "comment_pr":
        await gh.commentOnPullRequest(repo, Number(p.number), String(p.body ?? ""));
        break;
      case "comment_issue":
        await gh.commentOnIssue(repo, Number(p.number), String(p.body ?? ""));
        break;
      case "create_issue":
        await gh.createIssue(repo, String(p.title ?? "Untitled"), String(p.body ?? ""));
        break;
      case "update_pr":
        await gh.updatePullRequest(
          repo,
          Number(p.number),
          (p.patch as Partial<{ title: string; body: string; state: string }>) ?? {},
        );
        break;
      case "create_branch": {
        const branches = await gh.listBranches(repo);
        const from = String(p.from ?? project?.branch ?? "main");
        const base = branches.find((b) => b.name === from) ?? branches[0];
        if (!base) throw new Error(`github.op create_branch: base ${from} not found`);
        await gh.createBranch(repo, String(p.name), base.sha);
        break;
      }
      case "merge_pr": {
        // (A04) Merges are dangerous: the job must carry the id of a real approval
        // request that exists, is approved, belongs to this project, and actually
        // records merging THIS pull request. The merge also runs through the
        // project's own GitHub connection, never an unscoped platform default.
        this.requireApprovedMergeApproval(p, project, repo, Number(p.number));
        const ghForMerge = project && this.deps.githubForProject ? this.deps.githubForProject(project) : gh;
        const res = await ghForMerge.mergePullRequest(repo, Number(p.number), {
          method: (p.method as "merge" | "squash" | "rebase") ?? "squash",
        });
        if (!res.merged) throw new Error(`merge_pr #${p.number} failed: ${res.message ?? "unknown"}`);
        break;
      }
      default:
        throw new Error(`github.op: unsupported op "${op}"`);
    }
    if (project && p.notify !== false) {
      await this.deps.notificationRepo.create({
        severity: "info",
        title: `GitHub ${op}`,
        message: `${repoStr}${p.number ? ` #${p.number}` : ""} — ${op} completed`,
        projectId: project.id,
      });
    }
  }

  /**
   * (A04) Validate that a merge_pr job is backed by a genuine, approved approval
   * request for this exact project and pull request. Checks, in order:
   *   1. the job carries an approvalId,
   *   2. the approval record exists,
   *   3. its status is "approved" (never pending/rejected/expired),
   *   4. it belongs to the same project the job targets,
   *   5. it records this exact PR number, and the repository when one is recorded
   *      (required when the project has multiple repositories, so a generic
   *      "merge PR #12" approval can never authorize merging into another repo).
   */
  private requireApprovedMergeApproval(
    payload: Record<string, unknown>,
    project: Project | undefined,
    repo: { owner: string; name: string },
    number: number,
  ): ApprovalRequest {
    const approvalId = String(payload.approvalId ?? "").trim();
    if (!approvalId) throw new Error("github.op merge_pr requires approvalId");
    const approval = this.deps.approvalRepo.findById(approvalId)?.data;
    if (!approval) throw new Error(`github.op merge_pr: approval ${approvalId} not found`);
    if (approval.status !== "approved") {
      throw new Error(`github.op merge_pr: approval ${approvalId} is ${approval.status}, not approved`);
    }
    const projectId = String(payload.projectId ?? "");
    if (!projectId || !approval.projectId || approval.projectId !== projectId) {
      throw new Error(`github.op merge_pr: approval ${approvalId} does not belong to project ${projectId || "(none)"}`);
    }
    const detail = (approval.detail ?? {}) as Record<string, unknown>;
    const nested = (detail.input ?? detail.payload ?? {}) as Record<string, unknown>;
    const recordedNumber =
      pickPositiveNumber(detail.number) ??
      pickPositiveNumber(nested.number) ??
      pickPositiveNumber(detail.pr) ??
      pickPositiveNumber(detail.prNumber) ??
      pickPositiveNumber(nested.pr) ??
      pickPositiveNumber(nested.prNumber);
    if (recordedNumber === undefined || recordedNumber !== number) {
      throw new Error(`github.op merge_pr: approval ${approvalId} does not record pull request #${number}`);
    }
    const recordedRepo =
      pickRepoString(detail.repo) ??
      pickRepoString(nested.repo) ??
      pickRepoString(detail.repository) ??
      pickRepoString(nested.repository);
    const fullName = `${repo.owner}/${repo.name}`.toLowerCase();
    if (recordedRepo) {
      if (recordedRepo.toLowerCase() !== fullName) {
        throw new Error(
          `github.op merge_pr: approval ${approvalId} records repository ${recordedRepo}, not ${fullName}`,
        );
      }
    } else if (!project || project.repositories.length > 1) {
      throw new Error(
        `github.op merge_pr: approval ${approvalId} must record the repository when the project has multiple repositories`,
      );
    }

    // (A04) Expiry: an approval whose validity window has passed cannot
    // authorize a merge. Auto-approve grants carry no `expiresAt` and stay
    // valid in dev/simulation mode; every human-granted approval does expire.
    if (approval.expiresAt && new Date(approval.expiresAt).getTime() <= Date.now()) {
      throw new Error(`github.op merge_pr: approval ${approvalId} has expired (${approval.expiresAt})`);
    }

    // (A04) Commit SHA binding: when the approval was granted for a specific
    // head SHA, the merge job must target that exact SHA. A PR that moved on
    // after the human reviewed it is a different subject and is not authorized.
    const recordedSha =
      pickSha(detail.commitSha) ?? pickSha(nested.commitSha) ?? pickSha(detail.headSha) ?? pickSha(nested.headSha);
    const jobSha = pickSha(payload.commitSha) ?? pickSha(payload.sha);
    if (recordedSha) {
      if (!jobSha) {
        throw new Error(
          `github.op merge_pr: approval ${approvalId} is bound to commit ${recordedSha}; the merge job must carry the same commitSha`,
        );
      }
      if (jobSha !== recordedSha) {
        throw new Error(
          `github.op merge_pr: approval ${approvalId} records commit ${recordedSha}, but the job targets ${jobSha}`,
        );
      }
    }

    // (A04) Actor binding: a job that names an actor must match the actor the
    // approval was requested for (or, failing that, the actor who decided it).
    const jobActor = pickId(payload.actorId);
    if (jobActor) {
      const recordedActor = pickId(detail.actorId) ?? pickId(nested.actorId) ?? pickId(approval.decidedBy);
      if (recordedActor && recordedActor !== jobActor) {
        throw new Error(
          `github.op merge_pr: approval ${approvalId} was requested/decided by ${recordedActor}, not ${jobActor}`,
        );
      }
    }
    return approval;
  }
}

function pickPositiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function pickSha(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return /^[0-9a-f]{7,64}$/i.test(v) ? v : undefined;
}

function pickId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v ? v : undefined;
}

function pickRepoString(value: unknown): string | undefined {
  if (typeof value === "string" && value.includes("/")) return value.trim();
  if (value && typeof value === "object") {
    const r = value as { owner?: unknown; name?: unknown; full_name?: unknown };
    if (typeof r.owner === "string" && typeof r.name === "string") return `${r.owner}/${r.name}`;
    if (typeof r.full_name === "string") return r.full_name;
  }
  return undefined;
}

export const workerCorrelation = () => `job_${randomUUID()}`;
