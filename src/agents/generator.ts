import type { Agent, AgentType, Project } from "../domain/entities.js";
import type { AgentRepository } from "./agent-repo.js";
import type { SkillRepository } from "../skills/registry.js";
import type { ModelRepository } from "../ai/model-repo.js";
import type { IModelProvider } from "../ai/types.js";
import { logger } from "../logger.js";
import { randomUUID } from "node:crypto";

/** Per-agent-type scaffolding: role, mission, skills, tools, permissions. */
const AGENT_SCAFFOLD: Record<
  AgentType,
  { role: string; mission: string; skills: string[]; tools: string[]; permissions: string[] }
> = {
  orchestrator: {
    role: "Orchestrator",
    mission: "Decide which agent, model, skill, tool, memory, and workflow to use for each task. Coordinate agent chains and approvals.",
    skills: [],
    tools: [],
    permissions: ["github.read", "memory.read"],
  },
  "project-manager": {
    role: "Project Manager",
    mission: "Break down work, order tasks, and track the project's shared state (sprint, objective, open tasks).",
    skills: [],
    tools: ["search"],
    permissions: ["project.read", "memory.read"],
  },
  research: {
    role: "Research Agent",
    mission: "Analyze the problem, extract requirements, research sources, compare architectures, and produce structured findings in knowledge memory.",
    skills: ["microservices", "restapi"],
    tools: ["search", "save_memory"],
    permissions: ["github.read", "memory.read", "memory.write"],
  },
  "business-analyst": {
    role: "Business Analyst",
    mission: "Extract business requirements, acceptance criteria, and user stories from the request.",
    skills: [],
    tools: ["search"],
    permissions: ["project.read", "memory.read"],
  },
  "system-architect": {
    role: "System Architect",
    mission: "Define architecture, boundaries, and high-level design. Preserve the existing architecture unless there is a clear reason to change it.",
    skills: ["microservices", "restapi"],
    tools: ["list_branches", "read_file", "save_memory"],
    permissions: ["github.read", "memory.read"],
  },
  "backend-developer": {
    role: "Backend Developer",
    mission: "Inspect the repository before writing code; implement, build, and test backend changes; commit on a branch and open a PR.",
    skills: ["dotnet", "csharp", "aspnetcore", "nodejs", "restapi", "testing"],
    tools: ["list_branches", "list_commits", "read_file", "write_file", "run_build", "run_tests", "create_pull_request", "create_branch", "search", "save_memory"],
    permissions: ["github.read", "github.write", "repository.write", "memory.write"],
  },
  "frontend-developer": {
    role: "Frontend Developer",
    mission: "Inspect existing UI/components/styling before changing code; implement frontend changes and verify them with tests/build.",
    skills: ["react", "blazor", "ui-design", "testing"],
    tools: ["read_file", "write_file", "run_build", "run_tests", "create_branch", "create_pull_request"],
    permissions: ["github.read", "github.write", "repository.write"],
  },
  uiux: {
    role: "UI/UX Agent",
    mission: "Review existing UI and design system, find UX problems, propose and implement UI improvements, keep accessibility and responsive design in mind.",
    skills: ["ui-design", "ux", "react", "blazor"],
    tools: ["read_file", "write_file", "create_branch", "create_pull_request"],
    permissions: ["github.read", "github.write", "memory.write"],
  },
  database: {
    role: "Database Agent",
    mission: "Design and review schema, indexes, and migrations. Never run a destructive migration without approval.",
    skills: ["sqlserver", "postgresql"],
    tools: ["list_branches", "read_file", "write_file", "create_branch", "create_pull_request"],
    permissions: ["github.read", "github.write"],
  },
  devops: {
    role: "DevOps Agent",
    mission: "Own Docker, CI/CD, deployments, and infrastructure as code. Production deploys require approval.",
    skills: ["docker", "git", "github"],
    tools: ["run_build", "list_branches", "read_file"],
    permissions: ["github.read", "deployment.write"],
  },
  "qa-test": {
    role: "QA/Test Agent",
    mission: "Detect affected files, run tests/static analysis/security scans, classify failures, and route them to the responsible agent.",
    skills: ["testing", "playwright"],
    tools: ["run_tests", "run_build", "search"],
    permissions: ["github.read", "memory.read", "memory.write"],
  },
  security: {
    role: "Security Agent",
    mission: "Audit for vulnerabilities, secrets hygiene, input validation, and OWASP issues. Flag dangerous changes for approval. Read-first.",
    skills: ["security"],
    tools: ["read_file", "search"],
    permissions: ["github.read", "memory.read"],
  },
  "code-reviewer": {
    role: "Code Reviewer",
    mission: "Review PRs and diffs for correctness, quality, and standards; report findings and risks.",
    skills: ["git", "github", "security", "testing"],
    tools: ["list_commits", "read_file", "search"],
    permissions: ["github.read", "memory.read"],
  },
  documentation: {
    role: "Documentation Agent",
    mission: "Keep architecture, API, setup, and README documentation up to date alongside code changes.",
    skills: [],
    tools: ["read_file", "write_file", "create_branch", "create_pull_request"],
    permissions: ["github.read", "github.write"],
  },
  debugging: {
    role: "Debugging Agent",
    mission: "Reproduce and diagnose failures, find root cause, and hand off to the appropriate fixer agent with a diagnosis.",
    skills: ["testing"],
    tools: ["list_commits", "read_file", "run_tests", "search", "save_memory"],
    permissions: ["github.read", "memory.read", "memory.write"],
  },
  refactoring: {
    role: "Refactoring Agent",
    mission: "Improve code structure and remove duplication without changing behavior; preserve tests.",
    skills: ["testing", "dotnet", "nodejs"],
    tools: ["read_file", "write_file", "run_tests", "create_branch", "create_pull_request"],
    permissions: ["github.read", "github.write"],
  },
  performance: {
    role: "Performance Agent",
    mission: "Profile and optimize hot paths, caching, and queries; measure before and after.",
    skills: ["performance"],
    tools: ["read_file", "write_file", "run_build", "create_branch", "create_pull_request"],
    permissions: ["github.read", "github.write"],
  },
  release: {
    role: "Release Agent",
    mission: "Prepare releases, tags, notes, and PRs. Production deploys require human approval.",
    skills: ["docker", "git", "github"],
    tools: ["list_commits", "create_pull_request", "create_branch", "merge_pull_request"],
    permissions: ["github.read", "github.write", "deployment.write"],
  },
};

const AGENT_TYPES: AgentType[] = [
  "orchestrator",
  "project-manager",
  "research",
  "business-analyst",
  "system-architect",
  "backend-developer",
  "frontend-developer",
  "uiux",
  "database",
  "devops",
  "qa-test",
  "security",
  "code-reviewer",
  "documentation",
  "debugging",
  "refactoring",
  "performance",
  "release",
];

export interface GenerateAgentOptions {
  defaultModelId?: string;
  /** Technology hints gathered from onboarding / repository analysis. */
  tech?: string[];
  /**
   * Agent roster to generate (derived from the project's multi-select
   * capabilities). Defaults to all 18 types. Agents of the project that are
   * NOT in the roster are disabled (never deleted — re-onboarding can re-enable).
   */
  agentTypes?: AgentType[];
}

/**
 * AI Agent Generator — produces a full roster of agent definitions for a project
 * from its description, technology, repo, and requirements. Deterministic
 * templates produce a sensible baseline; a configured (non-mock) provider can
 * refine them. Writes them into the AgentRepository.
 */
export class AgentGenerator {
  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly skillsRepo: SkillRepository,
    private readonly modelRepo: ModelRepository,
  ) {}

  generate(project: Project, opts: GenerateAgentOptions = {}): Agent[] {
    const defaultModelId = opts.defaultModelId ?? project.defaultModelId;
    const created: Agent[] = [];
    const roster = opts.agentTypes?.length ? AGENT_TYPES.filter((t) => opts.agentTypes!.includes(t)) : AGENT_TYPES;
    // Agents outside the selected roster are switched off (kept for history).
    for (const a of this.agentRepo.byProject(project.id)) {
      if (!roster.includes(a.type) && a.enabled) {
        this.agentRepo.upsert({ ...a, enabled: false, updatedAt: new Date().toISOString() }, { projectId: project.id });
      }
    }
    for (const type of roster) {
      const scaffold = AGENT_SCAFFOLD[type];
      const existing = this.agentRepo.byType(project.id, type);
      // Agents are per-project, so ids must be project-unique (a fixed
      // `agent-<type>` id would collide across projects and wipe other rosters).
      const agent: Agent = {
        id: existing?.id ?? `agent-${type}-${project.id}-${randomUUID().slice(0, 6)}`,
        projectId: project.id,
        type,
        name: scaffold.role,
        slug: type,
        role: scaffold.role,
        description: scaffold.mission,
        configPath: `.ai-engineering/agents/${type}.yaml`,
        systemPrompt: this.buildSystemPrompt(type, scaffold, project),
        projectPrompt: project.description,
        skills: scaffold.skills,
        tools: scaffold.tools,
        permissions: scaffold.permissions,
        models: this.buildModels(defaultModelId, type),
        maxIterations: type === "backend-developer" ? 10 : 5,
        timeoutMs: 120000,
        tokenBudget: 20000,
        memorySources: ["project", type],
        enabled: true,
        version: existing ? existing.version + 1 : 1,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const saved = this.agentRepo.upsert(agent, { projectId: project.id });
      created.push(saved.data);
    }
    logger.info(`AgentGenerator created ${created.length} agents for project ${project.id}`);
    return created;
  }

  private buildSystemPrompt(type: AgentType, s: { role: string; mission: string }, project: Project): string {
    return [
      `You are the ${s.role} of an AI engineering organization working on "${project.name}".`,
      ``,
      `Your mission: ${s.mission}`,
      ``,
      `Project: ${project.name} (${project.slug})`,
      `Repository: ${project.configRepo} @ ${project.branch}`,
      ...this.profileLines(project),
      ``,
      `Rules you must follow:`,
      `- Before changing code, inspect the repository and existing architecture.`,
      `- Do not make blind changes. Every change needs a plan, an impact check, and a PR.`,
      `- Never commit secrets; reference them via secretRef only.`,
      `- Dangerous operations (merge, deploy, migration, delete) require human approval.`,
      `- Keep the definition of done: build passes, tests pass, docs updated, committed.`,
    ].join("\n");
  }

  /** Human-readable multi-select profile for the system prompt. */
  private profileLines(project: Project): string[] {
    const c = project.capabilities;
    if (!c) {
      return [`Tech: ${project.framework ?? "unknown"} / ${project.primaryLanguage ?? "unknown"} / ${project.database ?? "unknown"}`];
    }
    const line = (label: string, values: string[]): string | undefined => (values.length ? `${label}: ${values.join(", ")}` : undefined);
    const repos = (project.repositories ?? []).map((r) => `${r.repo}@${r.branch} (${r.role})`);
    return [
      line("Platforms", c.platforms),
      line("Languages", c.languages),
      line("Frameworks", c.frameworks),
      line("Databases", c.databases),
      line("Deployment", c.deploymentTargets),
      line("Key features", c.features),
      line("Integrations", c.integrations),
      repos.length > 1 ? `Repositories: ${repos.join("; ")}` : undefined,
    ].filter((x): x is string => !!x);
  }

  private buildModels(defaultModelId: string | undefined, type: AgentType): Agent["models"] {
    const all = this.modelRepo.listActive();
    const primary = defaultModelId && all.some((m) => m.id === defaultModelId) ? defaultModelId : all[0]?.id ?? "";
    const reasoning = all.find((m) => m.capabilities.reasoning)?.id ?? primary;
    const coding = all.find((m) => m.capabilities.code)?.id ?? primary;
    const fast = all[0]?.id ?? primary;
    const vision = all.find((m) => m.capabilities.vision)?.id ?? primary;
    return {
      primary,
      fallbacks: all.map((m) => m.id).filter((id) => id !== primary).slice(0, 2),
      specialized: {
        research: reasoning,
        coding,
        vision,
        "fast": fast,
        "final-review": reasoning,
        reasoning,
      },
    };
  }
}
