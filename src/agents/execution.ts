import type { Agent, Budget, Project, Task } from "../domain/entities.js";
import type { TaskRepository } from "../domain/repos.js";

export class TaskCancelledError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} was cancelled`);
    this.name = "TaskCancelledError";
  }
}

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  readonly retryable = false;
  constructor(message: string) {
    super(`Budget exceeded: ${message}`);
    this.name = "BudgetExceededError";
  }
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
  modelId?: string;
}

export const emptyUsage = (): ModelUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 });

/** One ledger for an entire task, including research, code generation and fixes. */
export class ExecutionBudget {
  readonly usage = emptyUsage();
  readonly startedAt = Date.now();
  constructor(private readonly limits: Partial<Budget> = {}) {}

  check(): void {
    const over = (label: string, value: number, limit: number | undefined) => {
      if (limit && limit > 0 && value > limit) throw new BudgetExceededError(`${label} ${value} exceeds ${limit}`);
    };
    over("tokens", this.usage.totalTokens, this.limits.maxTokensPerRun);
    over("cost", this.usage.costUsd, this.limits.maxCostUsdPerRun);
    over("model calls", this.usage.calls, this.limits.maxCallsPerRun);
    over("duration", Date.now() - this.startedAt, this.limits.maxDurationMs);
  }

  /**
   * Multi-run executions (workflows, autonomous loops) share one task ledger,
   * while maxTokensPerRun / maxCallsPerRun / maxCostUsdPerRun cap a SINGLE
   * agent run. Scale the aggregate limits by the number of planned runs so a
   * legitimate N-run task is not strangled by a single-run cap (found live:
   * the seeded 6-agent workflow exhausted the default 20k-token task budget
   * at its last node). Usage already recorded carries over; the wall-clock
   * duration limit is never scaled.
   */
  scaledForRuns(runs: number): ExecutionBudget {
    const factor = Math.max(1, Math.floor(runs) || 1);
    const scaled = new ExecutionBudget({
      ...this.limits,
      maxTokensPerRun: this.limits.maxTokensPerRun ? this.limits.maxTokensPerRun * factor : undefined,
      maxCallsPerRun: this.limits.maxCallsPerRun ? this.limits.maxCallsPerRun * factor : undefined,
      maxCostUsdPerRun: this.limits.maxCostUsdPerRun ? this.limits.maxCostUsdPerRun * factor : undefined,
    });
    Object.assign(scaled.usage, this.usage);
    return scaled;
  }

  remainingTokens(): number {
    return this.limits.maxTokensPerRun && this.limits.maxTokensPerRun > 0
      ? Math.max(0, this.limits.maxTokensPerRun - this.usage.totalTokens)
      : Infinity;
  }

  beginCall(): void {
    this.check();
    if (this.limits.maxCallsPerRun && this.usage.calls >= this.limits.maxCallsPerRun) {
      throw new BudgetExceededError(`model calls reached ${this.limits.maxCallsPerRun}`);
    }
    this.usage.calls += 1;
  }

  add(usage: Omit<ModelUsage, "calls">): void {
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.totalTokens += usage.totalTokens;
    this.usage.costUsd += usage.costUsd;
    this.usage.modelId = usage.modelId;
    this.check();
  }
}

/** Per-agent run limits, nested inside the parent task's ledger. */
export function runBudget(project: Project, agent: Agent): ExecutionBudget {
  return new ExecutionBudget({
    ...project.settings.budget,
    maxTokensPerRun:
      agent.tokenBudget > 0
        ? Math.min(project.settings.budget.maxTokensPerRun || Infinity, agent.tokenBudget)
        : project.settings.budget.maxTokensPerRun,
    maxDurationMs:
      agent.timeoutMs > 0
        ? Math.min(project.settings.budget.maxDurationMs || Infinity, agent.timeoutMs)
        : project.settings.budget.maxDurationMs,
  });
}

/** Cancellation is inherited by descendants. Deleting an in-flight task also stops it. */
export function assertTaskActive(repo: TaskRepository, task: Task): void {
  let id: string | undefined = task.id;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const current: Task | undefined = repo.findById(id)?.data;
    if (!current || current.status === "cancelled") throw new TaskCancelledError(id);
    if (current.projectId !== task.projectId) throw new Error("Task ancestry crosses project boundaries");
    id = current.parentTaskId;
  }
  if (id) throw new Error("Task ancestry contains a cycle");
}

/** Retry an orchestrated child through its owner, never as an unrelated single-agent task. */
export function executionTask(repo: TaskRepository, taskId: string): Task {
  const task = repo.findById(taskId)?.data;
  if (!task) throw new Error(`Task ${taskId} not found`);
  let target = task;
  let current = task;
  const seen = new Set<string>([task.id]);
  while (current.parentTaskId) {
    const parent = repo.findById(current.parentTaskId)?.data;
    if (!parent) throw new Error("Parent task is missing; cannot safely retry this subtask");
    if (seen.has(parent.id)) throw new Error("Task ancestry contains a cycle");
    if (parent.projectId !== task.projectId) throw new Error("Task ancestry crosses project boundaries");
    seen.add(parent.id);
    if (parent.input?.executionMode === "autonomous" || parent.workflowId) target = parent;
    current = parent;
  }
  return target;
}
