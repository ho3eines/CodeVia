import type { AgentType, Project, Task } from "../domain/entities.js";
import type { ProjectRepository, TaskRepository, WorkflowRepository } from "../domain/repos.js";
import type { AgentRepository } from "./agent-repo.js";
import type { RunRepository, CostRepository, AuditRepository, NotificationRepository } from "../observability/repos.js";
import type { AgentRunner } from "./runner.js";
import type { WorkflowEngine } from "../workflow/engine.js";
import type { AgentRouter } from "./router.js";
import type { AgentGenerator } from "./generator.js";
import type { SkillRepository } from "../skills/registry.js";
import type { ModelRepository, ProviderRepository } from "../ai/model-repo.js";
import type { IGitHubService } from "../github/types.js";
import type { Permission } from "../types.js";
import { eventBus, generateCorrelationId } from "../events/bus.js";
import { live } from "../realtime/live.js";
import { logger } from "../logger.js";
import { randomUUID } from "node:crypto";

const ALL_PERMISSIONS: Permission[] = [
  "project.read", "project.write", "agent.read", "agent.write", "workflow.read", "workflow.write",
  "model.read", "model.write", "provider.read", "provider.write", "skill.read", "skill.write",
  "memory.read", "memory.write", "repository.read", "repository.write", "deployment.read",
  "deployment.write", "secret.read", "secret.write", "telegram.read", "telegram.write",
  "admin.read", "admin.write",
];

function defaultPermissions(): Record<Permission, boolean> {
  const out = {} as Record<Permission, boolean>;
  for (const p of ALL_PERMISSIONS) out[p] = true;
  return out;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  description: string;
  configRepo: string;
  branch?: string;
  primaryLanguage?: string;
  framework?: string;
  database?: string;
  tech?: string[];
  defaultModelId?: string;
  settings?: Project["settings"];
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  agentType?: AgentType;
  workflowId?: string;
  input?: Record<string, unknown>;
  parentTaskId?: string;
}

export interface AgentManagerDeps {
  projectRepo: ProjectRepository;
  taskRepo: TaskRepository;
  workflowRepo: WorkflowRepository;
  agentRepo: AgentRepository;
  runRepo: RunRepository;
  costRepo: CostRepository;
  auditRepo: AuditRepository;
  notificationRepo: NotificationRepository;
  agentRunner: AgentRunner;
  workflowEngine: WorkflowEngine;
  agentRouter: AgentRouter;
  agentGenerator: AgentGenerator;
  skillsRepo: SkillRepository;
  modelRepo: ModelRepository;
  providerRepo: ProviderRepository;
  github: IGitHubService;
}

/**
 * Agent Manager — the central orchestrator. Determines which agent, model, skill,
 * tool, memory, and workflow are used for a task; chains agents (self-healing
 * feedback loops); enforces budgets; routes errors; and records audit + events.
 */
export class AgentManager {
  private readonly agentRouter: AgentRouter;
  constructor(private readonly deps: AgentManagerDeps) {
    this.agentRouter = deps.agentRouter;
  }

  /* ---------------- Project onboarding ---------------- */

  async createProject(input: CreateProjectInput): Promise<Project> {
    const now = new Date().toISOString();
    const project: Project = {
      id: `proj-${randomUUID().slice(0, 8)}`,
      slug: input.slug ?? this.slugify(input.name),
      name: input.name,
      description: input.description,
      configRepo: input.configRepo,
      branch: input.branch ?? "main",
      primaryLanguage: input.primaryLanguage,
      framework: input.framework,
      database: input.database,
      defaultModelId: input.defaultModelId,
      settings:
        input.settings ??
        {
          environment: "development",
          notifications: [],
          rules: [],
          skills: [],
          workflows: [],
          budget: { maxTokensPerRun: 20000, maxCallsPerRun: 20, maxCostUsdPerRun: 5, maxDurationMs: 600000 },
          permissions: defaultPermissions(),
          metadata: {},
        },
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.projectRepo.upsert(project, { key: project.slug });
    await this.onboardProject(project.id, input.tech ?? []);
    await this.deps.auditRepo.record({
      action: "project.created",
      projectId: project.id,
      result: "success",
      source: "web",
      correlationId: generateCorrelationId(),
      metadata: { name: project.name },
    });
    return project;
  }

  /** Online onboarding: analyze repo, generate agents/skills/workflows/rules. */
  async onboardProject(projectId: string, tech: string[] = []): Promise<{ agents: number; skills: number }> {
    const project = this.deps.projectRepo.findById(projectId)?.data;
    if (!project) throw new Error(`Project ${projectId} not found`);
    // In mock mode, seed a starter .ai-engineering repo so the platform can be
    // exercised end-to-end without real GitHub credentials.
    this.ensureMockRepo(project);
    const agents = this.deps.agentGenerator.generate(project, { defaultModelId: project.defaultModelId, tech });
    const seeded = this.deps.skillsRepo.seedBuiltIns();
    // Attach relevant skills to the project settings.
    const relevant = this.deps.skillsRepo
      .findMany()
      .filter((r) => this.skillsRelevant(r.data.slug, tech, project))
      .map((r) => r.data.slug);
    this.deps.projectRepo.upsert({ ...project, settings: { ...project.settings, skills: [...new Set(relevant)] } }, { key: project.slug });
    logger.info(`onboarded project ${projectId}`, { agents: agents.length, skills: seeded });
    return { agents: agents.length, skills: seeded };
  }

  /** Seed a mock repository with a starter .ai-engineering structure for demos. */
  private ensureMockRepo(project: Project): void {
    if (this.deps.github.kind !== "mock") return;
    const mock = this.deps.github as unknown as {
      seedRepo(owner: string, name: string, opts?: { files?: Array<{ path: string; content: string }>; branch?: string }): { owner: string; name: string };
    };
    const [owner, ...rest] = project.configRepo.split("/");
    const name = rest.join("/") || "repo";
    const starter = [
      { path: "README.md", content: `# ${project.name}\n\n${project.description}\n` },
      { path: ".ai-engineering/project.yaml", content: this.projectYaml(project) },
      { path: ".ai-engineering/rules/coding.md", content: "# Coding Rules\n- Follow existing conventions.\n- No secrets in code.\n" },
      { path: ".ai-engineering/rules/git.md", content: "# Git Rules\n- Feature branches, conventional commits, PRs.\n" },
    ];
    mock.seedRepo(owner, name, { files: starter, branch: project.branch });
    logger.debug(`seeded mock repo ${project.configRepo}`);
  }

  private projectYaml(project: Project): string {
    return [
      "project:",
      `  name: ${project.name}`,
      `  slug: ${project.slug}`,
      `  framework: ${project.framework ?? "unknown"}`,
      `  language: ${project.primaryLanguage ?? "unknown"}`,
      `  database: ${project.database ?? "unknown"}`,
      `  branch: ${project.branch}`,
    ].join("\n");
  }

  private skillsRelevant(slug: string, tech: string[], project: Project): boolean {
    const text = `${slug} ${project.description} ${project.framework ?? ""} ${project.database ?? ""}`.toLowerCase();
    const needles = ["dotnet", "csharp", "aspnetcore", "blazor", "react", "nodejs", "sqlserver", "postgresql", "docker", "github", "git", "security", "testing"].filter(
      (n) => text.includes(n),
    );
    return needles.length > 0;
  }

  /* ---------------- Task creation & execution ---------------- */

  createTask(input: CreateTaskInput): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: `task-${randomUUID().slice(0, 8)}`,
      projectId: input.projectId,
      workflowId: input.workflowId,
      parentTaskId: input.parentTaskId,
      title: input.title,
      description: input.description ?? "",
      status: "created",
      agentType: input.agentType,
      correlationId: generateCorrelationId(),
      input: input.input ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.deps.taskRepo.upsert(task, { projectId: input.projectId, parentId: input.parentTaskId });
    void eventBus.publish("task.created", { taskId: task.id, projectId: input.projectId }, { correlationId: task.correlationId, projectId: input.projectId });
    return task;
  }

  /** Execute a task by routing to the right agent or running a workflow. */
  async runTask(taskId: string): Promise<Task> {
    const task = this.deps.taskRepo.findById(taskId)?.data;
    if (!task) throw new Error(`Task ${taskId} not found`);
    const project = this.deps.projectRepo.findById(task.projectId)?.data;
    if (!project) throw new Error(`Project ${task.projectId} not found`);

    this.deps.taskRepo.upsert({ ...task, status: "running" }, { projectId: task.projectId, parentId: task.parentTaskId });
    live.emit({ type: "task.updated", taskId, data: { status: "running" } });

    try {
      if (task.workflowId) {
        const workflow = this.deps.workflowRepo.findById(task.workflowId)?.data;
        if (!workflow) throw new Error(`Workflow ${task.workflowId} not found`);
        await this.deps.workflowEngine.run(workflow, project, task, task.input);
      } else {
        await this.routeAndRun(task, project);
      }
      const prev = this.deps.taskRepo.findById(taskId)?.data!;
      const done: Task = { ...prev, status: "succeeded", updatedAt: new Date().toISOString() };
      this.deps.taskRepo.upsert(done, { projectId: task.projectId, parentId: task.parentTaskId });
      live.emit({ type: "task.updated", taskId, data: { status: "succeeded" } });
      return done;
    } catch (err) {
      logger.error("runTask failed", { taskId, err: String(err) });
      const failed = this.deps.taskRepo.findById(taskId)?.data!;
      this.deps.taskRepo.upsert({ ...failed, status: "failed", error: String(err) }, { projectId: task.projectId, parentId: task.parentTaskId });
      live.emit({ type: "task.updated", taskId, data: { status: "failed", error: String(err) } });
      throw err;
    }
  }

  private async routeAndRun(task: Task, project: Project): Promise<void> {
    const type = task.agentType ?? this.agentRouter.route(`${task.title} ${task.description}`);
    const agent = this.deps.agentRepo.byType(project.id, type);
    if (!agent) {
      throw new Error(`No enabled agent of type ${type} in project ${project.id}`);
    }
    await this.deps.agentRunner.run({ task, agent, project, workspaceRoot: process.cwd() });

    // Self-healing loop: if the routed agent is QA and we can route failures,
    // we re-task to the designated downstream agent. (Bounded to one hop.)
    if (type === "qa-test" && this.shouldHeal(task)) {
      const downstream = this.agentRouter.route("debug " + task.description);
      const debugAgent = this.deps.agentRepo.byType(project.id, downstream);
      if (debugAgent) {
        const subtask = this.createTask({
          projectId: project.id,
          title: `Diagnose: ${task.title}`,
          description: task.description,
          agentType: downstream,
          parentTaskId: task.id,
          input: task.input,
        });
        await this.deps.agentRunner.run({ task: subtask, agent: debugAgent, project });
      }
    }
  }

  private shouldHeal(task: Task): boolean {
    const text = "${task.title} ${task.description}".toLowerCase();
    return /test|fail|bug|error/.test(text);
  }

  /* ---------------- Budget enforcement ---------------- */

  private enforceBudget(project: Project): void {
    const budget = project.settings.budget;
    const totals = this.deps.costRepo.totals({ projectId: project.id });
    if (budget.maxCostUsdPerRun > 0 && totals.costUsd > budget.maxCostUsdPerRun) {
      throw new Error(`Budget exceeded: cost $${totals.costUsd.toFixed(2)} > $${budget.maxCostUsdPerRun}`);
    }
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || `project-${Date.now()}`;
  }
}
