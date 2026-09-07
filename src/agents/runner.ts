import type { Agent, Project, ProjectRepositoryLink, Run, RunStep, Task } from "../domain/entities.js";
import type { RunRepository, CostRepository } from "../observability/repos.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { ModelRepository, ProviderRepository } from "../ai/model-repo.js";
import type { ContextEngine } from "../ai/context-engine.js";
import type { ProviderRegistry } from "../ai/provider-registry.js";
import type { ModelRouter, TaskCategory } from "../ai/model-router.js";
import type { IGitHubService } from "../github/types.js";
import { eventBus, generateCorrelationId } from "../events/bus.js";
import { live } from "../realtime/live.js";
import { logger } from "../logger.js";
import { defaultPlanFor, type PlanStep } from "./plan.js";
import { randomUUID } from "node:crypto";
import { memoryResolver } from "../memory/index.js";
import type { IMemoryStore } from "../memory/store.js";
import { toRepoRef } from "../tools/core-tools.js";
import type { MemoryRepository } from "../domain/repos.js";
import type { MemoryScope, MemoryType } from "../domain/entities.js";
import type { ProjectFilesService } from "../github/project-files.js";
import { TaskCancelledError, runBudget, type ExecutionBudget } from "./execution.js";
import { realChatFor, type RealChat } from "./llm.js";
import { isWriter, prepareSingleImplementation, repositoryForAgent } from "./implementation.js";
export { TaskCancelledError, BudgetExceededError } from "./execution.js";

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
  githubForProject?: (project: Project) => IGitHubService;
  requestApproval?: (action: string, detail: Record<string, unknown>) => Promise<boolean>;
  memoryFor?: (project: Project) => IMemoryStore;
  memoryRepo?: MemoryRepository;
  projectFiles?: ProjectFilesService;
  isCancelled?: (taskId: string) => boolean;
  /** Checks the complete ancestry, not just the current subtask. */
  checkActive?: (task: Task) => void;
}

export interface PrepareContext {
  chat?: RealChat;
  context: string;
  github: IGitHubService;
  project: Project;
  checkActive: () => void;
  setSummary: (summary: string) => void;
}
export type PreparePlan = (ctx: PrepareContext) => Promise<PlanStep[]>;

export interface RunRequest {
  task: Task;
  agent: Agent;
  project: Project;
  plan?: PlanStep[];
  /** Preparation happens INSIDE the observed, budgeted and cancellable run. */
  preparePlan?: PreparePlan;
  repository?: ProjectRepositoryLink;
  taskBudget?: ExecutionBudget;
  providerRegistry?: ProviderRegistry;
  category?: TaskCategory;
  workspaceRoot?: string;
}

/** Executes only grounded plans: model deliverables, permissioned tools and recorded evidence. */
export class AgentRunner {
  constructor(private readonly deps: AgentRunnerDeps) {}

  private memoryFor(project: Project, github: IGitHubService): IMemoryStore | undefined {
    if (this.deps.memoryFor) return this.deps.memoryFor(project);
    return memoryResolver.resolve({
      repo: project.configRepo ? toRepoRef(project.configRepo) : undefined,
      branch: project.branch, localRoot: `./data/memory/${project.id}`, github,
    });
  }

  async run(req: RunRequest): Promise<Run> {
    const { task, agent, project } = req;
    if (!agent.enabled) throw new Error(`Agent ${agent.name} (${agent.type}) is disabled`);
    if (agent.projectId !== project.id || task.projectId !== project.id) throw new Error("Agent, task and project must belong to the same project");
    const correlationId = task.correlationId || generateCorrelationId();
    const github = this.deps.githubForProject?.(project) ?? this.deps.github;
    const repository = req.repository ?? (isWriter(agent.type) ? repositoryForAgent(project, agent.type) : undefined);
    const executionProject = repository ? { ...project, configRepo: repository.repo, branch: repository.branch } : project;
    const budget = runBudget(project, agent);
    const checkActive = () => {
      this.deps.checkActive?.(task);
      if (this.deps.isCancelled?.(task.id)) throw new TaskCancelledError(task.id);
      budget.check();
      req.taskBudget?.check();
    };
    checkActive();
    let plan = req.plan ?? defaultPlanFor(agent, task);
    const run = this.deps.runRepo.create({
      taskId: task.id, projectId: project.id, workflowId: task.workflowId,
      agentId: agent.id, agentType: agent.type, status: "running",
      steps: [{ index: 0, label: "Prepare context and plan", status: "running", startedAt: new Date().toISOString() }],
      inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, correlationId,
    });
    const persist = () => {
      const { calls: _calls, ...usage } = budget.usage;
      Object.assign(run, usage, { durationMs: Date.now() - budget.startedAt, updatedAt: new Date().toISOString() });
      this.deps.runRepo.upsert(run, { projectId: project.id, parentId: task.id });
    };
    await eventBus.publish("agent.started", { runId: run.id, agentId: agent.id, projectId: project.id }, { correlationId, projectId: project.id });
    live.emit({ type: "run.updated", runId: run.id, data: { status: "running", agent: agent.name } });
    try {
      const memory = this.memoryFor(project, github);
      const built = await this.deps.contextEngine.build({ project: executionProject, agent, task, skills: this.deps.skillsRegistry, github, memory });
      checkActive();
      const prepare = req.preparePlan ?? (!req.plan && isWriter(agent.type)
        ? (ctx: PrepareContext) => prepareSingleImplementation(ctx, agent, task, this.deps.memoryRepo)
        : undefined);
      const chat = prepare || !req.plan ? realChatFor({
        modelRepo: this.deps.modelRepo, providerRepo: this.deps.providerRepo,
        providerRegistry: req.providerRegistry ?? this.deps.providerRegistry,
        modelRouter: this.deps.modelRouter, costRepo: this.deps.costRepo,
        project, agent, task, context: built.context,
        category: req.category ?? (isWriter(agent.type) ? "coding" : agent.type === "research" ? "research" : "reasoning"),
        budget, taskBudget: req.taskBudget, checkActive,
        allowMock: !prepare && !req.plan,
      }) : undefined;
      if (prepare) {
        plan = await prepare({ chat, context: built.context, github, project: executionProject, checkActive, setSummary: (s) => { run.summary = s; } });
      } else if (!req.plan && chat) {
        run.summary = await chat.chat(
          "Analyze the request against the supplied repository context. Return concise findings, risks and next actions. Never claim to have run tests or modified files without tool evidence.",
          `Task: ${task.title}\n${task.description}`,
          2000,
        );
      }
      checkActive();
      if (run.summary) {
        plan = plan.map((s) => s.tool === "save_memory" ? { ...s, input: { ...s.input, content: run.summary } } : s);
      }
      run.steps = plan.map((p, index) => ({ index, label: p.label, tool: p.tool, status: "pending" }));
      persist();
      for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        const record = run.steps[i];
        checkActive();
        record.status = "running";
        record.startedAt = new Date().toISOString();
        persist();
        live.emit({ type: "step.updated", runId: run.id, data: { ...record } });
        let approved = false;
        if (step.requiresApproval) {
          if (!this.deps.requestApproval) throw new Error(`No approval channel configured for ${step.label}`);
          approved = await this.deps.requestApproval(step.label, {
            runId: run.id, projectId: project.id, taskId: task.id, workflowId: task.workflowId,
            correlationId, agent: agent.name, tool: step.tool, input: step.input,
          });
          checkActive();
          if (!approved) {
            record.status = "failed";
            record.detail = "Human approval rejected";
            record.finishedAt = new Date().toISOString();
            break;
          }
        }
        if (step.tool) {
          if (step.tool === "save_memory" && step.input?.fromSteps === true) {
            step.input = { ...step.input, content: run.steps.slice(0, i).filter((s) => s.tool === "run_tests" || s.tool === "run_build").map((s) => `${s.label}: ${s.status}\n${s.detail ?? ""}`).join("\n\n") || "No CI verification evidence was recorded." };
            run.summary = String(step.input.content);
          }
          const result = await this.deps.toolRegistry.execute(step.tool, {
            project: executionProject, agent, github, logger, correlationId, approved, memory,
            workspaceRoot: req.workspaceRoot,
            baseBranch: repository?.defaultBranch ?? project.branch,
            checkActive,
            requestApproval: this.deps.requestApproval
              ? (action, detail) => this.deps.requestApproval!(action, { ...detail, projectId: project.id, taskId: task.id, runId: run.id, correlationId })
              : undefined,
          }, step.input ?? { repo: executionProject.configRepo });
          record.status = result.ok ? "succeeded" : "failed";
          record.detail = result.output.slice(0, 4000);
          record.data = result.data;
          if (typeof result.data?.verification === "string") run.verification = result.data.verification as Run["verification"];
          if (result.ok && step.tool === "save_memory") this.indexMemory(task, agent, project, step.input, result.data);
        } else {
          record.status = "succeeded";
          record.detail = step.detail ?? "Planning/analysis stage completed; no external command executed.";
        }
        record.finishedAt = new Date().toISOString();
        persist();
        live.emit({ type: "step.updated", runId: run.id, data: { ...record } });
        checkActive();
        if (record.status === "failed") break;
      }
      for (const step of run.steps) if (step.status === "pending") step.status = "skipped";
      run.status = run.steps.every((s) => s.status === "succeeded") ? "succeeded" : "failed";
      if (run.status === "failed") run.error = run.steps.find((s) => s.status === "failed")?.detail ?? "Plan did not complete";
      persist();
      await eventBus.publish(run.status === "succeeded" ? "agent.completed" : "agent.failed", { runId: run.id, agentId: agent.id, projectId: project.id, taskId: task.id }, { correlationId, projectId: project.id });
      live.emit({ type: "run.updated", runId: run.id, data: { status: run.status, verification: run.verification } });
      return run;
    } catch (err) {
      run.status = err instanceof TaskCancelledError ? "cancelled" : "failed";
      run.error = String(err);
      for (const step of run.steps) {
        if (step.status === "running") {
          step.status = "failed"; step.detail = String(err); step.finishedAt = new Date().toISOString();
        } else if (step.status === "pending") step.status = "skipped";
      }
      persist();
      await eventBus.publish("agent.failed", { runId: run.id, projectId: project.id, error: run.error }, { correlationId, projectId: project.id });
      live.emit({ type: "run.updated", runId: run.id, data: { status: run.status, error: run.error } });
      throw err;
    }
  }

  /**
   * Mirror a successful `save_memory` tool call into the DB-backed memory
   * index (the file/GitHub store stays the source of truth; the DB is the
   * searchable index the UI and /memory API read).
   */
  private indexMemory(
    task: Task,
    agent: Agent,
    project: Project,
    input: Record<string, unknown> | undefined,
    data: Record<string, unknown> | undefined,
  ): void {
    try {
      const repo = this.deps.memoryRepo;
      if (!repo) return;
      const key = String(data?.key ?? input?.key ?? `${agent.slug}/${task.id}`);
      const content = String(input?.content ?? "").slice(0, 4000);
      if (!content) return;
      const type = String(data?.type ?? input?.type ?? "knowledge") as MemoryType;
      const tags = Array.isArray(input?.tags) ? (input.tags as string[]) : [agent.type];
      const existing = repo.findMany({ projectId: project.id, key })[0]?.data;
      const now = new Date().toISOString();
      if (existing) {
        repo.upsert(
          { ...existing, type, content, tags, version: existing.version + 1, updatedAt: now },
          { projectId: project.id, key },
        );
      } else {
        repo.upsert(
          {
            id: randomUUID(),
            projectId: project.id,
            scope: "project" as MemoryScope,
            type,
            key,
            content,
            tags,
            refs: [task.id],
            source: `agent:${agent.type}`,
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
          { projectId: project.id, key },
        );
      }
      const files = this.deps.projectFiles;
      if (files) void files.syncMemory(project, repo.byProject(project.id)).catch(() => undefined);
    } catch (err) {
      logger.warn("memory DB index failed", { projectId: project.id, err: String(err) });
    }
  }
}
