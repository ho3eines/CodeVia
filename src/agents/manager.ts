import type { AgentType, Project, ProjectCapabilities, ProjectGithubConnection, ProjectRepositoryLink, Task, Workflow, WorkflowNode } from "../domain/entities.js";
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
import type { ProjectRepository, TaskRepository, WorkflowRepository } from "../domain/repos.js";
import type { AgentRepository } from "./agent-repo.js";
import type { RunRepository, CostRepository, AuditRepository, NotificationRepository } from "../observability/repos.js";
import type { AgentRunner } from "./runner.js";
import { TaskCancelledError } from "./runner.js";
import type { WorkflowEngine } from "../workflow/engine.js";
import type { AgentRouter } from "./router.js";
import type { AgentGenerator } from "./generator.js";
import type { SkillRepository } from "../skills/registry.js";
import type { ModelRepository, ProviderRepository } from "../ai/model-repo.js";
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

  /** Online onboarding: analyze repo, generate agents/skills/workflows/rules. */
  async onboardProject(projectId: string, tech: string[] = []): Promise<{ agents: number; skills: number }> {
    const stored = this.deps.projectRepo.findById(projectId)?.data;
    if (!stored) throw new Error(`Project ${projectId} not found`);
    const project = hydrateProject(stored);
    // In mock mode, seed a starter .ai-engineering repo so the platform can be
    // exercised end-to-end without real GitHub credentials.
    this.ensureMockRepo(project);

    // Analyse the linked repositories (real or mock): detect stack, ensure
    // Agent.md, and surface the detected skill/agent hints to onboarding.
    const detected = await this.inspectRepository(project);
    const mergedCapabilities = this.mergeDetectedCapabilities(project.capabilities, detected.capabilities);
    const refreshed = hydrateProject({
      ...project,
      capabilities: mergedCapabilities,
      ...legacyFieldsFromCapabilities(mergedCapabilities),
    });

    await this.ensureAgentMd(refreshed, detected.files);
    const agentTypes = agentTypesForProject(refreshed.capabilities);
    const agents = this.deps.agentGenerator.generate(refreshed, { defaultModelId: refreshed.defaultModelId, tech, agentTypes });
    const seeded = this.deps.skillsRepo.seedBuiltIns();
    // Attach relevant skills to the project settings: skills implied by the
    // selected capabilities + detected stack + keyword matches on the text.
    const implied = skillsForCapabilities(refreshed.capabilities);
    const known = new Set(this.deps.skillsRepo.findMany().map((r) => r.data.slug));
    const relevant = this.deps.skillsRepo
      .findMany()
      .filter((r) => this.skillsRelevant(r.data.slug, tech, refreshed) || detected.skills.has(r.data.slug))
      .map((r) => r.data.slug);
    const skills = [...new Set([...implied.filter((s) => known.has(s)), ...relevant])];
    // Automatic rules discovery: README/CONTRIBUTING/CODEOWNERS/.editorconfig/
    // build files → project rules injected into every agent prompt. User-authored
    // rules (anything not tagged as discovered) are preserved.
    const discovered = rulesToStrings(await discoverProjectRules(this.deps.github, refreshed, detected.files)).map((r) => `${DISCOVERED_RULE_TAG}\n${r}`);
    const manual = refreshed.settings.rules.filter((r) => !r.startsWith(DISCOVERED_RULE_TAG));
    const rules = [...manual, ...discovered];
    const updatedProject = { ...refreshed, settings: { ...refreshed.settings, skills, rules } };
    this.deps.projectRepo.upsert(updatedProject, { key: refreshed.slug });
    this.ensureDefaultWorkflows(updatedProject);
    logger.info(`onboarded project ${projectId}`, {
      agents: agents.length,
      agentTypes: agentTypes.length,
      skills: skills.length,
      rules: discovered.length,
      detected: { languages: detected.capabilities.languages, frameworks: detected.capabilities.frameworks, databases: detected.capabilities.databases },
    });
    return { agents: agents.length, skills: seeded };
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
      create("autonomous-development-loop", "Autonomous Development Loop", "Research → architecture → implementation → QA → security → code review → human approval.", ["research", "business-analyst", "system-architect", "backend-developer", "frontend-developer", "uiux", "qa-test", "security", "code-reviewer", "documentation"]),
      create("bug-diagnosis-loop", "Bug Diagnosis Loop", "Issue/test failure → diagnosis → responsible agent → QA → review → approval.", ["qa-test", "debugging", "backend-developer", "frontend-developer", "uiux", "database", "qa-test", "code-reviewer"]),
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
        const entries = await this.deps.github.listFiles(ref, link.branch);
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
        const ref = parseRepoFullName(project.repositories[0]?.repo ?? project.configRepo);
        if (!ref) continue;
        try {
          const f = await this.deps.github.getFile(ref, p, project.branch);
          if (f) out.push(f.content);
        } catch { /* ignore individual misses */ }
      }
      return out;
    };

    // Files that commonly define the stack.
    const configFiles = low.filter((p) => /^appsettings(\.[^/]+)?\.json$/.test(p) || /\.(csproj|fsproj|vbp)$/.test(p) || /^package\.json$/.test(p) || /^go\.mod$/.test(p) || /^pyproject\.toml$/.test(p) || /^requirements\.txt$/.test(p) || p.endsWith(".sql"));
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
    for (const [re, lang] of languageRules) if (re.test(combined)) languages.push(lang);

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
    for (const [re, fw] of frameworkRules) if (re.test(combined)) frameworks.push(fw);

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
      const existing = await this.deps.github.getFile(ref, path, cfg.branch);
      if (existing && this.agentMdLooksCurrent(existing.content, project.capabilities)) return;
      const parentSha = existing?.sha ?? undefined;
      await this.deps.github.commit(ref, cfg.branch, `docs: ensure Agent.md for ${project.name}`, [{ path, content: body }], parentSha);
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
      starter.push(...this.mockStackFiles(project));
      if (link.isConfigRepo) {
        starter.push(
          { path: "Agent.md", content: this.buildAgentMd(project, starter.map((f) => f.path)) },
          { path: ".ai-engineering/project.yaml", content: this.projectYaml(project) },
          { path: ".ai-engineering/rules/coding.md", content: "# Coding Rules\n- Follow existing conventions.\n- No secrets in code.\n" },
          { path: ".ai-engineering/rules/git.md", content: "# Git Rules\n- Feature branches, conventional commits, PRs.\n" },
        );
      }
      mock.seedRepo(owner, name, { files: starter, branch: link.branch, description: project.description });
      logger.debug(`seeded mock repo ${link.repo}`);
    }
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
      if (prev.status === "cancelled") throw new TaskCancelledError(taskId);
      const done: Task = { ...prev, status: "succeeded", updatedAt: new Date().toISOString() };
      this.deps.taskRepo.upsert(done, { projectId: task.projectId, parentId: task.parentTaskId });
      live.emit({ type: "task.updated", taskId, data: { status: "succeeded" } });
      return done;
    } catch (err) {
      const failed = this.deps.taskRepo.findById(taskId)?.data!;
      if (err instanceof TaskCancelledError || failed.status === "cancelled") {
        logger.info("runTask cancelled", { taskId });
        this.deps.taskRepo.upsert({ ...failed, status: "cancelled", updatedAt: new Date().toISOString() }, { projectId: task.projectId, parentId: task.parentTaskId });
        live.emit({ type: "task.updated", taskId, data: { status: "cancelled" } });
        return this.deps.taskRepo.findById(taskId)!.data;
      }
      logger.error("runTask failed", { taskId, err: String(err) });
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
