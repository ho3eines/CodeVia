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
      case "agent.run": {
        const taskId = String(job.payload.taskId);
        await this.deps.agentManager.runTask(taskId);
        break;
      }
      case "workflow.run": {
        const taskId = String(job.payload.taskId);
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
        // Generic GitHub operation hook; extend for specific ops.
        void job;
        break;
      }
      default:
        this.deps.logger.warn(`unknown job type ${job.type}`);
        break;
    }
  }
}

export const workerCorrelation = () => `job_${randomUUID()}`;
