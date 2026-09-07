import type { Agent, AgentType, Project, ProjectRepositoryLink, Task } from "../domain/entities.js";
import type { MemoryRepository } from "../domain/repos.js";
import type { GithubFile } from "../github/types.js";
import type { PlanStep } from "./plan.js";
import type { PrepareContext } from "./runner.js";
import { extractJson } from "./llm.js";
import { buildContextPack, extendContent, registryPathFor, renderPromptContext, type RegistryEntry } from "./context.js";
import { changeNote, entityFor, notePathFor, scaffoldFor, slugify } from "./scaffold.js";

export const IMPLEMENTERS: AgentType[] = ["backend-developer", "frontend-developer", "database", "uiux"];
const WRITERS: AgentType[] = [...IMPLEMENTERS, "documentation", "refactoring", "performance"];
export const isWriter = (type: AgentType): boolean => WRITERS.includes(type);
export const MAX_FILE_CHARS = 200_000;

export interface BreakdownItem {
  agentType: AgentType;
  title: string;
  description: string;
  files: string[];
}

/** Code repositories are chosen from the project definition, never from model output. */
export function repositoryForAgent(project: Project, type: AgentType): ProjectRepositoryLink {
  const roles = type === "frontend-developer" || type === "uiux" ? ["frontend", "mobile"] : type === "documentation" ? ["docs"] : ["backend"];
  const links = project.repositories ?? [];
  const link = roles.map((role) => links.find((r) => r.role === role)).find(Boolean)
    ?? links.find((r) => r.isConfigRepo)
    ?? links.find((r) => r.repo === project.configRepo)
    ?? { repo: project.configRepo, branch: project.branch, role: "primary" as const, isConfigRepo: true };
  return { ...link, defaultBranch: link.branch };
}

export function cleanRepoPath(value: unknown): string {
  if (typeof value !== "string") throw new Error("A repository-relative file path is required");
  const path = value.trim();
  if (!path || path.length > 300 || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some((p) => !p || p === "." || p === "..")) {
    throw new Error(`Unsafe repository path: ${path}`);
  }
  if (path === ".git" || path.startsWith(".git/") || path === "CodeVia" || path.startsWith("CodeVia/")) {
    throw new Error(`Agent source edits cannot overwrite managed state: ${path}`);
  }
  return path;
}

/** Exact edits preserve all bytes outside the requested replacements. No whole-file regeneration for existing code. */
export function applyFileEdits(existing: string, response: string): string {
  const parsed = extractJson(response) as { edits?: unknown } | undefined;
  if (!Array.isArray(parsed?.edits) || parsed.edits.length === 0 || parsed.edits.length > 30) {
    throw new Error("Existing files require a JSON {edits:[{oldText,newText}]} patch, not a rewritten file");
  }
  let result = existing;
  for (const value of parsed.edits) {
    const edit = value as { oldText?: unknown; newText?: unknown } | null;
    if (!edit || typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string") throw new Error("Invalid file edit");
    const at = result.indexOf(edit.oldText);
    if (at < 0 || result.indexOf(edit.oldText, at + 1) !== -1) throw new Error("Patch oldText must match exactly once; no ambiguous or missing replacements");
    result = result.slice(0, at) + edit.newText + result.slice(at + edit.oldText.length);
  }
  if (result.length > MAX_FILE_CHARS) throw new Error("Generated file exceeds the safe size limit");
  return result;
}

export function assertWriter(agent: Agent): void {
  const write = agent.permissions.includes("github.write") || agent.permissions.includes("repository.write");
  if (!write || !["read_file", "write_file", "create_branch", "create_pull_request"].every((t) => agent.tools.includes(t))) {
    throw new Error(`${agent.name} needs read_file, write_file, create_branch and create_pull_request with repository write permission; refusing a base-branch fallback`);
  }
}

export function defaultItem(project: Project, task: Task, type: AgentType, registry?: Record<string, RegistryEntry>): BreakdownItem {
  const owned = registryPathFor(registry, type, entityFor(task.title, task.description).pascal);
  const scaffold = scaffoldFor({ agentType: type, project, task, childId: task.id, brief: "" });
  return {
    agentType: type,
    title: `Implement (${type.replace("-developer", "")}): ${task.title}`.slice(0, 120),
    description: task.description,
    files: [...new Set([owned ?? scaffold?.path, notePathFor(task.id, type.replace("-developer", ""), slugify(task.title))].filter((p): p is string => !!p))],
  };
}

/** Parse the model's allowed paths strictly; never silently drop requested files. */
export function parseBreakdown(raw: string, allowed: AgentType[]): BreakdownItem[] {
  const parsed = extractJson(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 4) throw new Error("Expected 1–4 implementer subtasks");
  return parsed.map((value) => {
    const item = value as Record<string, unknown> | null;
    if (!item || !allowed.includes(item.agentType as AgentType) || typeof item.title !== "string" || !item.title.trim()) throw new Error("Breakdown selected an unavailable implementer or empty title");
    if (!Array.isArray(item.files) || item.files.length < 1 || item.files.length > 5) throw new Error("Each subtask requires 1–5 file paths");
    const files = item.files.map(cleanRepoPath);
    if (new Set(files).size !== files.length) throw new Error("Breakdown contains duplicate file paths");
    return { agentType: item.agentType as AgentType, title: item.title.slice(0, 120), description: String(item.description ?? ""), files };
  });
}

export interface ImplementationOptions {
  branch: string;
  baseBranch: string;
  brief: string;
  fixContext?: string;
  memoryRepo?: MemoryRepository;
  /** API contracts / source files already delivered in other linked repositories. */
  handoff?: string;
}

/** Generate every file before the first write; commit the validated batch atomically. */
export async function prepareImplementation(
  ctx: PrepareContext, agent: Agent, child: Task, item: BreakdownItem, opts: ImplementationOptions,
): Promise<PlanStep[]> {
  assertWriter(agent);
  if (!ctx.chat && ctx.github.kind === "real") throw new Error("No real coding model configured. Simulation scaffolds cannot be committed to a real repository.");
  const paths = item.files.map(cleanRepoPath);
  if (!paths.length || paths.length > 5 || new Set(paths).size !== paths.length) throw new Error("Expected 1–5 distinct file paths");
  const [owner, name] = ctx.project.configRepo.split("/");
  const repo = { owner, name };
  const branches = await ctx.github.listBranches(repo);
  const working = branches.find((b) => b.name === opts.branch);
  const source = working ?? branches.find((b) => b.name === opts.baseBranch);
  if (!source) throw new Error(`Base branch ${opts.baseBranch} not found`);
  if (opts.branch === opts.baseBranch) throw new Error("Implementation requires a feature branch");
  const sourceProject = { ...ctx.project, branch: source.sha };
  const generated: GithubFile[] = [];
  for (const target of paths) {
    ctx.checkActive();
    const pack = await buildContextPack({ github: ctx.github, project: sourceProject, memoryRepo: opts.memoryRepo, target, entityRoute: entityFor(item.title, item.description).route, strict: true });
    // Missing is distinct from unreadable. Read/network errors abort the run.
    const existing = (await ctx.github.getFile(repo, target, source.sha))?.content;
    if (existing !== undefined && existing.length > MAX_FILE_CHARS) throw new Error(`${target} is too large to edit safely; split the task instead of truncating it`);
    let content: string;
    if (ctx.chat) {
      const previous = generated.map((f) => `--- Proposed ${f.path} ---\n${f.content}`).join("\n");
      const request = [
        `Subtask: ${item.title}\n${item.description}`,
        `Research brief:\n${opts.brief}`,
        opts.fixContext ? `QA failures to fix:\n${opts.fixContext}` : "",
        renderPromptContext(pack, target),
        opts.handoff ? `Other repository deliverables (match these API contracts):\n${opts.handoff}` : "",
        previous ? `Earlier files in this SAME atomic change (use their exact exports/contracts):\n${previous}` : "",
        existing !== undefined
          ? `The file "${target}" ALREADY EXISTS. Its COMPLETE current content follows:\n--- START CURRENT FILE ---\n${existing}\n--- END CURRENT FILE ---\nEXTEND it. Reply ONLY with JSON {"edits":[{"oldText":"exact unique existing text","newText":"replacement"}]}. Preserve all other code. No whole-file rewrite. Include sufficient surrounding text to make each oldText unique.`
          : `The file "${target}" does not exist yet. Write the complete content of "${target}" using the repository's existing architecture and conventions. Output ONLY file content, no fences or explanations.`,
      ].filter(Boolean).join("\n\n");
      const raw = await ctx.chat.chat(`You are implementing the ${agent.name} subtask. Follow the configured project rules and preserve existing behavior.`, request, 8000);
      content = existing !== undefined ? applyFileEdits(existing, raw) : raw.replace(/^\s*```[^\n]*\n/, "").replace(/\n```\s*$/, "");
      if (!content.trim() || content.includes("\u0000") || content.length > MAX_FILE_CHARS) throw new Error(`Invalid or oversized generated content for ${target}`);
    } else if (target.startsWith("docs/tasks/")) {
      content = changeNote(agent.name, child, item.description, opts.brief, opts.fixContext);
    } else if (existing !== undefined) {
      content = extendContent({ existing, path: target, agentName: agent.name, agentType: agent.type, taskTitle: item.title, subtaskId: child.id, todos: [item.description || item.title, ...(opts.fixContext ? [opts.fixContext] : [])] });
    } else {
      const scaffold = scaffoldFor({ agentType: agent.type, project: ctx.project, task: { ...child, title: item.title.replace(/^Implement \([^)]*\):\s*/i, ""), description: item.description }, childId: child.id, brief: opts.brief, fixContext: opts.fixContext });
      if (!scaffold || scaffold.path !== target) throw new Error(`Simulation cannot generate ${target}; configure a real coding model`);
      content = scaffold.content;
    }
    generated.push({ path: target, content });
  }
  ctx.checkActive();
  ctx.setSummary(`${ctx.chat ? "Implementation" : "Simulation scaffold (not a completed feature)"}: ${item.title}\nRepository: ${ctx.project.configRepo}\nBranch: ${opts.branch}\nFiles:\n${paths.map((p) => `- ${p}`).join("\n")}`);
  return [
    { label: "Understand request", detail: item.description },
    { label: "Inspect repository", tool: "read_file", input: { branch: source.sha } },
    { label: "Plan the change", detail: `Read existing files and prepared ${paths.length} file(s) before writing.` },
    ...(working ? [] : [{ label: `Create branch ${opts.branch}`, tool: "create_branch", input: { name: opts.branch, from: opts.baseBranch, sha: source.sha } }]),
    { label: "Implement the change", tool: "write_file", input: { files: generated, branch: opts.branch, expectedHead: source.sha, message: `[${agent.name}] ${child.title}`.slice(0, 120) } },
  ];
}

export function pullRequestStep(agent: Agent, task: Task, repo: string, branch: string, base: string, paths: string[]): PlanStep {
  return {
    label: "Create pull request", tool: "create_pull_request", requiresApproval: true,
    input: { repo, head: branch, base, title: `[CodeVia] ${task.title}`.slice(0, 120), taskTitle: task.title, taskDescription: task.description, changes: paths, tests: ["Verification pending. Do not merge until the task's GitHub CI gate passes."], risks: ["Generated change; human review and passing CI are required before merge."], draft: true },
  };
}

/** Direct and workflow writer runs use the SAME implementation path as autonomous tasks. */
export async function prepareSingleImplementation(ctx: PrepareContext, agent: Agent, task: Task, memoryRepo?: MemoryRepository): Promise<PlanStep[]> {
  assertWriter(agent);
  const branch = task.workflowId ? `agent-task-${task.id.replace(/^task-/, "")}` : `agent-${agent.slug}-${task.id.replace(/^task-/, "")}`.slice(0, 80);
  const [owner, name] = ctx.project.configRepo.split("/");
  const exists = (await ctx.github.listBranches({ owner, name })).some((b) => b.name === branch);
  const pack = await buildContextPack({ github: ctx.github, project: { ...ctx.project, branch: exists ? branch : ctx.project.branch }, memoryRepo, strict: true });
  let item = defaultItem(ctx.project, task, agent.type, pack.registry);
  if (ctx.chat) {
    const raw = await ctx.chat.chat("Plan this single-agent implementation. Reply ONLY with a JSON array containing one subtask.", `Task: ${task.title}\n${task.description}\n${renderPromptContext(pack, "(planning)")}\nAllowed agentType: ${agent.type}. Schema: [{"agentType","title","description","files":[1–5 repository-relative file paths]}]. Reuse existing files.`, 2000);
    const items = parseBreakdown(raw, [agent.type]);
    if (items.length !== 1) throw new Error("A single-agent task must produce one implementation item");
    item = items[0];
  }
  const handoff: string[] = [];
  const workflow = task.input?.workflow as { artifacts?: unknown } | undefined;
  if (Array.isArray(workflow?.artifacts)) {
    for (const artifact of workflow.artifacts as Array<{ repo: string; branch: string; sha?: string; files: string[] }>) {
      if (artifact.repo === ctx.project.configRepo) continue;
      if (!ctx.project.repositories?.some((r) => r.repo === artifact.repo)) throw new Error("Handoff repository is not linked to this project");
      const [owner, name] = artifact.repo.split("/");
      for (const path of artifact.files.filter((p) => !p.startsWith("docs/tasks/"))) {
        ctx.checkActive();
        const file = await ctx.github.getFile({ owner, name }, cleanRepoPath(path), artifact.sha ?? artifact.branch);
        if (!file) throw new Error(`Previous implementation artifact is missing: ${artifact.repo}:${path}`);
        handoff.push(`--- ${artifact.repo}@${artifact.sha ?? artifact.branch}:${path} (context excerpt) ---\n${file.content.slice(0, 12000)}`);
      }
    }
  }
  const plan = await prepareImplementation(ctx, agent, task, item, { branch, baseBranch: ctx.project.branch, brief: task.description, memoryRepo, handoff: handoff.join("\n").slice(0, 32000) });
  plan.push(pullRequestStep(agent, task, ctx.project.configRepo, branch, ctx.project.branch, item.files));
  // A workflow QA node verifies the integrated branch after all writers finish.
  if (task.workflowId) return plan;
  // Verification reads remote CI, never executes the platform's own npm scripts.
  if (!agent.tools.includes("run_tests")) throw new Error(`${agent.name} needs run_tests to verify a standalone implementation`);
  plan.push({ label: "Verify build and tests (GitHub CI)", tool: "run_tests", input: { repo: ctx.project.configRepo, ref: branch } });
  return plan;
}
