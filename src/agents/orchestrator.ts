import type { Agent, AgentType, Project, ProjectRepositoryLink, Run, Task } from "../domain/entities.js";
import type { ProjectRepository, TaskRepository, MemoryRepository } from "../domain/repos.js";
import type { AgentRepository } from "./agent-repo.js";
import type { AgentRunner, PreparePlan, RunRequest } from "./runner.js";
import type { AgentRouter } from "./router.js";
import type { IGitHubService } from "../github/types.js";
import type { ModelRepository, ProviderRepository } from "../ai/model-repo.js";
import type { ProviderRegistry } from "../ai/provider-registry.js";
import type { ProjectFilesService } from "../github/project-files.js";
import type { SkillRegistry } from "../skills/registry.js";
import { PLANNING_INSTRUCTION, RESEARCH_INSTRUCTION, planningRequest, researchRequest } from "./planning.js";
import { defaultPlanFor, type PlanStep } from "./plan.js";
import { live } from "../realtime/live.js";
import { logger } from "../logger.js";
import { projectBrief } from "../domain/project-brief.js";
import { buildContextPack, renderPromptContext, syncProjectContext, registryPathFor, type RegistryEntry } from "./context.js";
import { assertWriter, defaultItem, IMPLEMENTERS, orderBreakdown, parseBreakdown, prepareImplementation, pullRequestStep, repositoryForAgent, type BreakdownItem } from "./implementation.js";
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
  skillsRegistry: SkillRegistry;
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
  documentation:
    "Your duty: update the relevant setup, architecture or API documentation for this subtask, verify it against the implementation, and deliver it in the review PR.",
  refactoring:
    "Your duty: improve the specified code structure without changing behavior; preserve contracts and add regression coverage in the review PR.",
  performance:
    "Your duty: address the specified bottleneck, preserve behavior and document measurable verification in the review PR.",
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
    try {
      return await this.execute(taskId);
    } catch (err) {
      // Planned tasks are visible before dispatch. Do not leave unexecuted
      // dependants looking runnable after an upstream failure/cancellation.
      for (const { data: child } of this.deps.taskRepo.findMany({ parentId: taskId })) {
        if (["created", "queued", "running"].includes(child.status)) {
          await this.mark(child, "cancelled", `Not executed: the owning task stopped. ${String(err)}`);
        }
      }
      throw err;
    }
  }

  private async execute(taskId: string): Promise<AutonomousSummary> {
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
    const hint = task.input?.agentHint ?? task.agentType;
    if (hint !== undefined && hint !== "") {
      if (typeof hint !== "string" || !available.includes(hint as AgentType)) throw new Error(`Autonomous preflight failed: requested implementer ${String(hint)} is unavailable`);
      available = [hint as AgentType];
    }
    if (!available.length) throw new Error("Autonomous preflight failed: no enabled implementer");

    // --- (F1) Context cache hydrate: pull the persisted project context file
    // into memory BEFORE scanning so research sees a warm registry on repeat
    // runs instead of rebuilding the world from Git every time.
    if (this.deps.files && this.deps.memoryRepo) {
      try {
        await this.deps.files.restore(project, {
          projectRepo: this.deps.projectRepo, taskRepo: this.deps.taskRepo,
          agentRepo: this.deps.agentRepo, memoryRepo: this.deps.memoryRepo,
        }, { includeTasks: false });
        project = this.deps.projectRepo.findById(project.id)!.data;
      } catch (err) {
        logger.warn("preflight context restore failed, continuing without warm cache", { projectId: project.id, err: String(err) });
      }
    }
    active();

    // Resolve loop / routing settings with defaults.
    const maxFixLoops = project.settings.maxFixLoops ?? this.deps.maxFixLoops ?? 2;
    const researchBeforeFix = project.settings.researchBeforeFix !== false; // default ON
    const cacheCtx = project.settings.cacheContextInMemory !== false; // default ON

    // --- (F1 cont.) Build context pack (reads tree, configs, memory, and the
    // already-restored entity registry). With a real GitHub connection this
    // still lists files, but registry/configs/memory come from the local cache
    // when restore succeeded.
    let pack = await buildContextPack({ github, project, memoryRepo: this.deps.memoryRepo, strict: true });
    check();
    let brief = "";
    let breakdown: BreakdownItem[] = [];
    let usedRealAi = false;
    const researchTask = this.spawn(task, `Research: ${task.title}`, task.description, "research");
    const researchPlan: PreparePlan = async (ctx) => {
      if (ctx.chat) {
        usedRealAi = true;
        brief = await ctx.chat.chat(RESEARCH_INSTRUCTION, researchRequest(project!, task, renderPromptContext(pack, "(research)")), 2000);
        const raw = await ctx.chat.chat(PLANNING_INSTRUCTION, planningRequest(project!, task, brief, renderPromptContext(pack, "(planning)"), available.map((type) => this.needAgent(project!.id, type)), this.deps.skillsRegistry), 4000);
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
    // Validate every owner/skill before the first source write. Legacy plans
    // without the new fields get explicit, deterministic task contracts.
    breakdown = orderBreakdown(breakdown).map((item, index, ordered) => {
      const agent = this.needAgent(project!.id, item.agentType);
      assertWriter(agent);
      const criteria = item.acceptanceCriteria?.length ? item.acceptanceCriteria : [
        `Deliver the requested ${item.agentType} change: ${item.description || item.title}`,
        "Preserve existing behavior and shared interfaces; add or update relevant regression coverage.",
      ];
      const selection = this.deps.skillsRegistry.forTask(project!, agent, {
        title: item.title, description: item.description,
        input: { files: item.files, skills: item.skills, skillInstructions: item.skillInstructions },
      });
      return { ...item, dependsOn: item.dependsOn ?? (index ? [ordered[index - 1].id!] : []), acceptanceCriteria: criteria, skills: selection.skills };
    });
    this.updateParent(task, { input: { ...this.deps.taskRepo.findById(task.id)!.data.input, researchBrief: brief, breakdown } });

    const planned = new Map<string, Task>();
    for (const item of breakdown) {
      const child = this.spawn(task, item.title, this.implementationDescription(item, brief), item.agentType, {
        planItemId: item.id, researchBrief: brief, files: item.files,
        skills: item.skills, skillInstructions: item.skillInstructions,
        acceptanceCriteria: item.acceptanceCriteria,
      });
      planned.set(item.id!, child);
    }
    for (const item of breakdown) {
      const child = planned.get(item.id!)!;
      child.input.dependsOn = (item.dependsOn ?? []).map((id) => planned.get(id)!.id);
      this.deps.taskRepo.upsert(child, { projectId: task.projectId, parentId: task.id });
    }
    this.updateParent(task, { input: { ...this.deps.taskRepo.findById(task.id)!.data.input, breakdown: breakdown.map((item) => ({ ...item, taskId: planned.get(item.id!)!.id, assignedAgentId: planned.get(item.id!)!.assignedAgentId, repository: repositoryForAgent(project!, item.agentType).repo })) } });
    const buildTaskIds = [...planned.values()].map((child) => child.id);
    const qaTaskIds: string[] = [];
    const work = new Map<string, WorkingCopy>();
    const claims: Array<{ entity: string; path: string; agentType: string; subtaskId: string; at: string }> = [];
    const artifacts = () => [...work.values()].map(({ repo, branch, baseBranch, sha, files, pullRequest, pullRequestUrl }) => ({ repo, branch, baseBranch, sha, files, pullRequest, pullRequestUrl }));
    const saveArtifacts = () => this.updateParent(task, { result: { ...this.deps.taskRepo.findById(task.id)!.data.result, repositories: artifacts(), researchBrief: brief, usedRealAi } });
    const implement = async (item: BreakdownItem, fixContext?: string) => {
      check();
      const agent = this.needAgent(project!.id, item.agentType);
      const child = fixContext ? this.spawn(task, `Fix (attempt ${fixLoops}): ${item.title}`, this.implementationDescription(item, brief, fixContext), item.agentType, {
        planItemId: item.id, researchBrief: brief, files: item.files,
        skills: item.skills, skillInstructions: item.skillInstructions,
        acceptanceCriteria: item.acceptanceCriteria, fixContext,
        dependsOn: [qaTaskIds[qaTaskIds.length - 1]],
      }) : planned.get(item.id!)!;
      if (fixContext) buildTaskIds.push(child.id);
      // The coordinator dispatches only when all declared producers succeeded.
      if (!fixContext) for (const id of child.input.dependsOn as string[]) {
        if (this.deps.taskRepo.findById(id)?.data.status !== "succeeded") throw new Error(`Subtask ${child.id} is blocked by ${id}`);
      }
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
    // Explicit dependencies plus data-before-UI tie-breaking determine dispatch.
    // Same-repo agents share one task branch and receive previous deliverables.
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
      const qaTask = this.spawn(task, fixLoops ? `Re-verify (attempt ${fixLoops + 1}): ${task.title}` : `Verify: ${task.title}`, `${QA_DUTY}\n\nResearch brief:\n${brief}\n\nAcceptance criteria:\n${breakdown.flatMap((item) => item.acceptanceCriteria ?? []).map((c) => `- ${c}`).join("\n")}\n\nChanged files:\n${artifacts().map((r) => `${r.repo}@${r.branch}: ${r.files.join(", ")}`).join("\n")}`, "qa-test", {
        researchBrief: brief, acceptanceCriteria: breakdown.flatMap((item) => item.acceptanceCriteria ?? []),
        dependsOn: buildTaskIds, repositories: artifacts(),
      });
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
      if (fixLoops >= maxFixLoops) throw Object.assign(new Error(`QA still failing after ${fixLoops} fix loop(s): ${runError(qaRun)}`), { retryable: false });
      fixLoops += 1;
      const failure = runError(qaRun);

      // --- (F2) Research-before-fix loop:
      // When a fixable QA failure comes back, send the failure description
      // BACK through the research agent first so it can diagnose root cause
      // and re-target the right owner, rather than patching on the same
      // implementer that produced the bug.
      let fixTarget: BreakdownItem;
      let fixBrief = brief;
      if (researchBeforeFix && usedRealAi) {
        // Refresh context pack so research sees the latest failed run's outputs.
        pack = await buildContextPack({ github, project, memoryRepo: this.deps.memoryRepo, strict: false });
        const fixResearchTask = this.spawn(task, `Diagnose failure (attempt ${fixLoops}): ${task.title}`,
          `QA reported the following failure(s):\n\n${failure}\n\nRepositories/branches under test:\n${artifacts().map((r) => `- ${r.repo}@${r.branch} (${r.files.join(", ")})`).join("\n")}\n\nOriginal research brief:\n${brief}\n\nDiagnose which unit is responsible, what specifically must change, and provide a short revised plan. Reference concrete files/lines where possible.`,
          "research", { fixLoop: fixLoops, failure, dependsOn: [qaTask.id] });
        const diagRun = await this.phase(fixResearchTask, researchAgent, project, {
          taskBudget: budget, category: "research",
          preparePlan: async (ctx) => {
            if (ctx.chat) {
              usedRealAi = true;
              const diag = await ctx.chat.chat(
                "You are diagnosing a QA failure. Based on the failure description, the repository context, and the original research brief, identify which agent/unit must fix what. Reply with a short root-cause analysis and a concrete recommendation.",
                researchRequest(project!, task, renderPromptContext(pack, `(diagnosis loop ${fixLoops})`)) + `\n\n=== QA failure ===\n${failure}`,
                2500
              );
              fixBrief = `${brief}\n\n--- Fix-loop diagnosis (attempt ${fixLoops}) ---\n${diag}`;
              return defaultPlanFor(researchAgent, fixResearchTask);
            }
            return defaultPlanFor(researchAgent, fixResearchTask);
          }
        });
        this.requireSuccess(diagRun, "Diagnostic research");
        // Append the diagnostic note to project memory so subsequent runs see it.
        if (this.deps.memoryRepo) {
          const memId = `mem-${randomUUID().slice(0, 8)}`;
          this.deps.memoryRepo.upsert({
            id: memId, projectId: project.id, scope: "task",
            type: "bug", key: `qa-failure/${task.id}/attempt-${fixLoops}`,
            content: fixBrief, tags: ["qa", "fix-loop", task.id], refs: [qaTask.id],
            source: "orchestrator", version: 1,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }, { projectId: project.id });
        }
        // After diagnosis, re-route using the failure + diagnosis text.
        const routed = this.deps.agentRouter.route(`${failure}\n${fixBrief}`, "error");
        const normRouted = routed === "uiux" && available.includes("frontend-developer") ? "frontend-developer"
                         : IMPLEMENTERS.includes(routed as typeof IMPLEMENTERS[number]) ? routed
                         : undefined;
        const failedRepo = qaRun.steps.find((s) => s.status === "failed")?.data?.repo;
        const candidates = breakdown.filter((item) => !failedRepo || repositoryForAgent(project!, item.agentType).repo === failedRepo);
        fixTarget = candidates.find((i) => i.files.some((p) => failure.includes(p)))
                 ?? candidates.find((i) => normRouted && i.agentType === normRouted)
                 ?? candidates[0] ?? breakdown[0];
      } else {
        // Fallback / no real AI: deterministic routing (original behaviour).
        // Map non-implementer router hits (security/devops/...) to the closest
        // implementer so we don't try to spawn a fix task on a QA-only agent.
        const failedRepo = qaRun.steps.find((s) => s.status === "failed")?.data?.repo;
        const candidates = breakdown.filter((item) => !failedRepo || repositoryForAgent(project!, item.agentType).repo === failedRepo);
        const routed = this.deps.agentRouter.route(failure, "error");
        const fixType = routed === "uiux" && candidates.some((i) => i.agentType === "frontend-developer")
          ? "frontend-developer"
          : IMPLEMENTERS.includes(routed as typeof IMPLEMENTERS[number])
            ? routed
            : "backend-developer";
        fixTarget = candidates.find((i) => i.files.some((p) => failure.includes(p))) ?? candidates.find((i) => i.agentType === fixType) ?? candidates[0] ?? breakdown[0];
      }

      // Dispatch the fix using the (possibly revised) brief.
      await implement(fixTarget, `${failure}\n\n--- Diagnosis ---\n${fixBrief !== brief ? fixBrief.split("--- Fix-loop diagnosis")[1] ?? "" : "(deterministic routing)"}`);
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

  private implementationDescription(item: BreakdownItem, brief: string, fixContext?: string): string {
    return [
      IMPLEMENTER_DUTIES[item.agentType],
      `Research brief:\n${brief}`,
      `Subtask:\n${item.description}`,
      `Acceptance criteria:\n${(item.acceptanceCriteria ?? []).map((c) => `- ${c}`).join("\n")}`,
      `Assigned skills: ${(item.skills ?? []).join(", ") || "No compatible catalog skills; follow project rules."}`,
      fixContext ? `QA failures:\n${fixContext}` : "",
    ].filter(Boolean).join("\n\n");
  }

  private spawn(parent: Task, title: string, description: string, agentType: AgentType, input: Record<string, unknown> = {}): Task {
    assertTaskActive(this.deps.taskRepo, parent);
    const agent = this.needAgent(parent.projectId, agentType);
    const project = this.deps.projectRepo.findById(parent.projectId)!.data;
    const now = new Date().toISOString();
    const child: Task = { id: `task-${randomUUID().slice(0, 8)}`, projectId: parent.projectId, parentTaskId: parent.id, title: title.slice(0, 120), description, priority: parent.priority, status: "created", agentType, assignedAgentId: agent.id, correlationId: parent.correlationId, input: { ...input, autonomous: true, parentTaskId: parent.id }, createdAt: now, updatedAt: now };
    const selection = this.deps.skillsRegistry.forTask(project, agent, child);
    child.input.skills = selection.skills;
    child.input.skillAssignments = selection.assignments;
    this.deps.taskRepo.upsert(child, { projectId: parent.projectId, parentId: parent.id });
    live.emit({ type: "task.updated", taskId: child.id, projectId: parent.projectId, data: { status: "created", parentTaskId: parent.id, projectId: parent.projectId, assignedAgentId: agent.id, skills: selection.skills } });
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
      const latest = this.deps.taskRepo.findById(task.id)!.data;
      this.deps.taskRepo.upsert({ ...latest, assignedAgentId: agent.id, result: {
        ...latest.result, runId: run.id, summary: run.summary ?? latest.result?.summary,
        verification: run.verification ?? latest.result?.verification, skills: run.skills ?? latest.result?.skills,
      } }, { projectId: task.projectId, parentId: task.parentTaskId });
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
    live.emit({ type: "task.updated", taskId: task.id, projectId: task.projectId, data: { status: next.status, projectId: task.projectId } });
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
