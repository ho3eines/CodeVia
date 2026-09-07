import type { Agent, Skill, AgentType, Project, ProjectCapabilities, ProjectGithubConnection, ProjectRepositoryLink, Task, Workflow, WorkflowNode } from "../domain/entities.js";
import {
  agentTypesForProject,
  canonicalOption,
  configRepoOf,
  hydrateProject,
  legacyFieldsFromCapabilities,
  normalizeCapabilities,
  normalizeRepositories,
  optionLabel,
  skillsForCapabilities,
} from "../domain/project-options.js";
import type { ConversationRepository, MemoryRepository, ProjectRepository, TaskRepository, WorkflowRepository } from "../domain/repos.js";
import type { ProjectFilesService } from "../github/project-files.js";
import type { AgentRepository } from "./agent-repo.js";
import type { RunRepository, CostRepository, AuditRepository, NotificationRepository } from "../observability/repos.js";
import type { AgentRunner } from "./runner.js";
import { TaskCancelledError } from "./runner.js";
import { assertTaskActive, executionTask } from "./execution.js";
import { isWriter, repositoryForAgent } from "./implementation.js";
import type { WorkflowEngine } from "../workflow/engine.js";
import type { AgentRouter } from "./router.js";
import { AutonomousOrchestrator } from "./orchestrator.js";
import type { AgentGenerator } from "./generator.js";
import { ProjectStateCoordinator } from "./project-state.js";
import { ProjectStateGenerator } from "./state-generator.js";
import { SkillRegistry, type SkillRepository } from "../skills/registry.js";
import type { ModelRepository, ProviderRepository } from "../ai/model-repo.js";
import type { ProviderRegistry } from "../ai/provider-registry.js";
import type { IGitHubService } from "../github/types.js";
import { parseRepoFullName } from "../github/types.js";
import type { Permission } from "../types.js";
import { eventBus, generateCorrelationId } from "../events/bus.js";
import { live } from "../realtime/live.js";
import { logger } from "../logger.js";
import { randomUUID } from "node:crypto";
import { discoverProjectRules, rulesToStrings } from "./rules-discovery.js";

/** Marker prefix for rules produced by automatic discovery (re-generated on re-onboard). */
export const DISCOVERED_RULE_TAG = "<!-- discovered -->";

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
  /** Platform user who owns the new project (undefined = shared). */
  ownerId?: string;
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
  priority?: Task["priority"];
  agentType?: AgentType;
  workflowId?: string;
  input?: Record<string, unknown>;
  parentTaskId?: string;
}

export interface AgentManagerDeps {
  promptVersionRepo?: import("../prompts/versions.js").PromptVersionRepository;
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
  githubForProject?: (project: Project) => IGitHubService;
  /** Real-AI access for the autonomous task loop (optional — loop stays deterministic without it). */
  providerRegistry?: ProviderRegistry;
  /** DB memory index (optional — needed for the CodeVia/memory.md sync). */
  memoryRepo?: MemoryRepository;
  conversationRepo?: ConversationRepository;
  /** Project folder sync (optional — CodeVia/* files in the project repo). */
  projectFiles?: ProjectFilesService;
}

/**
 * Agent Manager — the central orchestrator. Determines which agent, model, skill,
 * tool, memory, and workflow are used for a task; chains agents (self-healing
 * feedback loops); enforces budgets; routes errors; and records audit + events.
 */
export class AgentManager {
  private readonly agentRouter: AgentRouter;
  private readonly inFlight = new Map<string, Promise<Task>>();
  private githubFor(project: Project): IGitHubService { return this.deps.githubForProject?.(project) ?? this.deps.github; }
  constructor(private readonly deps: AgentManagerDeps) {
    this.agentRouter = deps.agentRouter;
    if (deps.projectFiles && deps.memoryRepo && deps.providerRegistry) this.state = new ProjectStateCoordinator({
      projectRepo: deps.projectRepo, agentRepo: deps.agentRepo, taskRepo: deps.taskRepo, memoryRepo: deps.memoryRepo,
      skillRepo: deps.skillsRepo, workflowRepo: deps.workflowRepo, runRepo: deps.runRepo,
      files: deps.projectFiles, generator: deps.agentGenerator,
      ai: new ProjectStateGenerator({ modelRepo: deps.modelRepo, providerRepo: deps.providerRepo, providerRegistry: deps.providerRegistry, costRepo: deps.costRepo }),
      github: (p) => this.githubFor(p),
      inspect: async (p) => {
        const detected = await this.inspectRepository(p);
        const capabilities = this.mergeDetectedCapabilities(p.capabilities, detected.capabilities);
        return hydrateProject({ ...p, capabilities, ...legacyFieldsFromCapabilities(capabilities) });
      },
    });
  }
  private readonly state?: ProjectStateCoordinator;

  async readProject(projectId: string): Promise<Project> {
    const p = this.deps.projectRepo.findById(projectId)?.data;
    if (!p) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
    // Simulation mode may need the repository rebuilt before the first canonical
    // read; keep the DB state as the source while a mock repo is being recreated.
    await this.ensureProjectRepo(projectId);
    await this.deps.projectFiles?.restore(p);
    return hydrateProject(this.deps.projectRepo.findById(projectId)!.data);
  }

  /** Execution entry points hydrate then initialize missing definitions. */
  async refreshProject(projectId: string): Promise<Project> {
    await this.ensureProjectRepo(projectId);
    if (this.state) await this.state.ensure(projectId);
    const p = this.deps.projectRepo.findById(projectId)?.data;
    if (!p) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
    return hydrateProject(p);
  }

  /**
   * When Simulation/Mock mode is used, a missing configured repository must not
   * brick the project. Seed the missing mock repo(s), then mirror the current
   * database definitions into it so actions on the project keep working. This is
   * mock-only: a real GitHub outage still fails closed instead of substituting
   * cache for the repository.
   */
  private async ensureProjectRepo(projectId: string): Promise<void> {
    const stored = this.deps.projectRepo.findById(projectId)?.data;
    if (!stored || !this.deps.projectFiles) return;
    const project = hydrateProject(stored);
    const github = this.githubFor(project);
    if (github.kind !== "mock") return;
    const links = project.repositories.length ? project.repositories : [{ repo: project.configRepo, branch: project.branch }];
    const existing = new Set((await github.listRepositories({ limit: 1000 })).map((r) => r.fullName.toLowerCase()));
    const missing = links.some((link) => !existing.has(String(link.repo).toLowerCase()));
    if (!missing) return;
    if (this.deps.agentRepo.byProject(projectId).length) {
      // A repo already wiped/recreated from scratch in mock mode must not lose the
      // working agents/skills in the DB. Mirror current definitions without a
      // compare-and-swap baseline (this is explicitly a bootstrap, not a user edit).
      await this.syncProjectState(projectId, undefined, false);
    }
  }

  /* ---------------- Project onboarding ---------------- */

  async createProject(input: CreateProjectInput): Promise<Project> {
    const now = new Date().toISOString();
    const repositories = normalizeRepositories(input.repositories, { repo: input.configRepo, branch: input.branch });
    const cfg = configRepoOf(repositories);
    if (!cfg) {
      throw Object.assign(new Error("A GitHub repository (owner/name) is required — pick one from the connected account"), { statusCode: 400 });
    }
    if (this.deps.projectRepo.findMany().some(({ data: p }) => p.configRepo === cfg.repo && p.branch === cfg.branch)) throw Object.assign(new Error("This repository/branch is already linked. Reuse that project or select an independent repository/branch."), { statusCode: 409 });
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
      // Who owns it: per-user Telegram bots filter on this so one user's bot
      // cannot list (or drive) another user's repositories.
      ownerId: input.ownerId,
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
    // Onboarding may enrich capabilities/skills from the repository; return the
    // refreshed document so the API/UI immediately reflects the inspection.
    const final = this.deps.projectRepo.findById(project.id)?.data;
    return final ? hydrateProject(final) : project;
  }

  /** Restore first; author and commit ONLY missing definitions. Never regenerate existing agents. */
  async onboardProject(projectId: string, _tech: string[] = []): Promise<{ agents: number; skills: number; seeded: number }> {
    const stored = this.deps.projectRepo.findById(projectId)?.data;
    if (!stored) throw new Error(`Project ${projectId} not found`);
    await this.ensureMockRepo(hydrateProject(stored));
    const p = await this.refreshProject(projectId);
    return { agents: this.deps.agentRepo.byProject(projectId).length, skills: p.settings.skills.length, seeded: 0 };
  }

  /** AI fills new, omitted instructions; explicit user-authored text is never replaced. */
  async authorDefinition<T extends Agent | Skill>(project: Project, value: T, kind: "agent" | "skill"): Promise<T> {
    if (!this.deps.providerRegistry) throw new Error("AI provider registry is unavailable");
    const generator = new ProjectStateGenerator({ modelRepo: this.deps.modelRepo, providerRepo: this.deps.providerRepo, providerRegistry: this.deps.providerRegistry, costRepo: this.deps.costRepo });
    const reference = this.deps.agentRepo.byType(project.id, "research") ?? this.deps.agentGenerator.generate(project, { agentTypes: ["research"], persist: false })[0];
    const author = { ...reference, models: project.defaultModelId ? { primary: project.defaultModelId, fallbacks: [], specialized: {} } : kind === "agent" ? (value as Agent).models : reference.models };
    const result = await generator.generate(project, { agents: kind === "agent" ? [value as Agent] : [], skills: kind === "skill" ? [value as Skill] : [], workflows: [] }, author, project.description, this.githubFor(project).kind === "mock");
    return (kind === "agent" ? result.draft.agents[0] : result.draft.skills[0]) as T;
  }

  /** A user edit is acknowledged only after the repository accepts it. */
  async saveProject(input: Project): Promise<Project> {
    const old = this.deps.projectRepo.findById(input.id)?.data;
    const next = hydrateProject({ ...input, updatedAt: new Date().toISOString() });
    if (!old) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
    let targetRevision: string | undefined;
    if (next.configRepo !== old.configRepo || next.branch !== old.branch) {
      // Connection changes are explicit. Existing destination state wins; absent state
      // is migrated from the current project, never generated over another folder.
      await this.ensureMockRepo(next);
      const snapshot = await this.deps.projectFiles?.pull(next);
      targetRevision = snapshot?.sha;
      next.repositoryRevision = targetRevision;
      if (snapshot?.manifest) {
        this.deps.projectRepo.upsert(next, { key: next.slug });
        try {
          await this.deps.projectFiles!.restore(next, undefined, { snapshot });
          return hydrateProject(this.deps.projectRepo.findById(next.id)!.data);
        } catch (error) { this.deps.projectRepo.upsert(old, { key: old.slug }); throw error; }
      }
    }
    this.deps.projectRepo.upsert(next, { key: next.slug });
    try { await this.syncProjectState(next.id, targetRevision); }
    catch (error) { this.deps.projectRepo.upsert(old, { key: old.slug }); throw error; }
    return next;
  }

  /** Explicit user save/export. Runtime completion must use syncRuntimeState instead. */
  async syncProjectState(projectId: string, targetRevision?: string, checkConflicts = true): Promise<boolean> {
    const files = this.deps.projectFiles;
    const stored = this.deps.projectRepo.findById(projectId)?.data;
    if (!files || !stored) return false;
    const p = hydrateProject(stored);
    const agents = this.deps.agentRepo.byProject(projectId).map((a) => targetRevision ? { ...a, repositoryRevision: targetRevision } : a);
    const catalog = new Map(this.deps.skillsRepo.byProject(projectId).map((s) => [s.slug, s]));
    const visiting = new Set<string>();
    const include = (slug: string) => {
      if (visiting.has(slug)) return; visiting.add(slug);
      if (files.isTombstoned(p, `CodeVia/skills/${slug}.md`)) return;
      const skill = catalog.get(slug) ?? this.deps.skillsRepo.findBySlug(slug);
      if (!skill) throw new Error(`No definition for skill ${slug}; initialize missing repository state first`);
      catalog.set(slug, skill);
      for (const dependency of skill.dependencies) include(dependency);
    };
    for (const slug of [...p.settings.skills, ...agents.flatMap((a) => a.skills)]) include(slug);
    return files.syncAll(p, { promptVersions: this.deps.promptVersionRepo?.byProject(projectId).map((v) => targetRevision ? { ...v, repositoryRevision: targetRevision } : v), agents, tasks: this.deps.taskRepo.byProject(projectId), memory: this.deps.memoryRepo?.byProject(projectId) ?? [], skillCatalog: [...catalog.values()].map((s) => targetRevision ? { ...s, repositoryRevision: targetRevision } : s), workflows: this.deps.workflowRepo.byProject(projectId).map((w) => targetRevision ? { ...w, repositoryRevision: targetRevision } : w), runs: this.deps.runRepo.byProject(projectId), conversations: this.deps.conversationRepo?.findMany({ projectId }).map((r) => targetRevision ? { ...r.data, repositoryRevision: targetRevision } : r.data) }, { checkConflicts });
  }

  /** Save observed execution history without rewriting prompts, skills, rules or memory. */
  private async syncRuntimeState(projectId: string): Promise<void> {
    const p = this.deps.projectRepo.findById(projectId)?.data;
    if (!p || !this.deps.projectFiles) return;
    for (const task of this.deps.taskRepo.byProject(projectId)) await this.deps.projectFiles.syncTask(p, task);
    for (const run of this.deps.runRepo.byProject(projectId)) await this.deps.projectFiles.syncRun(p, run);
  }

  /** Best-effort: mirror one task into CodeVia/tasks/<id>.md (never throws). */
  async syncTaskFile(projectId: string, task: Task): Promise<boolean> {
    try {
      const files = this.deps.projectFiles;
      if (!files) return false;
      const stored = this.deps.projectRepo.findById(projectId)?.data;
      if (!stored) return false;
      return await files.syncTask(hydrateProject(stored), task);
    } catch (err) {
      logger.warn("syncTaskFile failed", { projectId, taskId: task.id, err: String(err) });
      return false;
    }
  }

  /**
   * Every project gets executable starter workflows that mirror the product
   * contract from the master prompt. They are generated from the enabled agent
   * roster, so a small project does not receive a workflow containing missing
   * specialist agents. Existing workflows are left intact (versioned user edits
   * must never be overwritten by onboarding).
   */
  private ensureDefaultWorkflows(project: Project): void {
    const existing = this.deps.workflowRepo.byProject(project.id);
    const existingSlugs = new Set(existing.map((w) => w.slug));
    const enabledTypes = new Set(this.deps.agentRepo.byProject(project.id).filter((a) => a.enabled).map((a) => a.type));
    const create = (slug: string, name: string, description: string, orderedAgents: AgentType[]): Workflow | undefined => {
      if (existingSlugs.has(slug)) return undefined;
      const agentNodes: WorkflowNode[] = orderedAgents
        .filter((type, index, arr) => enabledTypes.has(type) && arr.indexOf(type) === index)
        .map((type, i) => ({ id: `${slug}-${i + 1}-${type}`, type: "agent", name: type, config: { agentType: type }, retries: 1 }));
      if (!agentNodes.length) return undefined;
      const approval: WorkflowNode = {
        id: `${slug}-approval`,
        type: "approval",
        name: "Human approval before PR / merge / deploy",
        config: { message: "Review the agent result before any merge, deployment, migration, or other sensitive operation." },
        retries: 0,
      };
      const nodes = [...agentNodes, approval];
      const edges = nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));
      const workflow = this.deps.workflowRepo.create({
        projectId: project.id,
        name,
        slug,
        description,
        nodes,
        edges,
        enabled: true,
      });
      existingSlugs.add(slug);
      return workflow;
    };
    const created = [
      create("autonomous-development-loop", "Autonomous Development Loop", "Research → architecture → implementation → QA → security → code review → human approval.", ["research", "business-analyst", "system-architect", "backend-developer", "frontend-developer", "uiux", "documentation", "qa-test", "security", "code-reviewer"]),
      create("bug-diagnosis-loop", "Bug Diagnosis Loop", "Issue/test failure → diagnosis → responsible agent → QA → review → approval.", ["debugging", "database", "backend-developer", "frontend-developer", "uiux", "qa-test", "code-reviewer"]),
    ].filter(Boolean) as Workflow[];
    if (created.length) {
      const current = this.deps.projectRepo.findById(project.id)?.data ?? project;
      this.deps.projectRepo.upsert(
        { ...current, settings: { ...current.settings, workflows: [...new Set([...(current.settings.workflows ?? []), ...created.map((w) => w.id)])] }, updatedAt: new Date().toISOString() },
        { key: current.slug },
      );
    }
  }

  /* ------------------------------------------------------------------ *
   * Repository inspection
   * ------------------------------------------------------------------ */

  /** Inspect linked repositories and return a stack profile + skill slugs. */
  async inspectRepository(project: Project): Promise<{ capabilities: ProjectCapabilities; files: string[]; skills: Set<string> }> {
    const files: string[] = [];
    let fetched = 0;
    for (const link of project.repositories) {
      const ref = parseRepoFullName(link.repo);
      if (!ref) continue;
      try {
        const entries = await this.githubFor(project).listFiles(ref, link.branch);
        files.push(...entries.map((e) => e.path));
        fetched += entries.length;
        if (fetched >= 6000) break;
      } catch (err) {
        logger.warn(`inspect repository failed for ${link.repo}`, { err: String(err) });
      }
    }
    const low = files.map((p) => p.toLowerCase());
    const read = async (paths: string[]): Promise<string[]> => {
      const out: string[] = [];
      for (const p of paths.slice(0, 24)) {
        for (const link of project.repositories) {
          const ref = parseRepoFullName(link.repo);
          if (!ref) continue;
          try {
            const f = await this.githubFor(project).getFile(ref, p, link.branch);
            if (f) { out.push(f.content); break; }
          } catch { /* ignore individual misses during advisory onboarding */ }
        }
      }
      return out;
    };

    // Files that commonly define the stack.
    const configFiles = files.filter((path) => { const p = path.split("/").pop()!.toLowerCase(); return /^appsettings(\.[^/]+)?\.json$/.test(p) || /\.(csproj|fsproj|vbp)$/.test(p) || /^package\.json$/.test(p) || /^go\.mod$/.test(p) || /^pyproject\.toml$/.test(p) || /^requirements\.txt$/.test(p) || p.endsWith(".sql"); });
    const contents = await read(configFiles);
    const combined = `${contents.join("\n").toLowerCase()}\n${files.join("\n").toLowerCase()}\n${project.description} ${project.name}`;

    const languages: string[] = [];
    const frameworks: string[] = [];
    const databases: string[] = [];
    const skills = new Set<string>();

    const languageRules: Array<[RegExp, string]> = [
      [/\.cs$|\.csproj$|\.sln$|\.razor$|\.cshtml$/, "csharp"],
      [/\.tsx?$/, "typescript"],
      [/\.jsx?$|package\.json/, "javascript"],
      [/\.py$/, "python"],
      [/\.java$/, "java"],
      [/\.kt$/, "kotlin"],
      [/\.swift$/, "swift"],
      [/\.dart$/, "dart"],
      [/\.go$/, "go"],
      [/\.rs$/, "rust"],
      [/\.php$/, "php"],
      [/\.rb$/, "ruby"],
      [/\.h$|\.hpp$|\.cpp$|\.c$/, "cpp"],
      [/\.sql$/, "sql"],
      [/\.sh$|\.ps1$/, "shell"],
    ];
    for (const [re, lang] of languageRules) if (new RegExp(re.source, "im").test(combined)) languages.push(lang);

    const frameworkRules: Array<[RegExp, string]> = [
      [/\basp\.net|aspnetcore|mvc\b/, "aspnetcore"],
      [/\bmudblazor\b/, "mudblazor"],
      [/\.razor$|\.cshtml$|\bblazor\b/, "blazor"],
      [/\bdotnet\b|\.csproj|\.sln/, "dotnet"],
      [/\"react\"|'react'|react-dom/, "react"],
      [/\bnext\.js|nextjs\b/, "nextjs"],
      [/\bvue\b|\.vue$/, "vue"],
      [/\bangular\b/, "angular"],
      [/\.html$/, "html"],
      [/\.css$|\.scss$|\.sass$|\.less$/, "css"],
      [/\bnode\.js|nodejs|npm\b/, "nodejs-express"],
      [/\bflutter\b|\.dart$/, "flutter"],
      [/\.tailwind|tailwindcss\b/, "tailwind"],
    ];
    for (const [re, fw] of frameworkRules) if (new RegExp(re.source, "im").test(combined)) frameworks.push(fw);

    const databaseRules: Array<[RegExp, string]> = [
      [/\bsqlserver\b|microsoft\.data\.sqlclient|system\.data\.sqlclient|server=|user id=.*sql/, "sqlserver"],
      [/\boracle\b|oracle\.manageddataaccess|system\.data\.oracleclient/, "oracle"],
      [/\bsqlite\b|microsoft\.data\.sqlite|sqlite3\b/, "sqlite"],
      [/\bpostgres\b|npgsql|pg_dump\b/, "postgresql"],
      [/\bmongodb\b|mongodb\.driver|mongoose\b/, "mongodb"],
      [/\bredis\b|stackexchange\.redis|redis\b/, "redis"],
      [/\bmysql\b|mariadb\b|microsoft\.data\.mysql\b/, "mysql"],
    ];
    for (const [re, db] of databaseRules) if (re.test(combined)) databases.push(db);

    // Map detected values to canonical ids and carry their leaf skill slugs.
    const cap = normalizeCapabilities({
      languages,
      frameworks,
      databases,
      platforms: low.some((p) => /\.html$|index\.html|\.razor$|\.jsx?$|\.tsx?$/.test(p)) ? ["web"] : [],
    });
    for (const s of skillsForCapabilities(cap)) skills.add(s);

    return { capabilities: cap, files, skills };
  }

  private mergeDetectedCapabilities(current: ProjectCapabilities, detected: ProjectCapabilities): ProjectCapabilities {
    const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
    // Database is single-select by design; a detected database fills the slot
    // only when the user has not explicitly chosen one.
    const databases = current.databases.length ? current.databases : detected.databases;
    return normalizeCapabilities({
      ...current,
      languages: union(current.languages, detected.languages),
      frameworks: union(current.frameworks, detected.frameworks),
      databases,
      platforms: union(current.platforms, detected.platforms),
    });
  }

  /** Inspect/ensure the repository Agent.md file (the project's AI brief). */
  private async ensureAgentMd(project: Project, detectedFiles: string[]): Promise<void> {
    const cfg = configRepoOf(project.repositories);
    if (!cfg) return;
    const ref = parseRepoFullName(cfg.repo);
    if (!ref) return;
    const path = "Agent.md";
    const body = this.buildAgentMd(project, detectedFiles);
    try {
      const existing = await this.githubFor(project).getFile(ref, path, cfg.branch);
      if (existing && this.agentMdLooksCurrent(existing.content, project.capabilities)) return;
      await this.githubFor(project).commit(ref, cfg.branch, `docs: ensure Agent.md for ${project.name}`, [{ path, content: body }]);
      logger.info("Agent.md ensured", { repo: cfg.repo, branch: cfg.branch });
    } catch (err) {
      logger.warn("could not create/update Agent.md", { repo: cfg.repo, err: String(err) });
    }
  }

  private agentMdLooksCurrent(content: string, _c: ProjectCapabilities): boolean {
    // CodeVia-generated Agent.md is detected by its heading structure; avoid
    // rewriting a valid brief on every onboarding/re-onboard.
    return content.includes("# Project") && content.includes("## Stack") && content.includes("## Repositories");
  }

  private buildAgentMd(project: Project, files: string[]): string {
    const c = project.capabilities;
    const list = (v: string[]) => (v.length ? v.join(", ") : "—");
    const labelList = (dim: "languages" | "frameworks" | "databases" | "platforms" | "deploymentTargets" | "features" | "integrations", v: string[]) =>
      v.length ? v.map((x) => optionLabel(dim, x)).join(", ") : "—";
    return [
      `# Project`,
      ``,
      `> Auto-generated by CodeVia from ${project.configRepo}@${project.branch}.`,
      ``,
      `## Purpose`,
      `**${project.name}** — ${project.description || "AI engineering project"}`,
      ``,
      `## Stack`,
      `- Languages: ${labelList("languages", c.languages)}`,
      `- Frameworks: ${labelList("frameworks", c.frameworks)}`,
      `- Database: ${labelList("databases", c.databases)}`,
      `- Platforms: ${labelList("platforms", c.platforms)}`,
      `- Deploy: ${labelList("deploymentTargets", c.deploymentTargets)}`,
      `- Features: ${labelList("features", c.features)}`,
      `- Integrations: ${labelList("integrations", c.integrations)}`,
      ``,
      `## Repositories`,
      ...project.repositories.map((r) => `- ${r.repo} @ ${r.branch} (${r.role}${r.isConfigRepo ? ", config" : ""})`),
      ``,
      `## Skills`,
      list(project.settings.skills),
      ``,
      `## Structure`,
      `Detected ${files.length} file(s) on branch ${project.branch}.`,
      ``,
      `## Rules`,
      `- Follow existing conventions in this repository.`,
      `- Never commit secrets or API keys.`,
      `- Keep changes small and open a pull request for non-trivial work.`,
      ``,
    ].join("\n");
  }

  /**
   * Seed a mock repository with a starter .ai-engineering structure for demos.
   * Returns true when at least one linked simulated repository had to be created.
   * Production connections are never created by the platform.
   */
  private async ensureMockRepo(project: Project): Promise<boolean> {
    const github = this.githubFor(project);
    if (github.kind !== "mock") return false;
    const mock = github as unknown as {
      seedRepo(owner: string, name: string, opts?: { files?: Array<{ path: string; content: string }>; branch?: string; description?: string }): { owner: string; name: string };
    };
    const links: Array<{ repo: string; branch: string; isConfigRepo?: boolean }> = project.repositories.length
      ? project.repositories.map((r) => ({ repo: r.repo, branch: r.branch, isConfigRepo: r.isConfigRepo }))
      : [{ repo: project.configRepo, branch: project.branch, isConfigRepo: true }];
    const existing = new Set((await github.listRepositories({ limit: 1000 })).map((r) => r.fullName.toLowerCase()));
    let seeded = false;
    for (const link of links) {
      const [owner, ...rest] = link.repo.split("/");
      const name = rest.join("/") || "repo";
      if (!owner || !name) continue;
      const exists = existing.has(`${owner}/${name}`.toLowerCase());
      if (!exists) seeded = true;
      const starter = [{ path: "README.md", content: `# ${project.name}\n\n${project.description}\n` }];
      starter.push(...this.mockStackFiles(project));
      if (link.isConfigRepo) {
        starter.push(
          { path: "Agent.md", content: this.buildAgentMd(project, starter.map((f) => f.path)) },
        );
      }
      // seedRepo merges missing files into an existing simulated repo, so demo
      // repositories get the same starter/stack signals as newly created ones.
      mock.seedRepo(owner, name, { files: starter, branch: link.branch, description: project.description });
      if (!exists) logger.debug(`seeded mock repo ${link.repo}`);
    }
    return seeded;
  }

  /** Representative files used by MockGitHubService so repo inspection works offline. */
  private mockStackFiles(project: Project): Array<{ path: string; content: string }> {
    const c = project.capabilities;
    const files: Array<{ path: string; content: string }> = [];
    const has = (items: string[], v: string) => items.some((x) => x === v || x.includes(v));
    if (has(c.frameworks, "mudblazor") || has(c.frameworks, "blazor") || has(c.frameworks, "dotnet")) {
      const mud = has(c.frameworks, "mudblazor") ? `\n    <PackageReference Include="MudBlazor" Version="7.0.0" />` : "";
      files.push({ path: "src/MyApp/MyApp.csproj", content: `<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n  <ItemGroup>${mud}</ItemGroup>\n</Project>\n` });
    }
    if (has(c.databases, "sqlserver") || has(c.databases, "sqlite") || has(c.databases, "oracle") || has(c.databases, "postgresql")) {
      const db = c.databases[0];
      const cs = db === "sqlserver" ? "Server=.;Database=app;Trusted_Connection=True" : db === "sqlite" ? "Data Source=app.db" : db === "oracle" ? "User Id=app;Password=****;Data Source=ORCL" : "Host=localhost;Database=app";
      files.push({ path: "src/MyApp/appsettings.json", content: JSON.stringify({ ConnectionStrings: { Default: cs } }, null, 2) + "\n" });
    }
    if (has(c.frameworks, "react") || has(c.frameworks, "nextjs") || has(c.languages, "typescript")) {
      files.push({ path: "package.json", content: JSON.stringify({ name: project.slug, dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } }, null, 2) + "\n" });
    }
    if (has(c.frameworks, "html") || has(c.frameworks, "css")) {
      files.push({ path: "index.html", content: `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>${project.name}</h1></body></html>\n` });
      files.push({ path: "styles.css", content: `body { font-family: sans-serif; }\n` });
    }
    return files;
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
      priority: input.priority ?? "medium",
      status: "created",
      agentType: input.agentType,
      correlationId: generateCorrelationId(),
      input: input.input ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.deps.taskRepo.upsert(task, { projectId: input.projectId, parentId: input.parentTaskId });
    void eventBus.publish("task.created", { taskId: task.id, projectId: input.projectId }, { correlationId: task.correlationId, projectId: input.projectId });
    // Fire-and-forget: the task file appears in the repo folder (createTask stays sync).
    void this.syncTaskFile(input.projectId, task);
    return task;
  }

  /** Execute a task by routing to the right agent or running a workflow. */
  isTaskRunning(taskId: string): boolean { return this.inFlight.has(taskId); }

  runTask(taskId: string): Promise<Task> {
    try { taskId = executionTask(this.deps.taskRepo, taskId).id; } catch (err) { return Promise.reject(err); }
    const existing = this.inFlight.get(taskId);
    if (existing) return existing;
    const pending = this.executeTask(taskId).finally(() => this.inFlight.delete(taskId));
    this.inFlight.set(taskId, pending);
    return pending;
  }

  private async executeTask(taskId: string): Promise<Task> {
    const task = this.deps.taskRepo.findById(taskId)?.data;
    if (!task) throw new Error(`Task ${taskId} not found`);
    const project = await this.refreshProject(task.projectId);

    assertTaskActive(this.deps.taskRepo, task);
    this.deps.taskRepo.upsert({ ...task, status: "running", error: undefined }, { projectId: task.projectId, parentId: task.parentTaskId });
    live.emit({ type: "task.updated", taskId, data: { status: "running" } });

    try {
      if ((task.input as Record<string, unknown> | undefined)?.executionMode === "autonomous" && !task.workflowId) {
        // Autonomous task loop: research → breakdown → implement → QA gate → fix loop.
        const orchestrator = new AutonomousOrchestrator({
          projectRepo: this.deps.projectRepo,
          taskRepo: this.deps.taskRepo,
          agentRepo: this.deps.agentRepo,
          agentRunner: this.deps.agentRunner,
          agentRouter: this.agentRouter,
          github: this.githubFor(project),
          githubForProject: this.deps.githubForProject,
          modelRepo: this.deps.modelRepo,
          providerRepo: this.deps.providerRepo,
          providerRegistry: this.deps.providerRegistry,
          skillsRegistry: new SkillRegistry(this.deps.skillsRepo),
          files: this.deps.projectFiles,
          memoryRepo: this.deps.memoryRepo,
        });
        const summary = await orchestrator.run(taskId);
        assertTaskActive(this.deps.taskRepo, task);
        const current = this.deps.taskRepo.findById(taskId)!.data;
        this.deps.taskRepo.upsert({ ...current, result: { ...current.result, ...summary } }, { projectId: task.projectId, parentId: task.parentTaskId });
      } else if (task.workflowId) {
        const workflow = this.deps.workflowRepo.findById(task.workflowId)?.data;
        if (!workflow) throw new Error(`Workflow ${task.workflowId} not found`);
        const result = await this.deps.workflowEngine.run(workflow, project, task, task.input);
        const current = this.deps.taskRepo.findById(taskId)?.data;
        if (!current) throw new TaskCancelledError(taskId);
        this.deps.taskRepo.upsert({ ...current, result: { ...result } }, { projectId: task.projectId, parentId: task.parentTaskId });
        if (result.status === "cancelled") throw new TaskCancelledError(taskId);
        if (result.status === "waiting_for_approval") {
          const waiting: Task = { ...this.deps.taskRepo.findById(taskId)!.data, status: "waiting_for_approval", approvalRequired: true, updatedAt: new Date().toISOString() };
          this.deps.taskRepo.upsert(waiting, { projectId: task.projectId, parentId: task.parentTaskId });
          live.emit({ type: "task.updated", taskId, data: { status: "waiting_for_approval" } });
          return waiting;
        }
        if (result.status === "failed") {
          const failedNodes = result.trace.filter((t) => t.status === "failed").map((t) => t.node);
          throw Object.assign(new Error(
            `Workflow "${workflow.name}" failed${failedNodes.length ? ` at: ${failedNodes.join(", ")}` : ""}${result.error ? `: ${result.error}` : ""}`,
          ), { retryable: false });
        }
      } else {
        await this.routeAndRun(task, project);
      }
      const prev = this.deps.taskRepo.findById(taskId)?.data!;
      if (prev.status === "cancelled") throw new TaskCancelledError(taskId);
      const done: Task = { ...prev, status: "succeeded", error: undefined, updatedAt: new Date().toISOString() };
      this.deps.taskRepo.upsert(done, { projectId: task.projectId, parentId: task.parentTaskId });
      live.emit({ type: "task.updated", taskId, data: { status: "succeeded" } });
      await this.syncRuntimeState(task.projectId);
      return done;
    } catch (err) {
      const failed = this.deps.taskRepo.findById(taskId)?.data!;
      if (!failed) throw err;
      if (err instanceof TaskCancelledError || failed.status === "cancelled") {
        logger.info("runTask cancelled", { taskId });
        this.deps.taskRepo.upsert({ ...failed, status: "cancelled", updatedAt: new Date().toISOString() }, { projectId: task.projectId, parentId: task.parentTaskId });
        live.emit({ type: "task.updated", taskId, data: { status: "cancelled" } });
        await this.syncRuntimeState(task.projectId);
        return this.deps.taskRepo.findById(taskId)!.data;
      }
      logger.error("runTask failed", { taskId, err: String(err) });
      this.deps.taskRepo.upsert({ ...failed, status: "failed", error: String(err), updatedAt: new Date().toISOString() }, { projectId: task.projectId, parentId: task.parentTaskId });
      live.emit({ type: "task.updated", taskId, data: { status: "failed", error: String(err) } });
      await this.syncRuntimeState(task.projectId);
      throw err;
    }
  }

  private async routeAndRun(task: Task, project: Project): Promise<void> {
    const type = task.agentType ?? this.agentRouter.route(`${task.title} ${task.description}`);
    const agent = this.deps.agentRepo.byType(project.id, type);
    if (!agent) {
      throw new Error(`No enabled agent of type ${type} in project ${project.id}`);
    }
    this.deps.taskRepo.upsert({ ...this.deps.taskRepo.findById(task.id)!.data, assignedAgentId: agent.id }, { projectId: task.projectId, parentId: task.parentTaskId });
    const run = await this.deps.agentRunner.run({ task, agent, project, repository: isWriter(type) ? repositoryForAgent(project, type) : undefined });
    assertTaskActive(this.deps.taskRepo, task);
    const current = this.deps.taskRepo.findById(task.id)!.data;
    this.deps.taskRepo.upsert({ ...current, result: { runId: run.id, summary: run.summary, verification: run.verification, skills: run.skills, artifacts: run.steps.filter((s) => ["write_file", "create_pull_request"].includes(s.tool ?? "")).map((s) => s.data) } }, { projectId: task.projectId, parentId: task.parentTaskId });
    if (run.status !== "succeeded") {
      throw Object.assign(new Error(run.error ?? `${agent.name} failed`), { retryable: false });
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
