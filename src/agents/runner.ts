import type { Agent, AgentType, Project, Run, RunStep, Task } from "../domain/entities.js";
import type { RunRepository } from "../observability/repos.js";
import type { CostRepository } from "../observability/repos.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { ModelRepository, ProviderRepository } from "../ai/model-repo.js";
import type { ContextEngine } from "../ai/context-engine.js";
import { ProviderRegistry } from "../ai/provider-registry.js";
import { ModelRouter, toCandidate } from "../ai/model-router.js";
import type { IGitHubService } from "../github/types.js";
import { eventBus } from "../events/bus.js";
import { live } from "../realtime/live.js";
import { logger } from "../logger.js";
import { defaultPlanFor, type PlanStep } from "./plan.js";
import { generateCorrelationId } from "../events/bus.js";
import { memoryResolver } from "../memory/index.js";
import type { IMemoryStore } from "../memory/store.js";
import { toRepoRef } from "../tools/core-tools.js";

export interface AgentRunnerDeps {
  runRepo: RunRepository;
  costRepo: CostRepository;
  toolRegistry: ToolRegistry;
  skillsRegistry: SkillRegistry;
  modelRepo: ModelRepository;
  providerRepo: ProviderRepository;
  providerRegistry: ProviderRegistry;
  modelRouter: ModelRouter;
  contextEngine: ContextEngine;
  github: IGitHubService;
  requestApproval?: (action: string, detail: Record<string, unknown>) => Promise<boolean>;
  /** Override memory resolution (tests). Defaults to the project's GitHub/local store. */
  memoryFor?: (project: Project) => IMemoryStore;
  /** Cooperative cancellation: polled between steps (POST /tasks/:id/cancel). */
  isCancelled?: (taskId: string) => boolean;
}

export class TaskCancelledError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} was cancelled`);
    this.name = "TaskCancelledError";
  }
}

export interface RunRequest {
  task: Task;
  agent: Agent;
  project: Project;
  plan?: PlanStep[];
  workspaceRoot?: string;
}

/**
 * Executes a task through a single agent, producing a Run with observable steps.
 *
 * - The agent builds context (Context Engine) and chooses a model (Model Router).
 * - It executes a plan of steps; tool steps call the Tool Registry.
 * - Danger/costly steps gate on human approval.
 * - Each transition is pushed on the live bus and recorded for observability.
 * - On provider failure it falls back through candidate models (A -> B -> C).
 */
export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  constructor(message: string) {
    super(`Budget exceeded: ${message}`);
    this.name = "BudgetExceededError";
  }
}

export class AgentRunner {
  constructor(private readonly deps: AgentRunnerDeps) {}

  private memoryFor(project: Project): IMemoryStore | undefined {
    try {
      if (this.deps.memoryFor) return this.deps.memoryFor(project);
      const repo = project.configRepo ? toRepoRef(project.configRepo) : undefined;
      return memoryResolver.resolve({ repo, branch: project.branch, localRoot: `./data/memory/${project.id}` });
    } catch (err) {
      logger.warn("memory store unavailable for run", { projectId: project.id, err: String(err) });
      return undefined;
    }
  }

  private get correlationId(): string {
    return generateCorrelationId();
  }

  async run(req: RunRequest): Promise<Run> {
    const { task, agent, project } = req;
    const correlationId = task.correlationId || this.correlationId;

    if (!agent.enabled) {
      throw new Error(`Agent ${agent.name} (${agent.type}) is disabled`);
    }

    const plan = req.plan ?? defaultPlanFor(agent, task);
    const run = this.deps.runRepo.create({
      taskId: task.id,
      projectId: project.id,
      workflowId: task.workflowId,
      agentId: agent.id,
      agentType: agent.type,
      status: "running",
      steps: plan.map((p) => ({ index: 0, label: p.label, status: "pending" as const })),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs: 0,
      correlationId,
    });

    await eventBus.publish("agent.started", { runId: run.id, agentId: agent.id, projectId: project.id }, { correlationId, projectId: project.id });
    live.emit({ type: "run.updated", runId: run.id, data: { status: "running", agent: agent.name } });

    const startedAt = Date.now();
    try {
      // 1. Build context.
      const contextResult = await this.deps.contextEngine.build({
        project,
        agent,
        task,
        skills: this.deps.skillsRegistry,
        github: this.deps.github,
      });

      // 2. Decide the model via the Model Router and invoke it (records cost).
      const modelResult = await this.decideAndCallModel(project, agent, task, contextResult.context, correlationId);
      // Budget guardrail: a run that already blew its token/cost budget must not
      // go on to modify the repository. (Duration is checked per step below.)
      this.assertBudget(project, agent, { ...modelResult, elapsedMs: Date.now() - startedAt, calls: 1 });
      let finalSteps = run.steps;

      // 3. Execute the plan.
      finalSteps = await this.executePlan(run.id, task, agent, project, plan, correlationId, () =>
        this.assertBudget(project, agent, { ...modelResult, elapsedMs: Date.now() - startedAt, calls: 1 }),
      );
      const stepStatuses = finalSteps;

      const succeeded = stepStatuses.every((s) => s.status === "succeeded");
      this.deps.runRepo.upsert(run, { projectId: project.id, parentId: task.id });

      const finalRun: Run = {
        ...run,
        steps: stepStatuses,
        status: succeeded ? "succeeded" : "failed",
        inputTokens: modelResult.inputTokens,
        outputTokens: modelResult.outputTokens,
        totalTokens: modelResult.totalTokens,
        costUsd: modelResult.costUsd,
        durationMs: Date.now() - startedAt,
      };
      this.deps.runRepo.upsert(finalRun, { projectId: project.id, parentId: task.id });

      await eventBus.publish(
        succeeded ? "agent.completed" : "agent.failed",
        { runId: run.id, agentId: agent.id, projectId: project.id, taskId: task.id },
        { correlationId, projectId: project.id },
      );
      live.emit({ type: "run.updated", runId: run.id, data: { status: succeeded ? "succeeded" : "failed" } });
      return finalRun;
    } catch (err) {
      const cancelled = err instanceof TaskCancelledError;
      const failedRun: Run = {
        ...run,
        status: cancelled ? "cancelled" : "failed",
        error: String(err),
        durationMs: Date.now() - startedAt,
      };
      this.deps.runRepo.upsert(failedRun, { projectId: project.id, parentId: task.id });
      await eventBus.publish("agent.failed", { runId: run.id, agentId: agent.id, projectId: project.id, error: String(err) }, { correlationId, projectId: project.id });
      live.emit({ type: "run.updated", runId: run.id, data: { status: failedRun.status, error: String(err) } });
      throw err;
    }
  }

  /**
   * Budget Control — stops the run when project/agent limits are exceeded.
   * Limits: project.settings.budget (tokens/cost/duration/calls per run) and
   * agent.tokenBudget. A `0`/missing limit means "unlimited".
   */
  private assertBudget(
    project: Project,
    agent: Agent,
    usage: { totalTokens: number; costUsd: number; elapsedMs: number; calls: number },
  ): void {
    const b = project.settings?.budget ?? { maxTokensPerRun: 0, maxCallsPerRun: 0, maxCostUsdPerRun: 0, maxDurationMs: 0 };
    const over = (label: string, actual: number, limit: number | undefined, fmt: (n: number) => string = String) => {
      if (limit && limit > 0 && actual > limit) throw new BudgetExceededError(`${label} ${fmt(actual)} exceeds budget ${fmt(limit)}`);
    };
    over("tokens", usage.totalTokens, b.maxTokensPerRun);
    over("agent tokens", usage.totalTokens, agent.tokenBudget);
    over("cost", usage.costUsd, b.maxCostUsdPerRun, (n) => `$${n.toFixed(4)}`);
    over("duration", usage.elapsedMs, b.maxDurationMs, (n) => `${n}ms`);
    over("model calls", usage.calls, b.maxCallsPerRun);
    over("duration", usage.elapsedMs, agent.timeoutMs, (n) => `${n}ms`);
  }

  private async decideAndCallModel(
    project: Project,
    agent: Agent,
    task: Task,
    context: string,
    correlationId: string,
  ): Promise<{ inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }> {
    const available = this.deps.modelRepo.listActive().map(toCandidate);
    const candidates = this.deps.modelRouter.route(available, agent.models, "reasoning", {});
    if (candidates.length === 0) {
      // No configured model — use a zero-cost model call (mock tokens 0).
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
    }
    let lastError: unknown;
    for (const candidate of candidates) {
      const model = this.deps.modelRepo.findById(candidate.id)?.data;
      if (!model) continue;
      const providerConfig = this.deps.providerRepo.findById(model.providerId)?.data;
      // Deactivated providers must never be called, even if their models are still active.
      if (!providerConfig || !providerConfig.active) continue;
      try {
        const provider = this.deps.providerRegistry.resolve(providerConfig);
        const response = await provider.chat({
          modelId: model.modelId,
          messages: [
            { role: "system", content: agent.systemPrompt },
            { role: "user", content: context },
          ],
          // A model's own temperature wins over the run default — some routes
          // only accept one specific value.
          temperature: model.temperature ?? 0.3,
          maxTokens: model.maxTokens,
          omitTemperature: model.omitTemperature === true,
        });
        this.deps.costRepo.create({
          providerId: providerConfig.id,
          modelId: model.id,
          projectId: project.id,
          agentId: agent.id,
          taskId: task.id,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          estimatedCostUsd: response.costUsd ?? 0,
          durationMs: 0,
        });
        void task;
        return {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          costUsd: response.costUsd ?? 0,
        };
      } catch (err) {
        lastError = err;
        logger.warn(`model ${candidate.id} failed, falling back`, { err: String(err), correlationId });
      }
    }
    if (lastError) logger.error("all models failed", { err: String(lastError), correlationId });
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  }

  private async executePlan(
    runId: string,
    task: Task,
    agent: Agent,
    project: Project,
    plan: PlanStep[],
    correlationId: string,
    checkBudget?: () => void,
  ): Promise<RunStep[]> {
    const steps: RunStep[] = [];
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      // Re-check the (duration) budget before each step; throwing here fails the run.
      checkBudget?.();
      if (this.deps.isCancelled?.(task.id)) throw new TaskCancelledError(task.id);
      const stepRecord: RunStep = {
        index: i,
        label: step.label,
        status: "running",
        tool: step.tool,
        startedAt: new Date().toISOString(),
      };
      steps.push(stepRecord);
      live.emit({ type: "step.updated", runId, data: { index: i, label: step.label, status: "running" } });

      if (step.requiresApproval && this.deps.requestApproval) {
        const approved = await this.deps.requestApproval(step.label, {
          runId,
          projectId: project.id,
          taskId: task.id,
          workflowId: task.workflowId,
          correlationId,
          agent: agent.name,
          tool: step.tool,
        });
        if (!approved) {
          stepRecord.status = "skipped";
          stepRecord.finishedAt = new Date().toISOString();
          live.emit({ type: "step.updated", runId, data: { index: i, status: "skipped" } });
          return steps;
        }
      }

      let ok = true;
      let detail = "";
      if (step.tool) {
        const result = await this.deps.toolRegistry.execute(
          step.tool,
          {
            project,
            agent,
            github: this.deps.github,
            logger,
            correlationId,
            approved: Boolean(step.requiresApproval),
            memory: this.memoryFor(project),
            requestApproval: this.deps.requestApproval
              ? (action, detail) => this.deps.requestApproval!(action, { projectId: project.id, taskId: task.id, runId, correlationId, ...detail })
              : undefined,
          },
          step.input ?? { repo: project.configRepo },
        );
        ok = result.ok;
        detail = result.output.slice(0, 400);
      }

      stepRecord.status = ok ? "succeeded" : "failed";
      stepRecord.detail = detail;
      stepRecord.finishedAt = new Date().toISOString();
      live.emit({ type: "step.updated", runId, data: { index: i, status: stepRecord.status, detail } });

      if (!ok) {
        // Propagate downstream and stop the plan.
        steps.push(...plan.slice(i + 1).map((p, j) => ({
          index: i + 1 + j,
          label: p.label,
          status: "skipped" as const,
          tool: p.tool,
        })));
        return steps;
      }
    }
    void task;
    return steps;
  }
}
