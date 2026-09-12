import type { Agent, MemoryEntry, Project, Task } from "../domain/entities.js";
import { projectBrief } from "../domain/project-brief.js";
import { parseMemoryState, projectDefinition, repositorySafe, STATE_VERSION } from "./state-codec.js";

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
export const RUNTIME_CONTEXT_FILE = `${CODEVIA_DIR}/runtime/context.md`;

const KNOWN_MEMORY_TYPES = [
  "architecture",
  "business",
  "technical",
  "decision",
  "bug",
  "knowledge",
  "lesson",
  "conversation",
];

/* ---------------- front-matter (JSON values → lossless round-trip) ---------------- */

export { matter, parseMatter } from "./markdown.js";
import { matter, parseMatter } from "./markdown.js";

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
    .map(
      (t) =>
        `| \`${t.id}\` | ${oneLine(t.title).slice(0, 60)} | ${t.agentType ?? (t.parentTaskId ? "sub" : "auto")} | ${t.status} | ${t.updatedAt} |`,
    )
    .join("\n");
  const memRows = [...memory]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 30)
    .map((e) => `| ${e.type} | \`${e.key}\` | v${e.version} | ${e.updatedAt} |`)
    .join("\n");
  return matter(
    {
      schemaVersion: STATE_VERSION,
      definition: projectDefinition(project),
      id: project.id,
      slug: project.slug,
      name: project.name,
      description: project.description,
      // Only prompt-facing settings, never credentials or arbitrary metadata.
      promptSettings: {
        environment: project.settings.environment,
        rules: project.settings.rules,
        generatedSkills: project.settings.generatedSkills,
      },
      configRepo: project.configRepo,
      branch: project.branch,
      updatedAt: project.updatedAt,
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
      `> Canonical project definition. Structured front matter is editable; display sections below are summaries.`,
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
      tasks.length
        ? `| ID | Title | Unit | Status | Updated |\n| -- | ----- | ---- | ------ | ------- |\n${taskRows}`
        : `_(no tasks)_`,
      ``,
      `## Memory (${memory.length}${memory.length > 30 ? ", recent 30" : ""})`,
      memory.length
        ? `| Type | Key | Version | Updated |\n| ---- | --- | ------- | ------- |\n${memRows}`
        : `_(no memory entries)_`,
      ``,
    ].join("\n"),
  );
}

export function renderAgentFile(agent: Agent): string {
  return matter(
    {
      schemaVersion: STATE_VERSION,
      id: agent.id,
      projectId: agent.projectId,
      slug: agent.slug,
      configPath: agent.configPath,
      createdAt: agent.createdAt,
      type: agent.type,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      enabled: agent.enabled,
      version: agent.version,
      tools: agent.tools,
      permissions: agent.permissions,
      skills: agent.skills,
      generatedSkills: agent.generatedSkills,
      models: agent.models,
      maxIterations: agent.maxIterations,
      timeoutMs: agent.timeoutMs,
      tokenBudget: agent.tokenBudget,
      memorySources: agent.memorySources,
      systemPrompt: agent.systemPrompt,
      projectPrompt: agent.projectPrompt,
      updatedAt: agent.updatedAt,
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
    { schemaVersion: STATE_VERSION, count: skills.length, skills },
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
      schemaVersion: STATE_VERSION,
      projectId: task.projectId,
      correlationId: task.correlationId,
      id: task.id,
      title: task.title,
      description: task.description,
      researchBrief: brief || undefined,
      assignedAgentId: task.assignedAgentId,
      workflowId: task.workflowId,
      status: task.status,
      agentType: task.agentType ?? null,
      parentTaskId: task.parentTaskId ?? null,
      priority: task.priority ?? null,
      error: task.error ?? null,
      input: repositorySafe(task.input),
      result: repositorySafe(task.result),
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
      ...(Array.isArray(task.input?.skills)
        ? [`## Assigned skills`, task.input.skills.map((s) => `- \`${String(s)}\``).join("\n") || "_(none)_", ``]
        : []),
      ...(Array.isArray(task.input?.acceptanceCriteria)
        ? [`## Acceptance criteria`, task.input.acceptanceCriteria.map((c) => `- ${String(c)}`).join("\n"), ``]
        : []),
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
    { schemaVersion: STATE_VERSION, count: entries.length, entries: repositorySafe(entries) },
    [
      `# Project memory (${entries.length})`,
      ``,
      `> Canonical memory is the complete entries array in front matter; the body is a readable projection. Agents append losslessly through save_memory.`,
      ``,
      ...sections,
    ].join("\n"),
  );
}

/* ---------------- parsers (restore) ---------------- */

export interface ParsedAgent {
  id: string;
  type: string;
  name: string;
  role: string;
  description: string;
  enabled: boolean;
  projectId?: string;
  slug?: string;
  configPath?: string;
  createdAt?: string;
  updatedAt?: string;
  version: number;
  tools: string[];
  permissions: string[];
  skills: string[];
  generatedSkills?: string[];
  models: Agent["models"];
  maxIterations: number;
  timeoutMs: number;
  tokenBudget: number;
  memorySources: string[];
  systemPrompt: string;
  projectPrompt?: string;
}

export function parseAgentFile(content: string): ParsedAgent | undefined {
  const { data } = parseMatter(content);
  if (!str(data.type) || !str(data.id)) return undefined;
  // (R08) Schema-2 files must fail closed: a malformed numeric limit must never
  // be silently widened to a compatibility default (a broken "BROKEN" budget
  // becoming 20000 tokens defeats the whole point of a budget). Missing fields
  // keep their defaults for backward compatibility; only PRESENT-but-invalid
  // values are rejected. Legacy (pre-schema-2) files stay lenient.
  const strict = data.schemaVersion === 2;
  const requireNumber = (key: string, fallback: number, opts: { min?: number; integer?: boolean } = {}): number => {
    if (!Object.hasOwn(data, key)) return fallback;
    const v = data[key];
    const min = opts.min ?? 0;
    if (typeof v === "number" && Number.isFinite(v) && v >= min && (!opts.integer || Number.isInteger(v))) return v;
    if (!strict) return num(v, fallback);
    throw new Error(
      `CodeVia agent file: ${key} must be ${opts.integer ? `an integer >= ${min}` : `a finite number >= ${min}`}, got ${JSON.stringify(v) ?? String(v)}`,
    );
  };
  return {
    projectId: str(data.projectId) || undefined,
    slug: str(data.slug) || undefined,
    configPath: str(data.configPath) || undefined,
    createdAt: str(data.createdAt) || undefined,
    updatedAt: str(data.updatedAt) || undefined,
    id: str(data.id),
    type: str(data.type),
    name: str(data.name, str(data.type)),
    role: str(data.role),
    description: str(data.description),
    enabled: data.enabled !== false,
    version: requireNumber("version", 1, { integer: true, min: 1 }),
    tools: arr(data.tools),
    permissions: arr(data.permissions),
    skills: arr(data.skills),
    generatedSkills: Array.isArray(data.generatedSkills) ? arr(data.generatedSkills) : undefined,
    models: (data.models as Agent["models"]) ?? { primary: "", fallbacks: [], specialized: {} },
    maxIterations: requireNumber("maxIterations", 5),
    timeoutMs: requireNumber("timeoutMs", 120000),
    tokenBudget: requireNumber("tokenBudget", 20000),
    memorySources: arr(data.memorySources),
    systemPrompt: str(data.systemPrompt),
    projectPrompt: typeof data.projectPrompt === "string" ? data.projectPrompt : undefined,
  };
}

export interface ParsedTask {
  projectId?: string;
  correlationId?: string;
  id: string;
  title: string;
  status: Task["status"];
  agentType?: string;
  parentTaskId?: string;
  priority?: Task["priority"];
  error?: string;
  description: string;
  researchBrief?: string;
  assignedAgentId?: string;
  workflowId?: string;
  createdAt: string;
  updatedAt: string;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export function parseTaskFile(content: string): ParsedTask | undefined {
  const { data, body } = parseMatter(content);
  if (!str(data.id)) return undefined;
  const sections = parseSections(body);
  return {
    projectId: str(data.projectId) || undefined,
    correlationId: str(data.correlationId) || undefined,
    id: str(data.id),
    title: str(data.title, str(data.id)),
    status: (str(data.status) || "created") as Task["status"],
    agentType: str(data.agentType) || undefined,
    parentTaskId: str(data.parentTaskId) || undefined,
    assignedAgentId: str(data.assignedAgentId) || undefined,
    workflowId: str(data.workflowId) || undefined,
    priority: (str(data.priority) || undefined) as Task["priority"] | undefined,
    error: str(data.error) || undefined,
    // Prefer machine state: model briefs and requests can contain their own
    // Markdown headings, which must not be split by the human-body parser.
    description:
      typeof data.description === "string"
        ? data.description
        : sections["Request"] && sections["Request"] !== "_(no description)_"
          ? sections["Request"]
          : "",
    researchBrief:
      typeof data.researchBrief === "string" ? data.researchBrief : sections["Research brief"] || undefined,
    input:
      data.input && typeof data.input === "object" && !Array.isArray(data.input)
        ? (data.input as Record<string, unknown>)
        : undefined,
    result:
      data.result && typeof data.result === "object" && !Array.isArray(data.result)
        ? (data.result as Record<string, unknown>)
        : undefined,
    createdAt: str(data.createdAt) || new Date().toISOString(),
    updatedAt: str(data.updatedAt) || new Date().toISOString(),
  };
}

export interface ParsedMemoryEntry {
  id?: string;
  projectId?: string;
  scope?: MemoryEntry["scope"];
  refs?: string[];
  createdAt?: string;
  type: string;
  key: string;
  version: number;
  tags: string[];
  source: string;
  updatedAt: string;
  content: string;
}

export function parseMemoryFile(content: string): ParsedMemoryEntry[] {
  const state = parseMemoryState(content);
  if (state) return state;
  const { body } = parseMatter(content);
  const out: ParsedMemoryEntry[] = [];
  const typeBlocks = String(body ?? "")
    .split(/^## (?=(?:architecture|business|technical|decision|bug|knowledge|lesson|conversation)\s*$)/m)
    .slice(1);
  for (const block of typeBlocks) {
    const nl = block.indexOf("\n");
    const type = block.slice(0, nl).trim().toLowerCase();
    if (!KNOWN_MEMORY_TYPES.includes(type)) continue;
    const rest = block.slice(nl + 1);
    const entries = rest.split(/^### (?=.+? \(v\d+\)\s*\n_tags:)/m).slice(1);
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
        tags =
          meta[1] === "—"
            ? []
            : meta[1]
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean);
        updatedAt = meta[2];
        source = meta[3] === "—" ? "" : meta[3];
        start = 1;
      }
      const content = lines.slice(start).join("\n").trim();
      out.push({
        type,
        key: hm[1],
        version: Number(hm[2]) || 1,
        tags,
        source,
        updatedAt,
        content: content === "_(empty)_" ? "" : content,
      });
    }
  }
  // A legacy heading layout is inherently ambiguous. Keep the original document
  // as well, including prose outside headings, so no existing knowledge is lost.
  if (content.trim()) {
    const key = out.some((e) => e.type === "knowledge" && e.key === "_legacy/CodeVia-memory.md")
      ? "_legacy/CodeVia-memory.md.raw"
      : "_legacy/CodeVia-memory.md";
    out.push({
      type: "knowledge",
      key,
      content,
      tags: ["legacy-import", "raw-document"],
      refs: [MEMORY_FILE],
      scope: "project",
      source: "legacy:CodeVia/memory.md",
      version: 1,
      updatedAt: "",
    });
  }
  return out;
}
