import type { Agent, MemoryEntry, Project, Task } from "../domain/entities.js";
import type { AgentRepository } from "../agents/agent-repo.js";
import type { MemoryRepository, ProjectRepository, TaskRepository } from "../domain/repos.js";
import type { IGitHubService, GithubFile, GithubRepoRef } from "./types.js";
import { projectBrief } from "../domain/project-brief.js";
import { logger } from "../logger.js";

/**
 * Project files — the project's own folder inside its GitHub repository.
 *
 *   CodeVia/project.md      manifest: definition selections, roster, skills, status
 *   CodeVia/agents/<type>.md  one file per unit (role, toolbox, permissions, prompt)
 *   CodeVia/skills.md         attached skills
 *   CodeVia/tasks/<id>.md     every task with status, duty and research brief
 *   CodeVia/memory.md         managed memory file (decisions, bugs, lessons…)
 *
 * Every file carries complete machine state in YAML-ish front-matter (JSON
 * values) plus a human-readable body, so the platform can rehydrate its
 * database from the repo ("Pull from GitHub") instead of re-fetching or
 * re-generating everything. All sync methods are best-effort: they log and
 * return false on failure and never break the caller flow.
 */

export const CODEVIA_DIR = "CodeVia";
export const PROJECT_FILE = `${CODEVIA_DIR}/project.md`;
export const AGENTS_DIR = `${CODEVIA_DIR}/agents`;
export const SKILLS_FILE = `${CODEVIA_DIR}/skills.md`;
export const TASKS_DIR = `${CODEVIA_DIR}/tasks`;
export const MEMORY_FILE = `${CODEVIA_DIR}/memory.md`;
export const CONTEXT_FILE = `${CODEVIA_DIR}/context.md`;

const KNOWN_MEMORY_TYPES = ["architecture", "business", "technical", "decision", "bug", "knowledge", "lesson", "conversation"];

/* ---------------- front-matter (JSON values → lossless round-trip) ---------------- */

export function matter(data: Record<string, unknown>, body: string): string {
  const head = Object.entries(data)
    .map(([k, v]) => `${k}: ${JSON.stringify(v ?? null)}`)
    .join("\n");
  return `---\n${head}\n---\n\n${body}`;
}

export function parseMatter(content: string): { data: Record<string, unknown>; body: string } {
  const m = String(content ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: String(content ?? "") };
  const data: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (!key) continue;
    try {
      data[key] = raw === "" ? "" : JSON.parse(raw);
    } catch {
      data[key] = raw;
    }
  }
  return { data, body: m[2] };
}

/** Split a generated body on `## ` sections → { heading: content }. */
export function parseSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = String(body ?? "").split(/^## /m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    if (nl <= 0) continue;
    out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return out;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const oneLine = (v: string): string => v.replace(/\s+/g, " ").trim();

/* ---------------- renderers ---------------- */

export function renderProjectFile(project: Project, agents: Agent[], tasks: Task[], memory: MemoryEntry[]): string {
  const running = tasks.filter((t) => t.status === "running" || t.status === "queued").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const agentRows = [...agents]
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((a) => `| \`${a.type}\` | ${a.name} | ${a.enabled ? "enabled" : "disabled"} | v${a.version} |`)
    .join("\n");
  const skillLines = (project.settings.skills ?? []).map((s) => `- \`${s}\``).join("\n") || "_(none)_";
  const taskRows = [...tasks]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 30)
    .map((t) => `| \`${t.id}\` | ${oneLine(t.title).slice(0, 60)} | ${t.agentType ?? (t.parentTaskId ? "sub" : "auto")} | ${t.status} | ${t.updatedAt} |`)
    .join("\n");
  const memRows = [...memory]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 30)
    .map((e) => `| ${e.type} | \`${e.key}\` | v${e.version} | ${e.updatedAt} |`)
    .join("\n");
  return matter(
    {
      id: project.id,
      slug: project.slug,
      name: project.name,
      configRepo: project.configRepo,
      branch: project.branch,
      updatedAt: new Date().toISOString(),
      capabilities: project.capabilities,
      counts: {
        agents: agents.length,
        agentsEnabled: agents.filter((a) => a.enabled).length,
        tasks: tasks.length,
        tasksRunning: running,
        tasksFailed: failed,
        memory: memory.length,
      },
    },
    [
      `# ${project.name} — CodeVia project state`,
      ``,
      `> Manifest of the project folder. Synced by CodeVia — definition selections, units, skills, tasks and memory.`,
      ``,
      `## Definition`,
      projectBrief(project),
      ``,
      `## Units (${agents.length})`,
      `| Type | Name | Status | Version |`,
      `| ---- | ---- | ------ | ------- |`,
      agentRows || `_(no agents)_`,
      ``,
      `## Skills (${(project.settings.skills ?? []).length})`,
      skillLines,
      ``,
      `## Tasks (${tasks.length}${tasks.length > 30 ? ", recent 30" : ""})`,
      tasks.length ? `| ID | Title | Unit | Status | Updated |\n| -- | ----- | ---- | ------ | ------- |\n${taskRows}` : `_(no tasks)_`,
      ``,
      `## Memory (${memory.length}${memory.length > 30 ? ", recent 30" : ""})`,
      memory.length ? `| Type | Key | Version | Updated |\n| ---- | --- | ------- | ------- |\n${memRows}` : `_(no memory entries)_`,
      ``,
    ].join("\n"),
  );
}

export function renderAgentFile(agent: Agent): string {
  return matter(
    {
      id: agent.id,
      type: agent.type,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      enabled: agent.enabled,
      version: agent.version,
      tools: agent.tools,
      permissions: agent.permissions,
      skills: agent.skills,
      models: agent.models,
      maxIterations: agent.maxIterations,
      timeoutMs: agent.timeoutMs,
      tokenBudget: agent.tokenBudget,
      memorySources: agent.memorySources,
      systemPrompt: agent.systemPrompt,
      updatedAt: new Date().toISOString(),
    },
    [
      `# ${agent.name} (\`${agent.type}\`)`,
      ``,
      `> Unit definition synced by CodeVia. Status: **${agent.enabled ? "enabled" : "disabled"}** · v${agent.version}`,
      ``,
      `## Role`,
      agent.role || "_(none)_",
      ``,
      `## Mission`,
      agent.description || "_(none)_",
      ``,
      `## Toolbox`,
      agent.tools.length ? agent.tools.map((t) => `- \`${t}\``).join("\n") : "_(no tools)_",
      ``,
      `## Permissions`,
      agent.permissions.length ? agent.permissions.map((p) => `- \`${p}\``).join("\n") : "_(no permissions)_",
      ``,
      `## Skills`,
      agent.skills.length ? agent.skills.map((s) => `- \`${s}\``).join("\n") : "_(no skills)_",
      ``,
      `## Models`,
      `Primary: \`${agent.models?.primary || "—"}\` · Fallbacks: ${(agent.models?.fallbacks ?? []).map((f) => `\`${f}\``).join(", ") || "—"}`,
      ``,
      `## Limits`,
      `maxIterations=${agent.maxIterations} · timeoutMs=${agent.timeoutMs} · tokenBudget=${agent.tokenBudget}`,
      ``,
    ].join("\n"),
  );
}

export function renderSkillsFile(project: Project, catalog: Array<{ slug: string; description?: string }>): string {
  const skills = project.settings.skills ?? [];
  const bySlug = new Map(catalog.map((c) => [c.slug, c.description ?? ""]));
  return matter(
    { updatedAt: new Date().toISOString(), count: skills.length, skills },
    [
      `# Project skills (${skills.length})`,
      ``,
      `> Skills attached to this project. Synced by CodeVia.`,
      ``,
      skills.length
        ? skills.map((s) => `## ${s}\n${bySlug.get(s) || "_(no description)_"}\n`).join("\n")
        : "_(no skills attached)_",
    ].join("\n"),
  );
}

export function renderTaskFile(task: Task): string {
  const brief = typeof task.input?.researchBrief === "string" ? task.input.researchBrief : "";
  return matter(
    {
      id: task.id,
      title: task.title,
      status: task.status,
      agentType: task.agentType ?? null,
      parentTaskId: task.parentTaskId ?? null,
      priority: task.priority ?? null,
      error: task.error ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    [
      `# ${oneLine(task.title) || task.id}`,
      ``,
      `> Status: **${task.status}** · Unit: \`${task.agentType ?? (task.parentTaskId ? "sub" : "auto")}\`${task.parentTaskId ? ` · Parent: \`${task.parentTaskId}\`` : ""} · Priority: ${task.priority ?? "—"}`,
      ``,
      `## Request`,
      task.description || "_(no description)_",
      ``,
      ...(brief ? [`## Research brief`, brief, ``] : []),
      ...(task.error ? [`## Error`, task.error, ``] : []),
    ].join("\n"),
  );
}

export function renderMemoryFile(entries: MemoryEntry[]): string {
  const byType = new Map<string, MemoryEntry[]>();
  for (const e of [...entries].sort((a, b) => String(a.key).localeCompare(String(b.key)))) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type)!.push(e);
  }
  const sections: string[] = [];
  for (const [type, list] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    sections.push(`## ${type}`, ``);
    for (const e of list) {
      sections.push(
        `### ${e.key} (v${e.version})`,
        `_tags: ${(e.tags ?? []).join(", ") || "—"} · updated: ${e.updatedAt} · source: ${e.source || "—"}_`,
        ``,
        e.content || "_(empty)_",
        ``,
      );
    }
  }
  return matter(
    { updatedAt: new Date().toISOString(), count: entries.length },
    [`# Project memory (${entries.length})`, ``, `> Managed memory file. Agents append via save_memory; edits here are pulled back with "Pull from GitHub".`, ``, ...sections].join("\n"),
  );
}

/* ---------------- parsers (restore) ---------------- */

export interface ParsedAgent {
  id: string; type: string; name: string; role: string; description: string; enabled: boolean;
  version: number; tools: string[]; permissions: string[]; skills: string[];
  models: Agent["models"]; maxIterations: number; timeoutMs: number; tokenBudget: number;
  memorySources: string[]; systemPrompt: string;
}

export function parseAgentFile(content: string): ParsedAgent | undefined {
  const { data } = parseMatter(content);
  if (!str(data.type) || !str(data.id)) return undefined;
  return {
    id: str(data.id), type: str(data.type), name: str(data.name, str(data.type)),
    role: str(data.role), description: str(data.description),
    enabled: data.enabled !== false, version: num(data.version, 1),
    tools: arr(data.tools), permissions: arr(data.permissions), skills: arr(data.skills),
    models: (data.models as Agent["models"]) ?? { primary: "", fallbacks: [], specialized: {} },
    maxIterations: num(data.maxIterations, 5), timeoutMs: num(data.timeoutMs, 120000),
    tokenBudget: num(data.tokenBudget, 20000), memorySources: arr(data.memorySources),
    systemPrompt: str(data.systemPrompt),
  };
}

export interface ParsedTask {
  id: string; title: string; status: Task["status"]; agentType?: string; parentTaskId?: string;
  priority?: Task["priority"]; error?: string; description: string; researchBrief?: string;
  createdAt: string; updatedAt: string;
}

export function parseTaskFile(content: string): ParsedTask | undefined {
  const { data, body } = parseMatter(content);
  if (!str(data.id)) return undefined;
  const sections = parseSections(body);
  return {
    id: str(data.id), title: str(data.title, str(data.id)),
    status: (str(data.status) || "created") as Task["status"],
    agentType: str(data.agentType) || undefined,
    parentTaskId: str(data.parentTaskId) || undefined,
    priority: (str(data.priority) || undefined) as Task["priority"] | undefined,
    error: str(data.error) || undefined,
    description: sections["Request"] && sections["Request"] !== "_(no description)_" ? sections["Request"] : "",
    researchBrief: sections["Research brief"] || undefined,
    createdAt: str(data.createdAt) || new Date().toISOString(),
    updatedAt: str(data.updatedAt) || new Date().toISOString(),
  };
}

export interface ParsedMemoryEntry {
  type: string; key: string; version: number; tags: string[]; source: string; updatedAt: string; content: string;
}

export function parseMemoryFile(content: string): ParsedMemoryEntry[] {
  const { body } = parseMatter(content);
  const out: ParsedMemoryEntry[] = [];
  const typeBlocks = String(body ?? "").split(/^## /m).slice(1);
  for (const block of typeBlocks) {
    const nl = block.indexOf("\n");
    const type = block.slice(0, nl).trim().toLowerCase();
    if (!KNOWN_MEMORY_TYPES.includes(type)) continue;
    const rest = block.slice(nl + 1);
    const entries = rest.split(/^### /m).slice(1);
    for (const e of entries) {
      const enl = e.indexOf("\n");
      const header = e.slice(0, enl).trim();
      const hm = header.match(/^(.*?)\s*\(v(\d+)\)\s*$/);
      if (!hm) continue;
      const lines = e.slice(enl + 1).split("\n");
      let tags: string[] = [];
      let source = "";
      let updatedAt = "";
      let start = 0;
      const meta = (lines[0] ?? "").match(/^_tags:\s*(.*?)\s*·\s*updated:\s*(.*?)\s*·\s*source:\s*(.*?)_$/);
      if (meta) {
        tags = meta[1] === "—" ? [] : meta[1].split(",").map((t) => t.trim()).filter(Boolean);
        updatedAt = meta[2];
        source = meta[3] === "—" ? "" : meta[3];
        start = 1;
      }
      const content = lines.slice(start).join("\n").trim();
      out.push({
        type, key: hm[1], version: Number(hm[2]) || 1, tags, source, updatedAt,
        content: content === "_(empty)_" ? "" : content,
      });
    }
  }
  return out;
}

/* ---------------- service ---------------- */

export interface ProjectFilesDeps {
  github: IGitHubService;
}

export interface PullSummary {
  agents: number;
  tasks: number;
  memory: number;
  skills: string[];
  files: string[];
}

export class ProjectFilesService {
  constructor(private readonly deps: ProjectFilesDeps) {}

  private ref(project: Project): GithubRepoRef {
    const [owner, ...rest] = String(project.configRepo ?? "").split("/");
    return { owner, name: rest.join("/") };
  }

  private async commitSafe(project: Project, message: string, files: GithubFile[]): Promise<boolean> {
    try {
      if (!project.configRepo || !project.configRepo.includes("/")) return false;
      await this.deps.github.commit(this.ref(project), project.branch || "main", message, files);
      return true;
    } catch (err) {
      logger.warn("project files sync failed", { projectId: project.id, message, err: String(err) });
      return false;
    }
  }

  private async readSafe(project: Project, path: string): Promise<string | undefined> {
    try {
      const file = await this.deps.github.getFile(this.ref(project), path, project.branch);
      return file?.content;
    } catch {
      return undefined;
    }
  }

  /** Full state in ONE commit: manifest, agents, skills, tasks, memory. */
  async syncAll(project: Project, input: { agents: Agent[]; tasks: Task[]; memory: MemoryEntry[]; skillCatalog?: Array<{ slug: string; description?: string }> }): Promise<boolean> {
    const files: GithubFile[] = [
      { path: PROJECT_FILE, content: renderProjectFile(project, input.agents, input.tasks, input.memory) },
      ...input.agents.map((a) => ({ path: `${AGENTS_DIR}/${a.type}.md`, content: renderAgentFile(a) })),
      { path: SKILLS_FILE, content: renderSkillsFile(project, input.skillCatalog ?? []) },
      ...input.tasks.map((t) => ({ path: `${TASKS_DIR}/${t.id}.md`, content: renderTaskFile(t) })),
      { path: MEMORY_FILE, content: renderMemoryFile(input.memory) },
    ];
    return this.commitSafe(project, `[CodeVia] sync project state (${files.length} files)`, files);
  }

  async syncTask(project: Project, task: Task): Promise<boolean> {
    return this.commitSafe(project, `[CodeVia] task ${task.id} → ${task.status}`, [{ path: `${TASKS_DIR}/${task.id}.md`, content: renderTaskFile(task) }]);
  }

  async syncAgents(project: Project, agents: Agent[]): Promise<boolean> {
    if (agents.length === 0) return true;
    return this.commitSafe(
      project,
      `[CodeVia] sync ${agents.length} unit(s)`,
      agents.map((a) => ({ path: `${AGENTS_DIR}/${a.type}.md`, content: renderAgentFile(a) })),
    );
  }

  async syncSkills(project: Project, catalog: Array<{ slug: string; description?: string }> = []): Promise<boolean> {
    return this.commitSafe(project, "[CodeVia] sync skills", [{ path: SKILLS_FILE, content: renderSkillsFile(project, catalog) }]);
  }

  async syncMemory(project: Project, memory: MemoryEntry[]): Promise<boolean> {
    return this.commitSafe(project, `[CodeVia] sync memory (${memory.length} entries)`, [{ path: MEMORY_FILE, content: renderMemoryFile(memory) }]);
  }

  /** Persist the agent context brief (rendered by `renderContextMarkdown`). */
  async syncContext(project: Project, markdown: string): Promise<boolean> {
    return this.commitSafe(project, "[CodeVia] sync context", [{ path: CONTEXT_FILE, content: markdown }]);
  }

  /** Read the persisted context brief back (undefined when absent). */
  async readContext(project: Project): Promise<string | undefined> {
    return this.readSafe(project, CONTEXT_FILE);
  }

  /** Read the folder back. Missing files → empty collections (never throws). */
  async pull(project: Project): Promise<{ manifest?: Record<string, unknown>; agents: ParsedAgent[]; tasks: ParsedTask[]; memory: ParsedMemoryEntry[]; skills: string[]; files: string[] }> {
    const out = { manifest: undefined as Record<string, unknown> | undefined, agents: [] as ParsedAgent[], tasks: [] as ParsedTask[], memory: [] as ParsedMemoryEntry[], skills: [] as string[], files: [] as string[] };
    try {
      const entries = await this.deps.github.listFiles(this.ref(project), project.branch, CODEVIA_DIR).catch(() => [] as Array<{ path: string }>);
      // listFiles(path) support varies — fall back to a full tree scan.
      const tree = entries.length ? entries : await this.deps.github.listFiles(this.ref(project), project.branch).catch(() => [] as Array<{ path: string }>);
      const hits = tree.map((e) => e.path).filter((p) => p === PROJECT_FILE || p === SKILLS_FILE || p === MEMORY_FILE || p.startsWith(`${AGENTS_DIR}/`) || p.startsWith(`${TASKS_DIR}/`));
      out.files = hits;
      for (const path of hits) {
        const content = await this.readSafe(project, path);
        if (content == null) continue;
        if (path === PROJECT_FILE) out.manifest = parseMatter(content).data;
        else if (path === SKILLS_FILE) {
          const skills = parseMatter(content).data.skills;
          if (Array.isArray(skills)) out.skills = skills.map(String);
        } else if (path === MEMORY_FILE) out.memory = parseMemoryFile(content);
        else if (path.startsWith(`${AGENTS_DIR}/`)) {
          const a = parseAgentFile(content);
          if (a) out.agents.push(a);
        } else if (path.startsWith(`${TASKS_DIR}/`)) {
          const t = parseTaskFile(content);
          if (t) out.tasks.push(t);
        }
      }
    } catch (err) {
      logger.warn("project files pull failed", { projectId: project.id, err: String(err) });
    }
    return out;
  }

  /**
   * Restore the database from the repo folder (agents, tasks, memory, skills,
   * definition). Last-write-wins by file content; returns per-collection counts.
   *
   * Pass `{ includeTasks: false }` for the pre-run sync: live tasks are owned
   * by the run itself, so only configuration-ish state (agents, memory,
   * skills, definition) is refreshed from git before work starts.
   */
  async restore(
    project: Project,
    repos: { projectRepo: ProjectRepository; agentRepo: AgentRepository; taskRepo: TaskRepository; memoryRepo: MemoryRepository },
    opts: { includeTasks?: boolean } = {},
  ): Promise<PullSummary> {
    const pulled = await this.pull(project);
    const now = new Date().toISOString();

    for (const a of pulled.agents) {
      const existing = repos.agentRepo.byType(project.id, a.type as Agent["type"]);
      if (existing) {
        repos.agentRepo.upsert(
          {
            ...existing, name: a.name, role: a.role, description: a.description, enabled: a.enabled,
            version: Math.max(existing.version, a.version), tools: a.tools, permissions: a.permissions as never,
            skills: a.skills, models: a.models, maxIterations: a.maxIterations, timeoutMs: a.timeoutMs,
            tokenBudget: a.tokenBudget, memorySources: a.memorySources, systemPrompt: a.systemPrompt || existing.systemPrompt,
            projectPrompt: existing.projectPrompt, updatedAt: now,
          },
          { projectId: project.id },
        );
      } else {
        repos.agentRepo.upsert(
          {
            id: a.id, projectId: project.id, type: a.type as Agent["type"], name: a.name, slug: a.type,
            role: a.role, description: a.description, configPath: `${AGENTS_DIR}/${a.type}.md`,
            systemPrompt: a.systemPrompt, projectPrompt: project.description, skills: a.skills,
            tools: a.tools, permissions: a.permissions as never, models: a.models,
            maxIterations: a.maxIterations, timeoutMs: a.timeoutMs, tokenBudget: a.tokenBudget,
            memorySources: a.memorySources, enabled: a.enabled, version: a.version,
            createdAt: now, updatedAt: now,
          },
          { projectId: project.id },
        );
      }
    }

    for (const t of opts.includeTasks === false ? [] : pulled.tasks) {
      const existing = repos.taskRepo.findById(t.id)?.data;
      const input = { ...(existing?.input ?? {}), ...(t.researchBrief ? { researchBrief: t.researchBrief } : {}) };
      repos.taskRepo.upsert(
        {
          id: t.id, projectId: project.id, parentTaskId: t.parentTaskId, title: t.title,
          description: t.description, priority: t.priority ?? existing?.priority ?? "medium",
          status: t.status, agentType: (t.agentType as Task["agentType"]) ?? existing?.agentType,
          correlationId: existing?.correlationId ?? `restored-${Date.now()}`,
          input, error: t.error,
          createdAt: existing?.createdAt ?? t.createdAt, updatedAt: now,
        },
        { projectId: project.id, parentId: t.parentTaskId },
      );
    }

    for (const e of pulled.memory) {
      const existing = repos.memoryRepo.findMany({ projectId: project.id, key: e.key })[0]?.data;
      if (existing) {
        repos.memoryRepo.upsert(
          { ...existing, type: e.type as MemoryEntry["type"], content: e.content, tags: e.tags, source: e.source || existing.source, version: Math.max(existing.version, e.version), updatedAt: now },
          { projectId: project.id, key: e.key },
        );
      } else {
        repos.memoryRepo.upsert(
          {
            id: `mem-restored-${e.key}`.slice(0, 60), projectId: project.id, scope: "project",
            type: e.type as MemoryEntry["type"], key: e.key, content: e.content, tags: e.tags,
            refs: [], source: e.source || "github", version: e.version, createdAt: now, updatedAt: now,
          },
          { projectId: project.id, key: e.key },
        );
      }
    }

    const stored = repos.projectRepo.findById(project.id)?.data;
    if (stored) {
      const manifestCaps = (pulled.manifest?.capabilities as Project["capabilities"] | undefined) ?? (pulled.manifest?.capabilities as never);
      repos.projectRepo.upsert(
        {
          ...stored,
          ...(manifestCaps && typeof manifestCaps === "object" ? { capabilities: manifestCaps } : {}),
          settings: { ...stored.settings, skills: pulled.skills.length ? pulled.skills : stored.settings.skills },
          updatedAt: now,
        },
        { key: stored.slug },
      );
    }

    return { agents: pulled.agents.length, tasks: opts.includeTasks === false ? 0 : pulled.tasks.length, memory: pulled.memory.length, skills: pulled.skills, files: pulled.files };
  }
}
