import type { Agent, Project, Task } from "../domain/entities.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { IGitHubService, GithubRepoRef } from "../github/types.js";
import type { IMemoryStore } from "../memory/store.js";
import { logger } from "../logger.js";
import { resolveGitHubService } from "../github/registry.js";
import { memoryResolver } from "../memory/index.js";
import type { MemoryType } from "../domain/entities.js";

export interface ContextSource {
  label: string;
  content: string;
}

export interface BuildContextOptions {
  project: Project;
  agent: Agent;
  task?: Task;
  skills?: SkillRegistry;
  github?: IGitHubService;
  memory?: IMemoryStore;
  /** Optional explicit list of file paths the task should focus on. */
  relevantFiles?: string[];
}

export interface BuildContextResult {
  context: string;
  sources: ContextSource[];
  tokens: number;
}

/**
 * Context Engine.
 *
 * Decides what context is needed for an agent rather than dumping the entire
 * repository. Composes: agent system prompt + role, skills, project rules, focused
 * source files, recent commits, and relevant memory (decisions/bugs/architecture).
 */
export class ContextEngine {
  async build(opts: BuildContextOptions): Promise<BuildContextResult> {
    const { project, agent, task } = opts;
    const github = opts.github ?? resolveGitHubService();
    const memory = opts.memory ?? memoryResolver.resolve({ repo: this.toRepoRef(project), force: "local" });
    const sources: ContextSource[] = [];

    // 1. Agent system + role
    sources.push({ label: "agent-system", content: this.buildAgentSystem(agent) });

    // 2. Skills
    const skills = opts.skills;
    if (skills) {
      const compiled = skills.compile(agent.skills);
      if (compiled) sources.push({ label: "skills", content: compiled });
    }

    // 3. Project rules
    const rules = project.settings.rules.join("\n\n");
    if (rules) sources.push({ label: "rules", content: rules });

    // 4. Project technical profile
    const profile = await this.detectProfile(project, github);
    sources.push({ label: "project-profile", content: profile });

    // 5. Relevant files (limit scope)
    const fileList = opts.relevantFiles ?? this.inferRelevantFiles(task, agent.type);
    if (fileList.length) {
      const fileContent = await this.readRelevantFiles(project, fileList, github);
      if (fileContent) sources.push({ label: "relevant-files", content: fileContent });
    }

    // 6. Recent commits (limited)
    const commits = await this.recentCommits(project, github);
    if (commits) sources.push({ label: "recent-commits", content: commits });

    // 7. Memory context
    const memoryContext = await this.memoryContext(task, memory);
    if (memoryContext) sources.push({ label: "memory", content: memoryContext });

    const context = sources
      .map((s) => `## ${s.label}\n${s.content}`)
      .join("\n\n---\n\n");

    const tokens = Math.ceil(context.length / 4);
    logger.debug("context built", { sources: sources.map((s) => s.label), tokens });
    return { context, sources, tokens };
  }

  private buildAgentSystem(agent: Agent): string {
    return [
      agent.systemPrompt,
      agent.role,
      `You are the ${agent.name} agent for project context.`,
      `Max iterations: ${agent.maxIterations}. Timeout: ${agent.timeoutMs}ms.`,
    ].filter(Boolean).join("\n\n");
  }

  private toRepoRef(project: Project): GithubRepoRef | undefined {
    if (!project.configRepo) return undefined;
    const [owner, ...rest] = project.configRepo.split("/");
    if (!owner || rest.length === 0) return undefined;
    return { owner, name: rest.join("/") };
  }

  private inferRelevantFiles(task: Task | undefined, agentType: string): string[] {
    if (task?.input?.files && Array.isArray(task.input.files)) {
      return (task.input.files as string[]).slice(0, 10);
    }
    // Heuristic based on agent type.
    const keywords: Record<string, string[]> = {
      "backend-developer": ["src", "Server", "Controller", "Service", "Repository"],
      "frontend-developer": ["src", "Pages", "Components", "ui"],
      database: ["Migrations", "Models", "DbContext", "schema"],
      security: ["auth", "security", "middleware"],
      qa: ["test", "spec"],
      uiux: ["ui", "styles", "theme", "css"],
    };
    const kws = keywords[agentType] ?? ["src"];
    void kws;
    return [];
  }

  private async readRelevantFiles(
    project: Project,
    fileList: string[],
    github: IGitHubService,
  ): Promise<string> {
    const repo = this.toRepoRef(project);
    if (!repo) return "";
    const parts: string[] = [];
    for (const path of fileList.slice(0, 8)) {
      try {
        const file = await github.getFile(repo, path, project.branch);
        if (file) {
          parts.push(`### ${path}\n${file.content.slice(0, 4000)}`);
        }
      } catch {
        // A missing/unreachable file must not break context building.
      }
    }
    return parts.join("\n\n");
  }

  private async recentCommits(project: Project, github: IGitHubService): Promise<string> {
    const repo = this.toRepoRef(project);
    if (!repo) return "";
    try {
      const commits = await github.listCommits(repo, project.branch);
      if (!commits.length) return "";
      return commits
        .slice(0, 8)
        .map((c) => `- ${c.sha.slice(0, 7)} ${c.message.split("\n")[0]} (${c.date})`)
        .join("\n");
    } catch {
      return "";
    }
  }

  private async memoryContext(task: Task | undefined, memory: IMemoryStore): Promise<string> {
    const terms = this.extractTerms(task);
    const types: MemoryType[] = ["decision", "bug", "architecture", "knowledge"];
    const results: string[] = [];
    for (const t of terms) {
      const entries = await memory.search(t, { types });
      for (const e of entries.slice(0, 2)) {
        results.push(`- [${e.type}] ${e.key}: ${e.content.slice(0, 500)}`);
      }
    }
    return results.slice(0, 8).join("\n");
  }

  private extractTerms(task: Task | undefined): string[] {
    if (!task) return [];
    const text = `${task.title} ${task.description}`.toLowerCase();
    const common = ["login", "auth", "api", "database", "test", "bug", "ui", "build", "deploy", "error", "performance", "security"];
    return common.filter((w) => text.includes(w));
  }

  private async detectProfile(project: Project, github: IGitHubService): Promise<string> {
    const repo = this.toRepoRef(project);
    if (!repo) {
      return this.profileFromSettings(project);
    }
    const candidateFiles = [
      "package.json",
      "Directory.Build.props",
      "README.md",
      "Dockerfile",
      "docker-compose.yml",
      ".github/workflows/ci.yml",
      ".editorconfig",
    ];
    const found: string[] = [];
    for (const p of candidateFiles) {
      try {
        const f = await github.getFile(repo, p, project.branch);
        if (f) found.push(`- ${p}: available`);
      } catch {
        // Ignore missing/unreachable files.
      }
    }
    const base = this.profileFromSettings(project);
    return found.length ? `${base}\nRepo signals:\n${found.join("\n")}` : base;
  }

  private profileFromSettings(project: Project): string {
    return [
      `Language: ${project.primaryLanguage ?? "unknown"}`,
      `Framework: ${project.framework ?? "unknown"}`,
      `Database: ${project.database ?? "unknown"}`,
      `Deployment: ${project.deploymentTarget ?? "unknown"}`,
      `Branch: ${project.branch}`,
      `Config repo: ${project.configRepo}`,
    ].join("\n");
  }
}

export const contextEngine = new ContextEngine();
