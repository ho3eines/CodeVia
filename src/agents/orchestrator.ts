import type { Agent, AgentType, Project, ProjectRepositoryLink, Run, Task } from "../domain/entities.js";
import type { ProjectRepository, TaskRepository, MemoryRepository } from "../domain/repos.js";
import type { AgentRepository } from "./agent-repo.js";
import type { AgentRunner, PreparePlan, RunRequest } from "./runner.js";
import type { AgentRouter } from "./router.js";
import type { IGitHubService } from "../github/types.js";
import type { ModelRepository, ProviderRepository } from "../ai/model-repo.js";
import type { ProviderRegistry } from "../ai/provider-registry.js";
import type { ProjectFilesService } from "../github/project-files.js";
import { defaultPlanFor, type PlanStep } from "./plan.js";
import { live } from "../realtime/live.js";
import { logger } from "../logger.js";
import { projectBrief } from "../domain/project-brief.js";
import { buildContextPack, renderPromptContext, syncProjectContext, registryPathFor, type RegistryEntry } from "./context.js";
import { assertWriter, defaultItem, IMPLEMENTERS, parseBreakdown, prepareImplementation, pullRequestStep, repositoryForAgent, type BreakdownItem } from "./implementation.js";
import { slugify, scaffoldFor, notePathFor, entityFor, detectStack } from "./scaffold.js";
import { assertTaskActive, ExecutionBudget, TaskCancelledError } from "./execution.js";
import { randomUUID } from "node:crypto";

export { IMPLEMENTERS, type BreakdownItem } from "./implementation.js";
export type PhaseExecutor = (task: Task, agent: Agent, project: Project, plan?: PlanStep[]) => Promise<Run>;

export interface AutonomousDeps {
  projectRepo: ProjectRepository;
  taskRepo: TaskRepository;
  agentRepo: AgentRepository;
  agentRunner: AgentRunner;
  agentRouter: AgentRouter;
  github: IGitHubService;
  githubForProject?: (project: Project) => IGitHubService;
  modelRepo: ModelRepository;
  providerRepo: ProviderRepository;
  providerRegistry?: ProviderRegistry;
  executor?: PhaseExecutor;
  maxFixLoops?: number;
  files?: ProjectFilesService;
  memoryRepo?: MemoryRepository;
}

export interface ImplementationRepository {
  repo: string;
  branch: string;
  baseBranch: string;
  sha?: string;
  files: string[];
  pullRequest?: number;
  pullRequestUrl?: string;
}
export interface AutonomousSummary {
  researchTaskId: string;
  buildTaskIds: string[];
  qaTaskIds: string[];
  fixLoops: number;
  usedRealAi: boolean;
  verification: Run["verification"];
  files: string[];
  repositories: ImplementationRepository[];
}

export function deterministicBreakdown(project: Project, task: Task, registry?: Record<string, RegistryEntry>): BreakdownItem[] {
  const text = `${task.title} ${task.description}`.toLowerCase();
  const uiLike = /\b(?:ui|ux|page|screen|frontend|react|vue|angular|mobile|design|style|css|rtl|layout)\b|رابط|صفحه|ظاهر|موبایل|راست/.test(text);
  const schemaLike = /migration|schema|database|sql|table|column|مایگریشن|دیتابیس|اسکیما|جدول/.test(text);
  const slug = slugify(task.title);
  const entity = entityFor(task.title, task.description).pascal;
  // Each implementer writes its source file first (the already-owned file
  // when this entity was implemented before — never a parallel duplicate),
  // with the change note committed next to it for traceability.
  const filesFor = (agentType: AgentType, short: string): string[] => {
    const owned = registryPathFor(registry, agentType, entity);
    const scaffold = owned ? undefined : scaffoldFor({ agentType, project, task, childId: task.id, brief: "" });
    const files = [owned ?? scaffold?.path].filter((p): p is string => !!p);
    files.push(notePathFor(task.id, short, slug));
    return files;
  };
  const items: BreakdownItem[] = [
    {
      agentType: "backend-developer",
      title: `Implement (backend): ${task.title}`.slice(0, 120),
      description: task.description,
      files: filesFor("backend-developer", "backend"),
    },
  ];
  if (uiLike) {
    items.push({
      agentType: "frontend-developer",
      title: `Implement (frontend): ${task.title}`.slice(0, 120),
      description: task.description,
      files: filesFor("frontend-developer", "frontend"),
    });
  }
  if (schemaLike) {
    items.push({
      agentType: "database",
      title: `Implement (database): ${task.title}`.slice(0, 120),
      description: task.description,
      files: filesFor("database", "database"),
    });
  }
  return items;
}

/** Duty line prepended to every implementer subtask so each unit's job is explicit. */
export const IMPLEMENTER_DUTIES: Record<string, string> = {
  "backend-developer":
    "Your duty: implement the server-side work (APIs, services, business logic) for this subtask, commit the code, and open a PR.",
  "frontend-developer":
    "Your duty: implement the UI work (pages, components, client logic) for this subtask, commit the code, and open a PR.",
  database:
    "Your duty: implement the data work (schema, migrations, queries) for this subtask, commit it, and open a PR.",
  uiux:
    "Your duty: implement the UX/design work (layout, styles, user flows) for this subtask, commit it, and open a PR.",
};

export const QA_DUTY =
  "Your duty: verify the implementation listed below against the research brief. Report every failure precisely (what, where, expected vs actual) so the fix agent can act on it.";

/**
 * Deterministic research brief (no-AI fallback): requirements distilled from
 * the request, affected areas from keyword signals, owners from the
 * deterministic breakdown, repo signals, and standing risks. The project
 * definition selections are always embedded via the brief.
 */
export function deterministicBrief(project: Project, task: Task, repoFiles: string[], researchSummary: string): string {
  const text = `${task.title} ${task.description}`;
  const sentences = text
    .split(/[.\n؛]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3)
    .slice(0, 6);
  const lower = text.toLowerCase();
  const areas: string[] = [];
  if (/ui|ux|page|screen|design|style|رابط|صفحه|ظاهر/.test(lower)) areas.push("UI/pages");
  if (/api|endpoint|server|service|backend/.test(lower)) areas.push("backend APIs/services");
  if (/auth|login|permission|role/.test(lower)) areas.push("authentication/authorization");
  if (/migration|schema|table|database|sql|مایگریشن|دیتابیس/.test(lower)) areas.push("database schema");
  if (/test|qa|تست/.test(lower)) areas.push("test coverage");
  if (areas.length === 0) areas.push("general implementation");
  const owners = deterministicBreakdown(project, task).map((i) => i.agentType);
  return [
    `Research brief for "${task.title}" (deterministic — connect a real AI provider for model-written analysis).`,
    ``,
    `Requirements:`,
    ...sentences.map((s) => `- ${s}`),
    ``,
    `Affected areas: ${areas.join(", ")}.`,
    `Suggested owners: ${owners.join(", ")}.`,
    `Stack: backend ${detectStack(project).backend} · frontend ${detectStack(project).frontend}.`,
    `Repository signals: ${repoFiles.length} file(s) visible on ${project.branch}; research run observed:`,
    ...researchSummary.split("\n").slice(0, 6).map((l) => `  ${l.slice(0, 140)}`),
    ``,
    projectBrief(project),
    ``,
    `Standing risks: secrets must stay out of git; merges/deploys/migrations need human approval; every change ships as a PR.`,
  ].join("\n");
}



interface WorkingCopy extends ImplementationRepository {
  link: ProjectRepositoryLink;
  agent: Agent;
  task: Task;
  exists: boolean;
}

/** GitHub → research → specialized implementation → CI/QA → bounded fixes → human review. */
export class AutonomousOrchestrator {
  constructor(private readonly deps: AutonomousDeps) {}

  async run(taskId: string): Promise<AutonomousSummary> {
    const task = this.deps.taskRepo.findById(taskId)?.data;
    if (!task) throw new Error(`Task ${taskId} not found`);
    let project = this.deps.projectRepo.findById(task.projectId)?.data;
    if (!project) throw new Error(`Project ${task.projectId} not found`);
    const active = () => assertTaskActive(this.deps.taskRepo, task);
    active();
    // Config is read before preflight and the refreshed project is reloaded.
    // Live task state must never be restored over a running/cancelled task.
    if (this.deps.files && this.deps.memoryRepo) {
      await this.deps.files.restore(project, { projectRepo: this.deps.projectRepo, taskRepo: this.deps.taskRepo, agentRepo: this.deps.agentRepo, memoryRepo: this.deps.memoryRepo }, { includeTasks: false });
      project = this.deps.projectRepo.findById(project.id)!.data;
    }
    active();
    const github = this.deps.githubForProject?.(project) ?? this.deps.github;
    const budget = new ExecutionBudget(project.settings.budget);
    const check = () => { active(); budget.check(); };
    const researchAgent = this.needAgent(project.id, "research");
    const qaAgent = this.needAgent(project.id, "qa-test");
    if (!qaAgent.tools.includes("run_tests")) throw new Error("Autonomous preflight failed: QA needs the run_tests CI verification tool");
    let available = IMPLEMENTERS.filter((t) => this.deps.agentRepo.byType(project!.id, t)?.enabled);
    if (typeof task.input?.agentHint === "string" && available.includes(task.input.agentHint as AgentType)) available = [task.input.agentHint as AgentType];
    if (!available.length) throw new Error("Autonomous preflight failed: no enabled implementer");
    const pack = await buildContextPack({ github, project, memoryRepo: this.deps.memoryRepo, strict: true });
    check();
    let brief = "";
    let breakdown: BreakdownItem[] = [];
    let usedRealAi = false;
    const researchTask = this.spawn(task, `Research: ${task.title}`, task.description, "research");
    const researchPlan: PreparePlan = async (ctx) => {
      if (ctx.chat) {
        usedRealAi = true;
        brief = await ctx.chat.chat("You are a senior business analyst writing an implementation brief. Return requirements, affected areas, acceptance criteria and risks, under 400 words.", `Task: ${task.title}\n${task.description}\n${projectBrief(project!)}\n${renderPromptContext(pack, "(research)")}`, 1500);
        const raw = await ctx.chat.chat("You are an engineering manager breaking work into implementer subtasks. Reply ONLY with a JSON array.", `Task: ${task.title}\n${task.description}\nResearch brief:\n${brief}\n${renderPromptContext(pack, "(planning)")}\nAllowed agentType values (enabled in this project): ${available.join(", ")}. Return 1–4 items: {"agentType","title","description","files":[1–5 repo-relative paths]}. Reuse the exact existing files, and define matching API contracts for backend/frontend.`, 2000);
        breakdown = parseBreakdown(raw, available);
        for (const item of breakdown) {
          const owned = registryPathFor(pack.registry, item.agentType, entityFor(item.title, item.description).pascal);
          if (owned && item.files[0] !== owned) item.files = [owned, ...item.files.slice(1).filter((p) => p !== owned)];
        }
      } else {
        if (github.kind === "real") throw new Error("No real model configured: a real repository cannot run a simulated implementation loop");
        brief = deterministicBrief(project!, task, pack.tree, "Repository context inspected; simulation only, not model-written analysis.");
        breakdown = this.simulatedBreakdown(project!, task, pack.registry, available);
      }
      ctx.setSummary(brief);
      return defaultPlanFor(researchAgent, researchTask);
    };
    const researchRun = await this.phase(researchTask, researchAgent, project, { preparePlan: researchPlan, taskBudget: budget, category: "research" });
    this.requireSuccess(researchRun, "Research");
    // The executor seam can simulate phases without preparing model plans.
    if (!brief) brief = deterministicBrief(project, task, pack.tree, summarizeRun(researchRun));
    if (!breakdown.length) breakdown = this.simulatedBreakdown(project, task, pack.registry, available);
    check();
    this.updateParent(task, { input: { ...this.deps.taskRepo.findById(task.id)!.data.input, researchBrief: brief, breakdown } });
    for (const item of breakdown) assertWriter(this.needAgent(project.id, item.agentType));

    const buildTaskIds: string[] = [];
    const qaTaskIds: string[] = [];
    const work = new Map<string, WorkingCopy>();
    const claims: Array<{ entity: string; path: string; agentType: string; subtaskId: string; at: string }> = [];
    const artifacts = () => [...work.values()].map(({ repo, branch, baseBranch, sha, files, pullRequest, pullRequestUrl }) => ({ repo, branch, baseBranch, sha, files, pullRequest, pullRequestUrl }));
    const saveArtifacts = () => this.updateParent(task, { result: { ...this.deps.taskRepo.findById(task.id)!.data.result, repositories: artifacts(), researchBrief: brief, usedRealAi } });
    const implement = async (item: BreakdownItem, fixContext?: string) => {
      check();
      const agent = this.needAgent(project!.id, item.agentType);
      const child = this.spawn(task, fixContext ? `Fix (attempt ${fixLoops}): ${item.title}` : item.title, `${IMPLEMENTER_DUTIES[item.agentType]}\n\nResearch brief:\n${brief}\n\nSubtask:\n${item.description}${fixContext ? `\n\nQA failures:\n${fixContext}` : ""}`, item.agentType);
      buildTaskIds.push(child.id);
      const link = repositoryForAgent(project!, item.agentType);
      let working = work.get(link.repo);
      if (!working) {
        working = { link, repo: link.repo, baseBranch: link.branch, branch: `agent-task-${task.id.replace(/^task-/, "")}`, files: [], agent, task: child, exists: false };
        work.set(link.repo, working);
      }
      const current = working;
      const repository = { ...link, branch: current.exists ? current.branch : current.baseBranch, defaultBranch: current.baseBranch };
      const run = await this.phase(child, agent, project!, {
        repository, taskBudget: budget, category: "coding",
        preparePlan: async (ctx) => {
          usedRealAi ||= Boolean(ctx.chat);
          const otherDeliverables: string[] = [];
          for (const other of work.values()) {
            if (other.repo === current.repo || !other.exists) continue;
            const [owner, name] = other.repo.split("/");
            for (const path of other.files.filter((p) => !p.startsWith("docs/tasks/"))) {
              const file = await github.getFile({ owner, name }, path, other.branch);
              if (file) otherDeliverables.push(`--- ${other.repo}@${other.branch}:${path} ---\n${file.content.slice(0, 12000)}`);
            }
          }
          return prepareImplementation(ctx, agent, child, item, { branch: current.branch, baseBranch: current.baseBranch, brief, fixContext, memoryRepo: this.deps.memoryRepo, handoff: otherDeliverables.join("\n").slice(0, 32000) });
        },
      });
      this.requireSuccess(run, agent.name);
      current.exists = true;
      const sha = run.steps.find((s) => s.tool === "write_file" && s.status === "succeeded")?.data?.sha;
      current.sha = typeof sha === "string" ? sha : current.sha;
      current.files = [...new Set([...current.files, ...item.files])];
      claims.push({ entity: entityFor(item.title, item.description).pascal, path: item.files[0], agentType: item.agentType, subtaskId: child.id, at: new Date().toISOString() });
      saveArtifacts();
    };
    // Data contracts are established before their UI consumers, irrespective of
    // the order returned by the model. Same-repo agents share one task branch.
    const order: Partial<Record<AgentType, number>> = { database: 0, "backend-developer": 1, "frontend-developer": 2, uiux: 3 };
    breakdown.sort((a, b) => (order[a.agentType] ?? 4) - (order[b.agentType] ?? 4));
    for (const item of breakdown) await implement(item);

    // One draft PR per repository enables pull_request CI. Fixes update these
    // same branches/PRs, never fresh branches from the unchanged base.
    for (const working of work.values()) {
      check();
      const run = await this.phase(working.task, working.agent, project, {
        repository: { ...working.link, branch: working.branch, defaultBranch: working.baseBranch }, taskBudget: budget,
        plan: [pullRequestStep(working.agent, task, working.repo, working.branch, working.baseBranch, working.files)],
      });
      this.requireSuccess(run, "Open review PR");
      const evidence = run.steps.find((s) => s.tool === "create_pull_request")?.data;
      working.pullRequest = typeof evidence?.number === "number" ? evidence.number : undefined;
      working.pullRequestUrl = typeof evidence?.url === "string" ? evidence.url : undefined;
    }
    saveArtifacts();

    let fixLoops = 0;
    let verification: Run["verification"];
    for (;;) {
      check();
      const qaTask = this.spawn(task, fixLoops ? `Re-verify (attempt ${fixLoops + 1}): ${task.title}` : `Verify: ${task.title}`, `${QA_DUTY}\n\nResearch brief:\n${brief}\n\nChanged files:\n${artifacts().map((r) => `${r.repo}@${r.branch}: ${r.files.join(", ")}`).join("\n")}`, "qa-test");
      qaTaskIds.push(qaTask.id);
      const qaPlan: PlanStep[] = [...work.values()].flatMap((r) => [
        ...r.files.filter((p) => !p.startsWith("docs/tasks/")).map((path) => ({ label: `Inspect ${r.repo}:${path}`, tool: "read_file", input: { repo: r.repo, branch: r.branch, path } })),
        { label: `Verify build and tests: ${r.repo}`, tool: "run_tests", input: { repo: r.repo, ref: r.branch, expectedSha: r.sha } },
      ]);
      if (qaAgent.tools.includes("save_memory")) qaPlan.push({ label: "Save QA evidence to memory", tool: "save_memory", input: { key: `qa-test/${qaTask.id}`, type: "technical", fromSteps: true } });
      const qaRun = await this.phase(qaTask, qaAgent, project, { plan: qaPlan, taskBudget: budget });
      verification = qaRun.verification;
      this.updateParent(task, { result: { ...this.deps.taskRepo.findById(task.id)!.data.result, verification, qaTaskIds, fixLoops } });
      if (qaRun.status === "succeeded") break;
      if (!qaRun.steps.some((s) => s.status === "failed" && s.data?.verification === "failed" && s.data?.fixable === true)) {
        throw Object.assign(new Error(`QA could not verify the implementation: ${runError(qaRun)}`), { retryable: false });
      }
      if (fixLoops >= (this.deps.maxFixLoops ?? 2)) throw Object.assign(new Error(`QA still failing after ${fixLoops} fix loop(s): ${runError(qaRun)}`), { retryable: false });
      fixLoops += 1;
      const failure = runError(qaRun);
      const failedRepo = qaRun.steps.find((s) => s.status === "failed")?.data?.repo;
      const candidates = breakdown.filter((item) => !failedRepo || repositoryForAgent(project!, item.agentType).repo === failedRepo);
      const routed = this.deps.agentRouter.route(failure, "error");
      const fixType = routed === "uiux" && candidates.some((i) => i.agentType === "frontend-developer") ? "frontend-developer" : routed;
      const fixItem = candidates.find((i) => i.files.some((p) => failure.includes(p))) ?? candidates.find((i) => i.agentType === fixType) ?? candidates[0] ?? breakdown[0];
      await implement(fixItem, failure);
    }
    check();
    for (const working of work.values()) {
      if (!working.pullRequest) continue;
      const [owner, name] = working.repo.split("/");
      try {
        await github.commentOnPullRequest({ owner, name }, working.pullRequest, `CodeVia verification: **${verification ?? "unverified"}** for commit \`${working.sha ?? "unknown"}\`.\n${verification === "simulated" ? "Simulation only — no build/tests were executed." : "See the GitHub checks for this commit and the task's QA evidence."}\nHuman review is required; this draft PR is not automatically published or merged.`);
      } catch (err) {
        logger.warn("Could not publish QA evidence to PR", { projectId: project.id, err: String(err) });
      }
      check();
    }
    await syncProjectContext({ files: this.deps.files, github, project, memoryRepo: this.deps.memoryRepo, entries: claims });
    return { researchTaskId: researchTask.id, buildTaskIds, qaTaskIds, fixLoops, usedRealAi, verification: verification ?? (usedRealAi ? "unverified" : "simulated"), files: [...new Set(artifacts().flatMap((r) => r.files))], repositories: artifacts() };
  }

  private needAgent(projectId: string, type: AgentType): Agent {
    const agent = this.deps.agentRepo.byType(projectId, type);
    if (!agent?.enabled) throw new Error(`Autonomous preflight failed: no enabled ${type} agent in project ${projectId}`);
    return agent;
  }

  private simulatedBreakdown(project: Project, task: Task, registry: Record<string, RegistryEntry>, available: AgentType[]): BreakdownItem[] {
    const hint = task.input?.agentHint;
    if (typeof hint === "string" && available.includes(hint as AgentType)) return [defaultItem(project, task, hint as AgentType, registry)];
    const items = deterministicBreakdown(project, task, registry).filter((i) => available.includes(i.agentType));
    return items.length ? items : [defaultItem(project, task, available[0], registry)];
  }

  private spawn(parent: Task, title: string, description: string, agentType: AgentType): Task {
    assertTaskActive(this.deps.taskRepo, parent);
    const now = new Date().toISOString();
    const child: Task = { id: `task-${randomUUID().slice(0, 8)}`, projectId: parent.projectId, parentTaskId: parent.id, title: title.slice(0, 120), description, priority: parent.priority, status: "running", agentType, correlationId: parent.correlationId, input: { autonomous: true, parentTaskId: parent.id }, createdAt: now, updatedAt: now };
    this.deps.taskRepo.upsert(child, { projectId: parent.projectId, parentId: parent.id });
    live.emit({ type: "task.updated", taskId: child.id, data: { status: "running", parentTaskId: parent.id, projectId: parent.projectId } });
    return child;
  }

  private async phase(task: Task, agent: Agent, project: Project, opts: Partial<RunRequest>): Promise<Run> {
    try {
      assertTaskActive(this.deps.taskRepo, task);
      const current = this.deps.taskRepo.findById(task.id)!.data;
      this.deps.taskRepo.upsert({ ...current, status: "running", error: undefined, updatedAt: new Date().toISOString() }, { projectId: task.projectId, parentId: task.parentTaskId });
      const run = this.deps.executor
        ? await this.deps.executor(task, agent, project, opts.plan)
        : await this.deps.agentRunner.run({ ...opts, task, agent, project, providerRegistry: this.deps.providerRegistry });
      assertTaskActive(this.deps.taskRepo, task);
      await this.mark(task, run.status === "succeeded" ? "succeeded" : "failed", run.status === "succeeded" ? undefined : runError(run));
      return run;
    } catch (err) {
      await this.mark(task, err instanceof TaskCancelledError ? "cancelled" : "failed", String(err));
      throw err;
    }
  }

  private async mark(task: Task, status: Task["status"], error?: string): Promise<void> {
    const stored = this.deps.taskRepo.findById(task.id)?.data;
    if (!stored) return;
    const next: Task = { ...stored, status: stored.status === "cancelled" ? "cancelled" : status, error, updatedAt: new Date().toISOString() };
    this.deps.taskRepo.upsert(next, { projectId: task.projectId, parentId: task.parentTaskId });
    live.emit({ type: "task.updated", taskId: task.id, data: { status: next.status, projectId: task.projectId } });
    const project = this.deps.projectRepo.findById(task.projectId)?.data;
    if (project && this.deps.files) await this.deps.files.syncTask(project, next);
  }

  private updateParent(task: Task, patch: Partial<Task>): void {
    assertTaskActive(this.deps.taskRepo, task);
    const current = this.deps.taskRepo.findById(task.id)!.data;
    this.deps.taskRepo.upsert({ ...current, ...patch, updatedAt: new Date().toISOString() }, { projectId: task.projectId, parentId: task.parentTaskId });
  }

  private requireSuccess(run: Run, label: string): void {
    if (run.status !== "succeeded") throw Object.assign(new Error(`${label} failed: ${runError(run)}`), { retryable: false });
  }
}

function summarizeRun(run: Run): string {
  return run.summary ?? run.steps.map((s) => `- ${s.label}: ${s.status}${s.detail ? ` — ${s.detail}` : ""}`).join("\n");
}
function runError(run: Run): string {
  return run.steps.filter((s) => s.status === "failed").map((s) => `${s.label}: ${s.detail ?? run.error ?? ""}`).join("\n") || run.error || "unknown error";
}
