import type { AgentType, Project } from "../domain/entities.js";
import type { MemoryRepository } from "../domain/repos.js";
import type { IGitHubService } from "../github/types.js";
import { detectStack, type Stack } from "./scaffold.js";
import { matter, parseMatter, CONTEXT_FILE, RUNTIME_CONTEXT_FILE } from "../github/project-files.js";
import type { ProjectFilesService } from "../github/project-files.js";

/**
 * Project context pack — what an implementer reads BEFORE writing code.
 *
 * Two continuity problems, one fix:
 *  1. Implementers must code *against the existing project* (architecture,
 *     conventions, already-implemented files) instead of inventing parallel
 *     code every time. The pack carries the repo tree, stack summary,
 *     manifest excerpts, sibling/entity-matching file contents and recent
 *     memory into the code-generation prompt (real AI) and the deterministic
 *     fallback.
 *  2. Follow-up tasks must EXTEND merged work, not overwrite it. When the
 *     target file already exists on the base branch, the deterministic path
 *     keeps the existing implementation and appends the new subtask as
 *     TODOs (`extendContent`).
 *
 * The pack is also persisted as `CodeVia/context.md` (tree + stack +
 * conventions + entity registry + recent memory) so context travels with
 * git, survives restarts, and stays human-readable.
 */

export interface RelatedFile {
  path: string;
  content: string;
}

export interface RegistryEntry {
  entity: string;
  /** Most recently claimed path (kept for backward compatibility). */
  path: string;
  /** Owner file per implementer type — backend/frontend/database never collide. */
  paths?: Partial<Record<string, string>>;
  agentType: string;
  subtaskId: string;
  at: string;
}

/** Owner file of an entity for one implementer (legacy single-path aware). */
export function registryPathFor(
  registry: Record<string, RegistryEntry> | undefined,
  agentType: string,
  entity: string,
): string | undefined {
  const e = registry?.[entity];
  if (!e) return undefined;
  return e.paths?.[agentType] ?? (e.agentType === agentType ? e.path : undefined) ?? undefined;
}

export interface ContextPack {
  tree: string[];
  totalFiles: number;
  stack: Stack;
  stackSummary: string;
  configs: RelatedFile[];
  related: RelatedFile[];
  memory: Array<{ key: string; type: string; content: string }>;
  registry: Record<string, RegistryEntry>;
}

const CONFIG_MATCHERS: Array<{ test: (name: string) => boolean; priority: number }> = [
  { test: (n) => n === "package.json", priority: 0 },
  { test: (n) => n.endsWith(".csproj") || n.endsWith(".sln"), priority: 1 },
  { test: (n) => n === "pyproject.toml" || n === "requirements.txt" || n === "setup.py", priority: 2 },
  { test: (n) => n === "go.mod" || n === "pom.xml" || n === "build.gradle" || n === "composer.json", priority: 3 },
  { test: (n) => n === "Cargo.toml" || n === "Gemfile", priority: 4 },
  { test: (n) => n === "tsconfig.json" || n === "appsettings.json" || n === ".editorconfig", priority: 5 },
  { test: (n) => n === "Agent.md" || n === "README.md", priority: 6 },
];

export interface PackOptions {
  github: IGitHubService;
  project: Project;
  memoryRepo?: MemoryRepository;
  /** File about to be written — used to pick sibling + entity-matching sources. */
  target?: string;
  /** Lowercase entity route (e.g. "login") for entity matching. */
  entityRoute?: string;
  branch?: string;
  /** Code generation must distinguish a missing file from an unreadable repository. */
  strict?: boolean;
}

export async function buildContextPack(opts: PackOptions): Promise<ContextPack> {
  const { github, project } = opts;
  const branch = opts.branch || project.branch || "main";
  const [owner, ...rest] = String(project.configRepo ?? "").split("/");
  const ref = { owner, name: rest.join("/") };
  const empty: ContextPack = {
    tree: [],
    totalFiles: 0,
    stack: detectStack(project),
    stackSummary: "",
    configs: [],
    related: [],
    memory: [],
    registry: {},
  };
  empty.stackSummary = `backend ${empty.stack.backend} · frontend ${empty.stack.frontend} · project ${empty.stack.project}`;
  if (!owner || !ref.name) return empty;

  const getFile = async (path: string): Promise<string | undefined> => {
    try {
      return (await github.getFile(ref, path, branch))?.content;
    } catch (err) {
      if (opts.strict) throw err;
      return undefined;
    }
  };

  let allPaths: string[] = [];
  try {
    allPaths = (await github.listFiles(ref, branch)).filter((e) => e.type === "blob").map((e) => e.path).filter((p) => !p.startsWith(".git/"));
  } catch (err) {
    if (opts.strict) throw err;
    return empty;
  }
  empty.totalFiles = allPaths.length;
  empty.tree = allPaths.filter((p) => !p.startsWith("CodeVia/"));

  // Entity registry from the persisted context file (best-effort).
  empty.registry = parseRegistry(await getFile(RUNTIME_CONTEXT_FILE) ?? await getFile(CONTEXT_FILE));

  // Manifest / architecture-defining files, in priority order.
  const ranked = empty.tree
    .map((p) => {
      const base = p.split("/").pop() ?? p;
      const m = CONFIG_MATCHERS.find((c) => c.test(base));
      return m ? { path: p, priority: m.priority } : undefined;
    })
    .filter((x): x is { path: string; priority: number } => !!x)
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 4);
  for (const { path } of ranked) {
    const content = await getFile(path);
    if (content) empty.configs.push({ path, content: content.slice(0, 1500) });
  }

  // Siblings of the target + files matching the entity under work.
  if (opts.target) {
    const dir = opts.target.includes("/") ? opts.target.slice(0, opts.target.lastIndexOf("/")) : "";
    const siblings = empty.tree.filter((p) => p !== opts.target && (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === dir).slice(0, 3);
    const entityHits =
      opts.entityRoute && opts.entityRoute !== "feature"
        ? empty.tree.filter((p) => p !== opts.target && !siblings.includes(p) && (p.split("/").pop() ?? "").toLowerCase().includes(opts.entityRoute!)).slice(0, 2)
        : [];
    for (const path of [...siblings, ...entityHits]) {
      const content = await getFile(path);
      if (content) empty.related.push({ path, content: content.slice(0, 2500) });
    }
  }

  // Recent project memory (decisions, bugs, lessons) — newest last.
  try {
    const entries = opts.memoryRepo?.byProject(project.id) ?? [];
    empty.memory = entries.slice(-5).map((e) => ({ key: e.key, type: e.type, content: e.content.slice(0, 400) }));
  } catch {
    /* memory is advisory */
  }
  return empty;
}

export function parseRegistry(markdown: string | undefined): Record<string, RegistryEntry> {
  const out: Record<string, RegistryEntry> = {};
  if (!markdown) return out;
  const raw = parseMatter(markdown).data.registry as unknown;
  const obj = typeof raw === "string" ? tryJson(raw) : raw;
  if (!obj || typeof obj !== "object") return out;
  for (const [entity, v] of Object.entries(obj as Record<string, unknown>)) {
    const e = v as Record<string, unknown>;
    if (typeof e?.path === "string" && e.path) {
      const paths: Partial<Record<string, string>> = {};
      if (e.paths && typeof e.paths === "object") {
        for (const [k, p] of Object.entries(e.paths as Record<string, unknown>)) {
          if (typeof p === "string" && p) paths[k] = p;
        }
      }
      const agentType = typeof e.agentType === "string" ? e.agentType : "";
      if (agentType && !paths[agentType]) paths[agentType] = e.path;
      out[entity] = {
        entity,
        path: e.path,
        paths,
        agentType,
        subtaskId: typeof e.subtaskId === "string" ? e.subtaskId : "",
        at: typeof e.at === "string" ? e.at : "",
      };
    }
  }
  return out;
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function shortType(t: string): string {
  return t.replace("-developer", "").replace("qa-test", "qa");
}

export function mergeRegistry(
  existing: Record<string, RegistryEntry>,
  entries: Array<{ entity: string; path: string; agentType: string; subtaskId: string; at: string }>,
): Record<string, RegistryEntry> {
  const out = { ...existing };
  for (const e of entries) {
    const prev = out[e.entity];
    out[e.entity] = { ...e, paths: { ...(prev?.paths ?? {}), [e.agentType]: e.path } };
  }
  return out;
}

export function renderContextMarkdown(project: Project, pack: ContextPack): string {
  const registryLines = Object.values(pack.registry);
  const body = [
    `# ${project.name} — project context (for agents)`,
    ``,
    `> Auto-maintained architecture + continuity brief. Agents read this before coding: structure, stack, conventions, entity registry, recent memory.`,
    ``,
    `## Architecture`,
    `Stack: ${pack.stackSummary}.`,
    `Files on ${project.branch || "main"}: ${pack.totalFiles} (${pack.tree.length} listed).`,
    ``,
    ...pack.tree.slice(0, 80).map((p) => `- ${p}`),
    ...(pack.tree.length > 80 ? [`- … +${pack.tree.length - 80} more`] : []),
    ``,
    `## Conventions`,
    pack.configs.length === 0
      ? `(no manifest files detected yet)`
      : pack.configs.map((c) => [`### ${c.path}`, ...c.content.split("\n").slice(0, 12).map((l) => `> ${l.slice(0, 140)}`)].join("\n")).join("\n\n"),
    ``,
    `## Entity registry`,
    registryLines.length === 0
      ? `(nothing implemented yet — first implementer run fills this in)`
      : registryLines
          .map((r) => {
            const owners = Object.entries(r.paths ?? {});
            const where = owners.length ? owners.map(([t, p]) => `${shortType(t)}: \`${p}\``).join(" · ") : `\`${r.path}\``;
            return `- ${r.entity} → ${where} (last: ${r.subtaskId || "?"} · ${r.at || "?"})`;
          })
          .join("\n"),
    ``,
    `## Recent memory`,
    pack.memory.length === 0
      ? `(no memory entries yet)`
      : pack.memory.map((m) => `- [${m.type}] ${m.key}: ${m.content.split("\n")[0].slice(0, 200)}`).join("\n"),
    ``,
  ].join("\n");
  return matter(
    {
      updatedAt: new Date().toISOString(),
      backend: pack.stack.backend,
      frontend: pack.stack.frontend,
      registry: pack.registry,
    },
    body,
  );
}

/**
 * Compact context section injected into the real-AI code-generation prompt.
 * Ends with the hard rule: extend + match, never reinvent.
 */
export function renderPromptContext(pack: ContextPack, target: string): string {
  const lines: string[] = [
    `Project context for "${target}" (existing code — EXTEND it and match its conventions; do NOT reinvent parallel structures):`,
    `Stack: ${pack.stackSummary}.`,
  ];
  if (pack.tree.length > 0) {
    lines.push(`Repository tree (${pack.totalFiles} files):`);
    lines.push(...pack.tree.slice(0, 60).map((p) => `- ${p}`));
  }
  const reg = Object.values(pack.registry);
  if (reg.length > 0) {
    lines.push(`Already implemented (reuse/extend these files, never duplicate them):`);
    for (const r of reg) {
      const owners = Object.entries(r.paths ?? {});
      if (owners.length) for (const [t, p] of owners) lines.push(`- ${r.entity} [${t}] → ${p}`);
      else lines.push(`- ${r.entity} → ${r.path}`);
    }
  }
  for (const c of [...pack.related, ...pack.configs].slice(0, 6)) {
    lines.push(`--- ${c.path} ---`);
    lines.push(c.content.slice(0, 2000));
  }
  if (pack.memory.length > 0) {
    lines.push(`Project memory (decisions to respect):`);
    lines.push(...pack.memory.map((m) => `- [${m.type}] ${m.key}: ${m.content.split("\n")[0].slice(0, 200)}`));
  }
  return lines.join("\n").slice(0, 9000);
}

/* ---------------- deterministic extension (no overwrite) ---------------- */

type CommentStyle = { line: string } | { block: [string, string] };

function commentStyleFor(path: string): CommentStyle {
  const base = path.split("/").pop() ?? path;
  if (/\.(json|ipynb)$/.test(base)) throw new Error(`Cannot add simulation comments to ${path}; configure a real coding model`);
  if (/\.(css|scss|less)$/.test(base)) return { block: ["/*", "*/"] };
  if (/\.(razor|cshtml)$/.test(base)) return { block: ["@*", "*@"] };
  if (/\.(html|vue|svelte)$/.test(base)) return { block: ["<!--", "-->"] };
  if (/\.(sql)$/.test(base)) return { line: "--" };
  if (/\.(py|sh|bash|zsh|ya?ml|toml|ini|cfg)$/.test(base) || base === "Dockerfile") return { line: "#" };
  return { line: "//" };
}

function commentBlock(style: CommentStyle, lines: string[]): string {
  const safeLines = lines.flatMap((line) => line.split(/\r?\n/));
  if ("block" in style) return [style.block[0], ...safeLines.map((l) => l.split(style.block[1]).join(style.block[1].split("").join(" "))), style.block[1]].join("\n");
  return safeLines.map((l) => (l ? `${style.line} ${l}` : style.line)).join("\n");
}

export interface ExtensionInput {
  existing: string;
  path: string;
  agentName: string;
  agentType: AgentType;
  taskTitle: string;
  subtaskId: string;
  /** Short TODO bullets for the new work (already truncated upstream). */
  todos: string[];
}

/**
 * Follow-up scaffold: keeps the merged implementation byte-for-byte and adds
 * the new subtask as comment-only header + TODO footer. Comment-only, so the
 * file stays valid in every supported language.
 */
export function extendContent(input: ExtensionInput): string {
  const style = commentStyleFor(input.path);
  const head = commentBlock(style, [
    `${input.agentName} extension for "${input.taskTitle}" (subtask ${input.subtaskId}).`,
    `Existing implementation preserved below — new work ships as TODOs:`,
    ...input.todos.map((t) => `TODO: ${t}`),
  ]);
  const foot = commentBlock(style, [`TODO (${input.subtaskId}): ${input.taskTitle}`, ...input.todos.map((t) => `- ${t}`)]);
  // Keep executable-file headers at byte zero. Never truncate existing code.
  if (input.existing.startsWith("#!")) {
    const nl = input.existing.indexOf("\n");
    if (nl >= 0) return `${input.existing.slice(0, nl + 1)}${head}\n${input.existing.slice(nl + 1)}\n${foot}\n`;
  }
  if (/\.php$/i.test(input.path)) {
    if (!input.existing.startsWith("<?php") || input.existing.includes("?>")) throw new Error("Mixed PHP templates require a real coding model");
    return `<?php\n${head}\n${input.existing.slice(5)}\n${foot}\n`;
  }
  return `${head}\n${input.existing}\n${foot}\n`;
}

/* ---------------- persist the context file ---------------- */

export async function syncProjectContext(opts: {
  files: ProjectFilesService | undefined;
  github: IGitHubService;
  project: Project;
  memoryRepo?: MemoryRepository;
  entries?: Array<{ entity: string; path: string; agentType: string; subtaskId: string; at: string }>;
}): Promise<boolean> {
  if (!opts.files) return false;
  const pack = await buildContextPack({ github: opts.github, project: opts.project, memoryRepo: opts.memoryRepo, strict: true });
  const existing = parseRegistry(await opts.files.readContext(opts.project));
  pack.registry = mergeRegistry(existing, opts.entries ?? []);
  return opts.files.syncContext(opts.project, renderContextMarkdown(opts.project, pack));
}
