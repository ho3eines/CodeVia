import type { AgentType, Project, ProjectCapabilities, ProjectGithubConnection, ProjectRepositoryLink, Task } from "../domain/entities.js";
import {
  agentTypesForProject,
  configRepoOf,
  hydrateProject,
  legacyFieldsFromCapabilities,
  normalizeCapabilities,
  normalizeRepositories,
  skillsForCapabilities,
} from "../domain/project-options.js";
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
  /** Primary (config) repository `owner/name`. Optional when `repositories` is given. */
  configRepo?: string;
  branch?: string;
  /** All linked repositories (multi-repo). The config repo is the `isConfigRepo`/first one. */
  repositories?: Array<Partial<ProjectRepositoryLink> | string>;
  /** Multi-select project profile. */
  capabilities?: Partial<Record<keyof ProjectCapabilities, unknown>>;
  githubConnection?: ProjectGithubConnection;
  /** @deprecated legacy single values — merged into `capabilities` */
  primaryLanguage?: string;
  /** @deprecated */
  framework?: string;
  /** @deprecated */
  database?: string;
  /** @deprecated */
  deploymentTarget?: string;
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
    const repositories = normalizeRepositories(input.repositories, { repo: input.configRepo, branch: input.branch });
    const cfg = configRepoOf(repositories);
    if (!cfg) {
      throw Object.assign(new Error("A GitHub repository (owner/name) is required — pick one from the connected account"), { statusCode: 400 });
    }
    const capabilities = normalizeCapabilities(input.capabilities, {
      primaryLanguage: input.primaryLanguage,
      framework: input.framework,
      database: input.database,
      deploymentTarget: input.deploymentTarget,
      tech: input.tech,
    });
    const legacy = legacyFieldsFromCapabilities(capabilities);
    const slug = input.slug ?? this.slugify(input.name);
    if (this.deps.projectRepo.findBySlug(slug)) {
      throw Object.assign(new Error(`A project with slug "${slug}" already exists`), { statusCode: 409 });
    }
    const project: Project = {
      id: `proj-${randomUUID().slice(0, 8)}`,
      slug,
      name: input.name,
      description: input.description,
      configRepo: cfg.repo,
      branch: cfg.branch,
      repositories,
      capabilities,
      githubConnection: input.githubConnection,
      primaryLanguage: legacy.primaryLanguage,
      framework: legacy.framework,
      database: legacy.database,
      deploymentTarget: legacy.deploymentTarget,
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
    const stored = this.deps.projectRepo.findById(projectId)?.data;
    if (!stored) throw new Error(`Project ${projectId} not found`);
    const project = hydrateProject(stored);
    // In mock mode, seed a starter .ai-engineering repo so the platform can be
    // exercised end-to-end without real GitHub credentials.
    this.ensureMockRepo(project);
    const agentTypes = agentTypesForProject(project.capabilities);
    const agents = this.deps.agentGenerator.generate(project, { defaultModelId: project.defaultModelId, tech, agentTypes });
    const seeded = this.deps.skillsRepo.seedBuiltIns();
    // Attach relevant skills to the project settings: skills implied by the
    // selected capabilities + keyword matches on the description/tech hints.
    const implied = skillsForCapabilities(project.capabilities);
    const known = new Set(this.deps.skillsRepo.findMany().map((r) => r.data.slug));
    const relevant = this.deps.skillsRepo
      .findMany()
      .filter((r) => this.skillsRelevant(r.data.slug, tech, project))
      .map((r) => r.data.slug);
    const skills = [...new Set([...implied.filter((s) => known.has(s)), ...relevant])];
    this.deps.projectRepo.upsert({ ...project, settings: { ...project.settings, skills } }, { key: project.slug });
    logger.info(`onboarded project ${projectId}`, { agents: agents.length, agentTypes: agentTypes.length, skills: skills.length });
    return { agents: agents.length, skills: seeded };
  }

  /** Seed a mock repository with a starter .ai-engineering structure for demos. */
  private ensureMockRepo(project: Project): void {
    if (this.deps.github.kind !== "mock") return;
    const mock = this.deps.github as unknown as {
      seedRepo(owner: string, name: string, opts?: { files?: Array<{ path: string; content: string }>; branch?: string; description?: string }): { owner: string; name: string };
    };
    for (const link of project.repositories.length ? project.repositories : [{ repo: project.configRepo, branch: project.branch, isConfigRepo: true }]) {
      const [owner, ...rest] = link.repo.split("/");
      const name = rest.join("/") || "repo";
      const starter = [{ path: "README.md", content: `# ${project.name}\n\n${project.description}\n` }];
      if (link.isConfigRepo) {
        starter.push(
          { path: ".ai-engineering/project.yaml", content: this.projectYaml(project) },
          { path: ".ai-engineering/rules/coding.md", content: "# Coding Rules\n- Follow existing conventions.\n- No secrets in code.\n" },
          { path: ".ai-engineering/rules/git.md", content: "# Git Rules\n- Feature branches, conventional commits, PRs.\n" },
        );
      }
      mock.seedRepo(owner, name, { files: starter, branch: link.branch, description: project.description });
      logger.debug(`seeded mock repo ${link.repo}`);
    }
  }

  private projectYaml(project: Project): string {
    const list = (values: string[]): string => (values.length ? values.map((v) => `\n    - ${v}`).join("") : " []");
    const c = project.capabilities;
    return [
      "project:",
      `  name: ${project.name}`,
      `  slug: ${project.slug}`,
      `  branch: ${project.branch}`,
      `  platforms:${list(c.platforms)}`,
      `  languages:${list(c.languages)}`,
      `  frameworks:${list(c.frameworks)}`,
      `  databases:${list(c.databases)}`,
      `  deployment:${list(c.deploymentTargets)}`,
      `  features:${list(c.features)}`,
      `  integrations:${list(c.integrations)}`,
      `  repositories:${list(project.repositories.map((r) => `${r.repo}@${r.branch} (${r.role})`))}`,
    ].join("\n");
  }

  /**
   * Decide whether a skill is relevant to a project. We match the skill's own
   * keyword tokens against the project profile (description / framework /
   * database / language / explicit tech hints), plus a small alias table for
   * common stacks (e.g. "sqlserver" <-> "sql server"). Unlike the old logic we do
   * NOT feed the skill's own slug into the search text (which made every skill
   * whose slug was a known needle "always relevant" regardless of the project).
   */
  private skillsRelevant(slug: string, tech: string[], project: Project): boolean {
    const c = project.capabilities;
    const capText = [...c.platforms, ...c.languages, ...c.frameworks, ...c.databases, ...c.deploymentTargets, ...c.features, ...c.integrations].join(" ");
    const projText =
      `${project.description} ${project.framework ?? ""} ${project.database ?? ""} ${project.primaryLanguage ?? ""} ${capText} ${tech.join(" ")}`.toLowerCase();
    const keywords = slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter(Boolean);
    const aliases: Record<string, string[]> = {
      sqlserver: ["sql server", "sqlserver", "mssql"],
      aspnetcore: ["asp.net", "aspnetcore", ".net"],
      dotnet: [".net", "dotnet", "c#"],
      csharp: ["c#", "csharp", ".net"],
      nodejs: ["node", "nodejs", "javascript"],
      postgresql: ["postgres", "postgresql"],
      testing: ["test", "testing", "qa"],
      docker: ["docker", "container", "compose"],
      github: ["github", "git"],
      git: ["github", "git"],
      security: ["security", "auth", "oauth"],
    };
    return keywords.some((w) => projText.includes(w) || (aliases[w] ?? []).some((a) => projText.includes(a)));
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
    const text = `${task.title} ${task.description}`.toLowerCase();
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
