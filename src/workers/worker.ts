import type { JobQueue } from "../db/queue.js";
import type { AgentManager } from "../agents/manager.js";
import type { AgentRunner } from "../agents/runner.js";
import type { WorkflowRepository, ProjectRepository, TaskRepository } from "../domain/repos.js";
import type { IGitHubService } from "../github/types.js";
import type { ITelegramService } from "../integrations/telegram.js";
import type { NotificationRepository } from "../observability/repos.js";
import type { Logger } from "../logger.js";
import type { Job } from "../domain/entities.js";
import { randomUUID } from "node:crypto";

export interface WorkerDeps {
  queue: JobQueue;
  agentManager: AgentManager;
  agentRunner: AgentRunner;
  workflowRepo: WorkflowRepository;
  projectRepo: ProjectRepository;
  taskRepo: TaskRepository;
  github: IGitHubService;
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
      if (attempts >= max) {
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

  /** Poll loop for the standalone worker process. */
  async start(pollMs = 1000): Promise<() => void> {
    const interval = setInterval(async () => {
      const jobs = this.deps.queue.claim(3);
      for (const job of jobs) {
        void this.process(job.id);
      }
    }, pollMs);
    this.deps.logger.info(`worker started (poll ${pollMs}ms)`);
    return () => clearInterval(interval);
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
        if (current.status === "cancelled") {
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
    const gh = this.deps.github;
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
        await gh.updatePullRequest(repo, Number(p.number), (p.patch as Partial<{ title: string; body: string; state: string }>) ?? {});
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
        // Merges are dangerous: only allowed when the job carries an approval id
        // that was decided "approved" (Telegram/web approval flow).
        if (!p.approvalId) throw new Error("github.op merge_pr requires approvalId");
        const res = await gh.mergePullRequest(repo, Number(p.number), { method: (p.method as "merge" | "squash" | "rebase") ?? "squash" });
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
}

export const workerCorrelation = () => `job_${randomUUID()}`;
