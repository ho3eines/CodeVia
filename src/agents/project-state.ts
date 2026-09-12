import type { Agent, AgentType, MemoryEntry, Project, Skill, Task, Workflow } from "../domain/entities.js";
import type { GithubFile } from "../github/types.js";
import type { StateRepositories, ProjectFilesService, PullSummary } from "../github/project-files.js";
import {
  AGENTS_DIR,
  CONTEXT_FILE,
  MEMORY_FILE,
  PROJECT_FILE,
  SKILLS_FILE,
  parseMatter,
  renderAgentFile,
  renderMemoryFile,
  renderProjectFile,
  renderSkillsFile,
} from "../github/project-files.js";
import {
  isStatePath,
  localId,
  renderRulesFile,
  renderSkillFile,
  renderWorkflowFile,
  RULES_FILE,
  SKILL_DIR,
  slugSchema,
  statePath,
  WORKFLOW_DIR,
} from "../github/state-codec.js";
import { agentTypesForProject, hydrateProject, skillsForCapabilities } from "../domain/project-options.js";
import { AgentGenerator } from "./generator.js";
import { ProjectStateGenerator } from "./state-generator.js";
import { projectBrief } from "../domain/project-brief.js";
import type { IGitHubService } from "../github/types.js";
import { discoverProjectRules, rulesToStrings } from "./rules-discovery.js";
import { buildContextPack, renderPromptContext } from "./context.js";
import { BUILTIN_SKILLS } from "../skills/catalog.js";

export interface ProjectStateDeps extends StateRepositories {
  files: ProjectFilesService;
  generator: AgentGenerator;
  ai: ProjectStateGenerator;
  github: (project: Project) => IGitHubService;
  inspect: (project: Project) => Promise<Project>;
}

/** Managed agent definition layout: CodeVia/agents/<slug>.md only. */
function isAgentStatePath(path: string): boolean {
  return isStatePath(path) && path.startsWith(`${AGENTS_DIR}/`) && path.endsWith(".md");
}

export function workflowDrafts(project: Project, agents: Agent[]): Workflow[] {
  const enabled = new Set(agents.filter((a) => a.enabled).map((a) => a.type));
  const layouts: Array<[string, string, AgentType[]]> = [
    [
      "autonomous-development-loop",
      "Autonomous Development Loop",
      [
        "research",
        "business-analyst",
        "system-architect",
        "backend-developer",
        "frontend-developer",
        "uiux",
        "documentation",
        "qa-test",
        "security",
        "code-reviewer",
      ],
    ],
    [
      "bug-diagnosis-loop",
      "Bug Diagnosis Loop",
      ["debugging", "database", "backend-developer", "frontend-developer", "uiux", "qa-test", "code-reviewer"],
    ],
  ];
  return layouts.flatMap(([slug, name, types]) => {
    const nodes: Workflow["nodes"] = types
      .filter((t) => enabled.has(t))
      .map((type, i) => ({
        id: `${slug}-${i + 1}-${type}`,
        type: "agent",
        name: type,
        config: { agentType: type },
        retries: 1,
      }));
    if (!nodes.length) return [];
    nodes.push({
      id: `${slug}-approval`,
      type: "approval",
      name: "Human review",
      config: { message: "Review the result before any merge, deployment or migration." },
      retries: 0,
    });
    return [
      {
        id: localId(project.id, "workflow", slug),
        projectId: project.id,
        name,
        slug,
        description: "Specialist handoff, QA and human review.",
        nodes,
        edges: nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id })),
        enabled: true,
        version: 1,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    ];
  });
}

/** Read-first, create-only-if-missing. One bootstrap per project at a time. */
export class ProjectStateCoordinator {
  private pending = new Map<string, Promise<PullSummary>>();
  constructor(private deps: ProjectStateDeps) {}
  ensure(projectId: string): Promise<PullSummary> {
    const active = this.pending.get(projectId);
    if (active) return active;
    const work = this.loadOrCreate(projectId).finally(() => this.pending.delete(projectId));
    this.pending.set(projectId, work);
    return work;
  }
  private async loadOrCreate(projectId: string): Promise<PullSummary> {
    const d = this.deps;
    const stored = d.projectRepo.findById(projectId)?.data;
    if (!stored) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
    const snapshot = await d.files.pull(hydrateProject(stored));
    await d.files.restore(stored, d, { snapshot });
    let project = hydrateProject(d.projectRepo.findById(projectId)!.data);
    const first = !snapshot.manifest;
    const needsMigration = Boolean(snapshot.manifest && snapshot.manifest.schemaVersion !== 2);
    if (first) {
      project = await d.inspect(project);
      // Derive initial attachments only once. An intentionally empty saved list stays empty.
      if (!snapshot.skillsLoaded) {
        const selected = [
          ...new Set([
            ...project.settings.skills,
            ...skillsForCapabilities(project.capabilities),
            ...project.capabilities.languages,
            ...project.capabilities.frameworks,
            ...project.capabilities.databases,
          ]),
        ].filter((s) => slugSchema.safeParse(s).success);
        project = {
          ...project,
          settings: {
            ...project.settings,
            skills: selected,
            generatedSkills: selected.filter((s) => !stored.settings.skills.includes(s)),
          },
        };
      }
    }
    let existingAgents = d.agentRepo.byProject(projectId);
    // (R03/R04) Tombstones carry identity. Deletion must survive repository
    // copies — where IDs are re-bound to a new project — so recognize
    // tombstones by slug/type and by both the current and the copied-from
    // path, never only by the current file path.
    const tombstonedPaths = new Set<string>();
    const tombstonedWorkflowSlugs = new Set<string>();
    const agentTombstones: Array<{ slug?: string; type?: string }> = [];
    for (const [path, content] of snapshot.contents) {
      if (!path.endsWith(".md") || !(path.startsWith(`${AGENTS_DIR}/`) || path.startsWith(`${WORKFLOW_DIR}/`)))
        continue;
      const data = parseMatter(content).data as Record<string, unknown>;
      if (data.deleted !== true) continue;
      tombstonedPaths.add(path);
      if (path.startsWith(`${WORKFLOW_DIR}/`) && typeof data.slug === "string" && data.slug)
        tombstonedWorkflowSlugs.add(data.slug);
      if (path.startsWith(`${AGENTS_DIR}/`))
        agentTombstones.push({
          slug: typeof data.slug === "string" ? data.slug : undefined,
          type: typeof data.type === "string" ? data.type : undefined,
        });
    }
    const manifestProjectId = typeof snapshot.manifest?.id === "string" ? snapshot.manifest.id : undefined;
    // (R05/R06) Legacy installs keep definitions only in the database.
    // Migration must preserve them: author their files into CodeVia/ as part
    // of initialization, before anything is allowed to prune DB-only records.
    const legacyAgentFiles: GithubFile[] = [];
    const legacyWorkflows: Workflow[] = [];
    // (R05) Records upgraded from the pre-CodeVia layout still carry
    // `.ai-engineering/agents/*.yaml` config paths. Such a path lives outside
    // managed state: everything derived from it — prompt-history paths, agent
    // sync, the bootstrap commit itself — fails "agent definition path must be
    // inside CodeVia/agents/", and because bootstrap throws before restore can
    // prune, the record is never cleaned up either. Every queued run for the
    // project then dead-letters with the same error until someone intervenes.
    // Heal the record instead: re-point it at the canonical
    // CodeVia/agents/<type>.md path and author its full definition there in
    // the bootstrap commit, preserving identity, enabled state, limits and
    // prompt. When the repository already settles the identity — a live
    // definition from another record, or an intentional tombstone — the
    // repository wins and the stale duplicate record is deleted (the
    // documented alternative for a record that cannot be represented).
    const healedAgentIds = new Set<string>();
    if (existingAgents.some((a) => a.configPath !== undefined && !isAgentStatePath(a.configPath))) {
      const healedPaths = new Set<string>();
      const live: Agent[] = [];
      for (const stale of existingAgents) {
        if (stale.configPath === undefined || isAgentStatePath(stale.configPath)) {
          live.push(stale);
          continue;
        }
        let target: string;
        try {
          target = statePath(AGENTS_DIR, stale.type);
        } catch {
          d.agentRepo.deleteById(stale.id);
          continue;
        } // identity no layout can represent
        const slug = stale.slug ?? stale.type;
        const tombstoned =
          tombstonedPaths.has(target) ||
          agentTombstones.some((t) => t.slug === slug && (!t.type || t.type === stale.type));
        const targetFile = snapshot.contents.get(target);
        const targetData = targetFile
          ? (parseMatter(targetFile).data as Record<string, unknown> | undefined)
          : undefined;
        if (!tombstoned && !healedPaths.has(target) && (!targetData || targetData.id === stale.id)) {
          const healed = { ...stale, configPath: target };
          d.agentRepo.upsert(healed, { projectId });
          healedPaths.add(target);
          healedAgentIds.add(stale.id);
          live.push(healed);
          if (!targetData) legacyAgentFiles.push({ path: target, content: renderAgentFile(healed) });
        } else {
          d.agentRepo.deleteById(stale.id);
        }
      }
      existingAgents = live;
    }
    if (first || needsMigration) {
      for (const a of existingAgents) {
        if (healedAgentIds.has(a.id)) continue; // already authored at the canonical path
        const path = a.configPath ?? statePath(AGENTS_DIR, a.type);
        if (!snapshot.contents.has(path) && !tombstonedPaths.has(path))
          legacyAgentFiles.push({ path, content: renderAgentFile(a) });
      }
      for (const w of d.workflowRepo?.byProject(projectId) ?? []) {
        const path = statePath(WORKFLOW_DIR, w.id);
        if (!snapshot.contents.has(path) && !tombstonedPaths.has(path) && !legacyWorkflows.some((x) => x.id === w.id)) {
          legacyWorkflows.push(w);
        }
      }
    }
    const legacyAgentPaths = new Set(legacyAgentFiles.map((f) => f.path));
    // Defaults are used only to describe missing units, never to rewrite an existing one.
    const candidates = d.generator.generate(
      { ...project, repositoryState: undefined },
      { agentTypes: agentTypesForProject(project.capabilities), persist: false, preserveExisting: true },
    );
    const missingAgents = candidates.filter((a) => {
      const path = a.configPath ?? statePath(AGENTS_DIR, a.type);
      if (existingAgents.some((e) => e.id === a.id) || snapshot.contents.has(path) || legacyAgentPaths.has(path))
        return false;
      if (tombstonedPaths.has(path)) return false;
      const slug = a.slug ?? a.type;
      return !agentTombstones.some((t) => t.slug === slug && (!t.type || t.type === a.type));
    });
    const agents = [...existingAgents, ...missingAgents];
    const templates = new Map(
      [...(d.skillRepo?.globalCatalog() ?? BUILTIN_SKILLS), ...snapshot.skillDefinitions].map((s) => [s.slug, s]),
    );
    const skillDrafts = new Map<string, Skill>();
    const visited = new Set<string>();
    const visit = (slug: string) => {
      slugSchema.parse(slug);
      if (visited.has(slug)) return;
      visited.add(slug);
      const known = templates.get(slug);
      const path = statePath(SKILL_DIR, slug);
      if (!snapshot.contents.has(path)) {
        const prototype: Skill = known
          ? structuredClone(known)
          : {
              id: "",
              slug,
              name: slug,
              description: `Project-specific ${slug} knowledge`,
              instructions: "",
              category: "project",
              version: "1.0.0",
              tools: [],
              dependencies: [],
              compatibleAgentTypes: ["*"],
              metadata: {},
              enabled: true,
              builtIn: false,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
            };
        skillDrafts.set(slug, { ...prototype, id: localId(projectId, "skill", slug), projectId });
      }
      // Disabled/tombstoned definitions must not trigger work on their behalf.
      if (
        known?.enabled === false ||
        (snapshot.contents.has(path) && !snapshot.skillDefinitions.some((s) => s.slug === slug))
      )
        return;
      for (const dep of known?.dependencies ?? []) visit(dep);
    };
    for (const slug of [
      ...project.settings.skills,
      ...agents.flatMap((a) => a.skills),
      ...project.capabilities.languages,
      ...project.capabilities.frameworks,
      ...project.capabilities.databases,
    ].filter((s) => slugSchema.safeParse(s).success))
      visit(slug);
    // A newly discovered enabled skill must be usable even before explicit attachment.
    for (const skill of snapshot.skillDefinitions) if (skill.enabled) visit(skill.slug);
    const missingPromptHistory = d.files.missingPromptHistoryFiles(project, agents, snapshot).length > 0;
    const existingWorkflows = [...snapshot.workflows, ...legacyWorkflows];
    const missingWorkflows = workflowDrafts(project, agents).filter((w) => {
      if (existingWorkflows.some((e) => e.slug === w.slug)) return false;
      if (snapshot.contents.has(statePath(WORKFLOW_DIR, w.id)) || tombstonedPaths.has(statePath(WORKFLOW_DIR, w.id)))
        return false;
      if (tombstonedWorkflowSlugs.has(w.slug)) return false;
      // A copied repository keeps the source project's tombstone filename;
      // drafts derive their path from the source project's deterministic ID.
      if (
        manifestProjectId &&
        manifestProjectId !== project.id &&
        tombstonedPaths.has(statePath(WORKFLOW_DIR, localId(manifestProjectId, "workflow", w.slug)))
      )
        return false;
      return true;
    });
    const missingRules = !snapshot.contents.has(RULES_FILE);
    const missingMemory = !snapshot.contents.has(MEMORY_FILE);
    const missingContext = !snapshot.contents.has(CONTEXT_FILE);
    if (
      !first &&
      !needsMigration &&
      !missingAgents.length &&
      !skillDrafts.size &&
      !missingWorkflows.length &&
      !missingRules &&
      !missingMemory &&
      !missingContext &&
      snapshot.skillsLoaded &&
      !missingPromptHistory &&
      !legacyAgentFiles.length
    ) {
      return {
        agents: agents.length,
        tasks: snapshot.tasks.length,
        memory: snapshot.memory.length,
        skills: project.settings.skills,
        files: snapshot.files,
        sha: snapshot.sha,
        workflows: existingWorkflows.length,
      };
    }
    const github = d.github(project);
    let rules = project.settings.rules;
    if (missingRules && !rules.length)
      rules = rulesToStrings(
        await discoverProjectRules(
          github,
          project,
          (
            await github.listFiles(
              { owner: project.configRepo.split("/")[0], name: project.configRepo.split("/")[1] },
              snapshot.sha,
            )
          ).map((f) => f.path),
        ),
      ).map((rule) => `<!-- discovered -->\n${rule}`);
    const legacyMemory: MemoryEntry[] = [];
    if (missingMemory) {
      const [owner, name] = project.configRepo.split("/");
      const tree = await github.listFiles({ owner, name }, snapshot.sha);
      if (tree.length >= 8000) throw new Error("Legacy import tree is incomplete; initialization stopped");
      for (const entry of tree.filter(
        (e) =>
          e.type === "blob" &&
          /^\.ai-engineering\/memory\/(architecture|business|technical|decision|bug|knowledge|lesson|conversation)\/.+\.md$/.test(
            e.path,
          ),
      )) {
        const file = await github.getFile({ owner, name }, entry.path, snapshot.sha);
        if (!file) throw new Error(`Legacy memory ${entry.path} is unreadable`);
        const parts = entry.path.split("/");
        const type = parts[2] as MemoryEntry["type"];
        const key = parts.slice(3).join("/").replace(/\.md$/, "");
        legacyMemory.push({
          id: localId(projectId, "memory", `${type}\0${key}`),
          projectId,
          type,
          key,
          content: file.content,
          tags: ["legacy-import"],
          refs: [],
          scope: "project",
          source: entry.path,
          version: 1,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        });
      }
    }
    const bootstrap: Agent = existingAgents.find((a) => a.type === "research") ?? {
      id: localId(project.id, "agent", "bootstrap"),
      projectId,
      type: "research",
      name: "Project state designer",
      slug: "bootstrap",
      role: "research",
      description: "Author missing state",
      systemPrompt: d.generator.promptFor("research", project),
      skills: [],
      tools: [],
      permissions: [],
      models: d.generator.modelsFor(project.defaultModelId, "research"),
      maxIterations: 20,
      timeoutMs: 120000,
      tokenBudget: project.settings.budget.maxTokensPerRun,
      memorySources: [],
      enabled: true,
      version: 1,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    const author = {
      ...bootstrap,
      models: project.defaultModelId
        ? { primary: project.defaultModelId, fallbacks: [], specialized: {} }
        : bootstrap.models,
    };
    const needsAiText =
      missingAgents.length || skillDrafts.size || missingWorkflows.length || missingRules || missingContext;
    const evidence = needsAiText
      ? await buildContextPack({
          github,
          project: { ...project, branch: snapshot.sha },
          memoryRepo: d.memoryRepo,
          strict: true,
        })
      : undefined;
    const input = {
      agents: missingAgents,
      skills: [...skillDrafts.values()],
      workflows: missingWorkflows,
      rules: missingRules ? rules : undefined,
      overview: missingContext ? "" : undefined,
    };
    const generated = needsAiText
      ? await d.ai.generate(
          project,
          input,
          author,
          [...snapshot.contents]
            .filter(([path]) => [PROJECT_FILE, CONTEXT_FILE, RULES_FILE].includes(path))
            .map(([path, text]) => `${path}:\n${text}`)
            .join("\n\n") || renderPromptContext(evidence!, "README.md"),
          github.kind === "mock",
        )
      : { draft: input, generation: project.repositoryState?.generation ?? ("imported" as const), modelId: undefined };
    const draft = generated.draft;
    const workflows = [...existingWorkflows, ...draft.workflows];
    project = {
      ...project,
      repositoryState: project.repositoryState ?? {
        version: 2,
        generation: generated.generation,
        initializedAt: new Date().toISOString(),
        modelId: generated.modelId,
      },
      settings: {
        ...project.settings,
        rules: draft.rules ?? project.settings.rules,
        workflows: [...new Set([...project.settings.workflows, ...workflows.map((w) => w.id)])],
      },
    };
    const memory = [...legacyMemory];
    if (missingMemory && generated.generation === "ai" && draft.overview)
      memory.push({
        id: localId(projectId, "memory", "knowledge\0project/overview"),
        projectId,
        scope: "project",
        type: "knowledge",
        key: "project/overview",
        content: draft.overview,
        tags: ["initialization"],
        refs: [],
        source: "ai:initialization (not completed-work history)",
        version: 1,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });
    const allSkills = [...snapshot.skillDefinitions, ...draft.skills];
    const files = [
      { path: PROJECT_FILE, content: renderProjectFile(project, agents, snapshot.tasks as Task[], memory) },
      { path: SKILLS_FILE, content: renderSkillsFile(project, allSkills) },
      { path: RULES_FILE, content: renderRulesFile(project.settings.rules) },
      { path: MEMORY_FILE, content: renderMemoryFile(memory) },
      {
        path: CONTEXT_FILE,
        content: `# Project context\n\n${draft.overview || projectBrief(project)}\n\nInitialization: ${generated.generation}. No completed implementation is implied.\n`,
      },
      ...draft.agents.map((a) => ({
        path: a.configPath ?? statePath(AGENTS_DIR, a.type),
        content: renderAgentFile(a),
      })),
      ...draft.skills.map((s) => ({ path: statePath(SKILL_DIR, s.slug), content: renderSkillFile(s) })),
      ...draft.workflows.map((w) => ({ path: statePath(WORKFLOW_DIR, w.id), content: renderWorkflowFile(w) })),
      ...legacyAgentFiles,
      ...legacyWorkflows.map((w) => ({ path: statePath(WORKFLOW_DIR, w.id), content: renderWorkflowFile(w) })),
      ...d.files.missingPromptHistoryFiles(project, agents, snapshot),
    ];
    // Validate all model-authored output before this atomic missing-files commit.
    await d.files.ensureFiles(project, files, snapshot.sha);
    if (needsMigration)
      await d.files.writeFiles(
        project,
        [{ path: PROJECT_FILE, content: renderProjectFile(project, agents, snapshot.tasks as Task[], memory) }],
        "[CodeVia] migrate legacy manifest to schema 2",
      );
    return d.files.restore(project, d);
  }
}
