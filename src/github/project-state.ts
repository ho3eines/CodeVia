import { z } from "zod";
import type { Agent, Conversation, MemoryEntry, Project, Run, Skill, Task, Workflow } from "../domain/entities.js";
import type { AgentRepository } from "../agents/agent-repo.js";
import type { ConversationRepository, MemoryRepository, ProjectRepository, TaskRepository, WorkflowRepository } from "../domain/repos.js";
import type { RunRepository } from "../observability/repos.js";
import type { SkillRepository } from "../skills/registry.js";
import type { GithubFile, GithubRepoRef, IGitHubService } from "./types.js";
import { isAgentType } from "../agents/generator.js";
import { hydrateProject, normalizeCapabilities, normalizeRepositories } from "../domain/project-options.js";
import { matter, parseMatter } from "./markdown.js";
import { AGENTS_DIR, CODEVIA_DIR, CONTEXT_FILE, RUNTIME_CONTEXT_FILE, MEMORY_FILE, PROJECT_FILE, SKILLS_FILE, TASKS_DIR, parseAgentFile, parseMemoryFile, parseTaskFile, renderAgentFile, renderMemoryFile, renderProjectFile, renderSkillsFile, renderTaskFile, type ParsedAgent, type ParsedMemoryEntry, type ParsedTask } from "./project-codec.js";
import { assertNoCredentialMaterial, assertVersion, CONVERSATION_DIR, isStatePath, localId, parseHistoryFile, parseRulesFile, parseSkillFile, parseWorkflowFile, renderConversationFile, renderRulesFile, renderRunFile, renderSkillFile, renderWorkflowFile, RULES_FILE, RUN_DIR, SKILL_DIR, skillSchema, memorySchema, slugSchema, statePath, WORKFLOW_DIR } from "./state-codec.js";

import type { PromptVersion, PromptVersionRepository } from "../prompts/versions.js";
import { PROMPT_HISTORY_DIR, PROMPT_HISTORY_INDEX, parsePromptHistory, parsePromptHistoryIndex, renderPromptHistory, renderPromptHistoryIndex, type PromptHistory } from "./prompt-history.js";

interface StateWrite extends GithubFile { sourceSha?: string; runtime?: boolean; }

export interface StateRepositories {
  projectRepo: ProjectRepository; agentRepo: AgentRepository; taskRepo: TaskRepository; memoryRepo: MemoryRepository;
  promptVersionRepo?: PromptVersionRepository;
  skillRepo?: SkillRepository; workflowRepo?: WorkflowRepository; runRepo?: RunRepository; conversationRepo?: ConversationRepository;
}
export interface ProjectFilesDeps {
  github: IGitHubService;
  githubForProject?: (project: Project) => IGitHubService;
  repositories?: StateRepositories;
  transaction?: <T>(fn: () => T) => T;
}
export interface PullSummary { promptVersions?: number; agents: number; tasks: number; memory: number; skills: string[]; files: string[]; workflows?: number; runs?: number; conversations?: number; sha?: string; }
export interface RepositorySnapshot {
  sha: string; contents: Map<string, string>; files: string[];
  manifest?: Record<string, unknown>; agents: ParsedAgent[]; tasks: ParsedTask[]; memory: ParsedMemoryEntry[];
  skills: string[]; skillsLoaded: boolean; skillDefinitions: Skill[]; rules?: string[];
  workflows: Workflow[]; runs: Run[]; conversations: Conversation[];
  promptHistories: PromptHistory[]; promptHistoryInitialized: boolean;
}
const stringList = z.array(z.string()).max(1024);
const definitionSchema = z.object({
  name: z.string(), description: z.string(), capabilities: z.object({ platforms: stringList.default([]), languages: stringList.default([]), frameworks: stringList.default([]), databases: stringList.default([]), deploymentTargets: stringList.default([]), features: stringList.default([]), integrations: stringList.default([]), agentTypes: stringList.default([]) }), repositories: z.array(z.object({ repo: z.string(), branch: z.string(), role: z.string() }).passthrough()).min(1),
  defaultModelId: z.string().nullable().optional(), defaultAgentId: z.string().nullable().optional(), telegramChatId: z.string().nullable().optional(), active: z.boolean(),
  repositoryState: z.object({ version: z.literal(2), generation: z.enum(["ai", "simulation", "imported"]), initializedAt: z.string(), modelId: z.string().optional() }).optional(),
  settings: z.object({ environment: z.enum(["development", "staging", "production"]), notifications: stringList, rules: stringList, skills: stringList, generatedSkills: stringList.optional(), workflows: stringList,
    budget: z.object({ maxTokensPerRun: z.number().finite().nonnegative(), maxCallsPerRun: z.number().finite().nonnegative(), maxCostUsdPerRun: z.number().finite().nonnegative(), maxDurationMs: z.number().finite().nonnegative() }),
    permissions: z.record(z.boolean()), metadata: z.record(z.unknown()),
    // Orchestrator-loop options (added 2026-09) — optional so legacy project
    // files without these keys keep loading. .passthrough() also lets unknown
    // future fields round-trip without breaking parse.
    maxFixLoops: z.number().int().nonnegative().max(10).optional(),
    researchBeforeFix: z.boolean().optional(),
    cacheContextInMemory: z.boolean().optional(),
  }).passthrough(),
}).passthrough();
const stateError = (message: string, cause?: unknown) => Object.assign(new Error(`CodeVia repository state: ${message}${cause ? ` (${String(cause)})` : ""}`), { statusCode: 502, retryable: false });
const conflict = (path: string) => Object.assign(new Error(`CodeVia conflict at ${path}; the repository changed since it was read. Refresh and retry; no files were overwritten.`), { statusCode: 409, retryable: false });

/**
 * Canonical repository store. Reads are pinned to HEAD; complete validation
 * precedes cache replacement. Failed reads are NEVER treated as missing files.
 * Writes are serialized per repository and compare-and-swap the Git commit.
 */
export class ProjectFilesService {
  private locks = new Map<string, Promise<unknown>>();
  private decoded = new Map<string, { sha: string; state: RepositorySnapshot }>();
  private revisions = new Map<string, Map<string, Map<string, string>>>();
  private entityPaths = new Map<string, Map<string, string>>();
  private baselines = new Map<string, Map<string, string>>();
  private snapshots = new Map<string, { sha: string; contents: Map<string, string> }>();
  constructor(private readonly deps: ProjectFilesDeps) {}
  private key(p: Project): string { return `${p.configRepo}@${p.branch}`; }
  private cacheKey(p: Project): string { return `${p.id}:${this.key(p)}`; }
  private github(p: Project): IGitHubService { return this.deps.githubForProject?.(p) ?? this.deps.github; }
  private ref(p: Project): GithubRepoRef { const [owner, name] = p.configRepo.split("/"); if (!owner || !name) throw stateError("a connected repository is required"); return { owner, name }; }
  private async locked<T>(p: Project, fn: () => Promise<T>): Promise<T> {
    const key = this.key(p); const prev = this.locks.get(key) ?? Promise.resolve();
    const pending = prev.catch(() => undefined).then(fn); this.locks.set(key, pending);
    try { return await pending; } finally { if (this.locks.get(key) === pending) this.locks.delete(key); }
  }
  private async head(p: Project): Promise<string> {
    const branch = (await this.github(p).listBranches(this.ref(p))).find((b) => b.name === p.branch);
    if (!branch?.sha) throw stateError(`branch ${p.branch} is unavailable; not creating replacement state`);
    return branch.sha;
  }
  private remember(p: Project, sha: string, contents: Map<string, string>): void {
    const history = this.revisions.get(this.cacheKey(p)) ?? new Map<string, Map<string, string>>();
    history.set(sha, new Map(contents));
    while (history.size > 32) history.delete(history.keys().next().value!);
    this.revisions.set(this.cacheKey(p), history);
  }
  /**
   * Purge a deleted project's CodeVia/* state from the repository so a later
   * project reusing the same repo starts clean instead of resurrecting the
   * deleted project's name/description/units. Best-effort: the project row is
   * already gone, so repo cleanup must never fail the delete request.
   */
  async removeProject(p: Project): Promise<void> {
    this.snapshots.delete(this.cacheKey(p));
    this.decoded.delete(this.cacheKey(p));
    this.revisions.delete(this.cacheKey(p));
    this.baselines.delete(this.cacheKey(p));
    this.entityPaths.delete(this.cacheKey(p));
    try {
      const gh = this.github(p);
      if (!gh.deleteFiles) return;
      const sha = await this.head(p);
      let tree;
      try { tree = await gh.listFiles(this.ref(p), sha, CODEVIA_DIR); }
      catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        tree = await gh.listFiles(this.ref(p), sha);
      }
      const paths = tree.filter((e) => e.type === "blob" && e.path.startsWith(`${CODEVIA_DIR}/`)).map((e) => e.path);
      if (paths.length) await gh.deleteFiles(this.ref(p), p.branch, `[CodeVia] remove project state (${p.id})`, paths, sha);
    } catch (error) {
      // Project deletion already succeeded in the DB; repository cleanup is best-effort.
      this.snapshots.delete(this.cacheKey(p));
      this.decoded.delete(this.cacheKey(p));
    }
  }

  isTombstoned(p: Project, path: string): boolean {
    const raw = this.baselines.get(this.cacheKey(p))?.get(path);
    return raw !== undefined && parseMatter(raw).data.deleted === true;
  }
  /**
   * Simulation mode is a self-contained universe: a project that was imported,
   * backed up, or configured for a repo the mock has not seen must not become a
   * read-only trap. Create the missing simulated repository so reads and the
   * project actions keep working, then the normal state sync/initialization can
   * rebuild CodeVia/* from the current database.
   */
  private async seedMissingMockRepos(p: Project): Promise<boolean> {
    const gh = this.github(p);
    if (gh.kind !== "mock") return false;
    const links = p.repositories.length ? p.repositories : [{ repo: p.configRepo, branch: p.branch }];
    const mock = gh as unknown as { seedRepo(owner: string, name: string, opts?: { files?: GithubFile[]; branch?: string; description?: string }): unknown };
    const existing = new Set((await gh.listRepositories({ limit: 1000 })).map((r) => r.fullName.toLowerCase()));
    let seeded = false;
    for (const link of links) {
      const [owner, ...rest] = String(link.repo).split("/");
      const name = rest.join("/") || "repo";
      if (!owner || !name) continue;
      if (existing.has(`${owner}/${name}`.toLowerCase())) continue;
      // Minimal, safe initial commit. The higher-level coordinator writes the real
      // CodeVia/* definitions after this read; all writes below are confirmed first.
      mock.seedRepo(owner, name, { files: [{ path: "README.md", content: `# ${p.name}\n\n${p.description}\n` }], branch: link.branch, description: p.description });
      seeded = true;
    }
    return seeded;
  }
  private async raw(p: Project): Promise<{ sha: string; contents: Map<string, string> }> {
    await this.seedMissingMockRepos(p);
    const sha = await this.head(p);
    const cached = this.snapshots.get(this.cacheKey(p));
    // HEAD is checked on EVERY read. Only immutable contents for that SHA are cached.
    if (cached?.sha === sha) return { sha, contents: new Map(cached.contents) };
    const gh = this.github(p), ref = this.ref(p);
    let tree;
    try { tree = await gh.listFiles(ref, sha, CODEVIA_DIR); }
    catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      // A directory 404 is absence only if the same repository/ref root is readable.
      tree = await gh.listFiles(ref, sha);
    }
    if (tree.length >= 8000) throw stateError("tree limit reached; refusing an incomplete snapshot");
    const paths = tree.filter((e) => e.type === "blob" && e.path.startsWith(`${CODEVIA_DIR}/`)).map((e) => e.path);
    if (new Set(paths).size !== paths.length || paths.some((path) => !isStatePath(path))) throw stateError("invalid/duplicate file path");
    const contents = new Map<string, string>();
    for (let offset = 0; offset < paths.length; offset += 8) {
      const batch = await Promise.all(paths.slice(offset, offset + 8).map(async (path) => {
        const file = await gh.getFile(ref, path, sha);
        if (!file) throw stateError(`listed file ${path} could not be read`);
        if (Buffer.byteLength(file.content) > 8_000_000) throw stateError(`file ${path} exceeds the state size limit`);
        return [path, file.content] as const;
      }));
      for (const [path, content] of batch) contents.set(path, content);
    }
    if ([...contents.values()].reduce((size, text) => size + Buffer.byteLength(text), 0) > 32_000_000) throw stateError("total project state exceeds the 32 MB limit");
    this.remember(p, sha, contents);
    this.snapshots.set(this.cacheKey(p), { sha, contents: new Map(contents) });
    return { sha, contents };
  }

  private decode(raw: { sha: string; contents: Map<string, string> }): RepositorySnapshot {
    const out: RepositorySnapshot = { ...raw, files: [...raw.contents.keys()], agents: [], tasks: [], memory: [], skills: [], skillsLoaded: false, skillDefinitions: [], workflows: [], runs: [], conversations: [], promptHistories: [], promptHistoryInitialized: false };
    for (const [path, content] of raw.contents) {
      const managed = [PROJECT_FILE, SKILLS_FILE, MEMORY_FILE, RULES_FILE, PROMPT_HISTORY_INDEX].includes(path) || [SKILL_DIR, AGENTS_DIR, WORKFLOW_DIR, TASKS_DIR, RUN_DIR, CONVERSATION_DIR, PROMPT_HISTORY_DIR].some((dir) => path.startsWith(`${dir}/`) && path.endsWith(".md"));
      if (!managed || /(?:^|\/)README\.md$/i.test(path)) continue;
      const { data } = parseMatter(content);
      if (data.deleted === true && [PROJECT_FILE, SKILLS_FILE, MEMORY_FILE, RULES_FILE, PROMPT_HISTORY_INDEX].includes(path)) throw stateError("core files cannot be tombstoned; save an empty list instead");
      if (data.deleted === true) continue; // intentional tombstone, not a missing file
      if (path === PROJECT_FILE) {
        assertVersion(data);
        if (!data.id || !data.slug) throw stateError(`invalid manifest ${path}`);
        if (data.schemaVersion === 2 || data.definition !== undefined) definitionSchema.parse(data.definition);
        out.manifest = data;
      } else if (path === PROMPT_HISTORY_INDEX) {
        parsePromptHistoryIndex(content); out.promptHistoryInitialized = true;
      } else if (path.startsWith(`${PROMPT_HISTORY_DIR}/`) && path.endsWith(".md")) {
        out.promptHistories.push(parsePromptHistory(content));
      } else if (path === SKILLS_FILE) {
        assertVersion(data); out.skills = z.array(slugSchema).parse(data.skills); out.skillsLoaded = true;
      } else if (path === MEMORY_FILE) out.memory = parseMemoryFile(content);
      else if (path === RULES_FILE) out.rules = parseRulesFile(content);
      else if (path.startsWith(`${SKILL_DIR}/`) && path.endsWith(".md")) {
        const s = parseSkillFile(content);
        if (path !== statePath(SKILL_DIR, s.slug)) throw stateError(`skill slug/path mismatch: ${path}`);
        out.skillDefinitions.push(s);
      } else if (path.startsWith(`${AGENTS_DIR}/`) && path.endsWith(".md")) {
        assertVersion(data);
        z.object({ id: z.string().min(1), type: z.string().min(1), enabled: z.boolean().optional(), skills: stringList.optional(), tools: stringList.optional(), permissions: stringList.optional(), systemPrompt: z.string().optional() }).parse(data);
        const a = parseAgentFile(content);
        if (!a || !isAgentType(a.type)) throw stateError(`invalid agent ${path}`);
        z.object({ skills: stringList, tools: stringList, permissions: stringList, systemPrompt: z.string(), models: z.object({ primary: z.string(), secondary: z.string().optional(), fallbacks: stringList, specialized: z.record(z.string()) }), enabled: z.boolean(), maxIterations: z.number().finite().nonnegative(), timeoutMs: z.number().finite().nonnegative(), tokenBudget: z.number().finite().nonnegative() }).parse(a);
        a.configPath = path; out.agents.push(a);
      } else if (path.startsWith(`${WORKFLOW_DIR}/`) && path.endsWith(".md")) out.workflows.push(parseWorkflowFile(content));
      else if (path.startsWith(`${TASKS_DIR}/`) && path.endsWith(".md")) {
        assertVersion(data); const t = parseTaskFile(content); if (!t) throw stateError(`invalid task ${path}`);
        z.enum(["created", "queued", "running", "succeeded", "failed", "cancelled", "waiting_for_approval"]).parse(t.status);
        out.tasks.push(t);
      } else if (path.startsWith(`${RUN_DIR}/`) && path.endsWith(".md")) out.runs.push(parseHistoryFile<Run>(content, "run"));
      else if (path.startsWith(`${CONVERSATION_DIR}/`) && path.endsWith(".md")) out.conversations.push(parseHistoryFile<Conversation>(content, "conversation"));
    }
    for (const [name, values] of [["agent", out.agents], ["workflow", out.workflows], ["task", out.tasks], ["run", out.runs], ["conversation", out.conversations]] as const) {
      if (new Set(values.map((v) => v.id)).size !== values.length) throw stateError(`duplicate ${name} identity`);
    }
    if (new Set(out.promptHistories.map((h) => h.agentId)).size !== out.promptHistories.length) throw stateError("duplicate prompt history for an agent");
    const versionIds = out.promptHistories.flatMap((h) => h.versions.map((v) => v.id));
    if (new Set(versionIds).size !== versionIds.length) throw stateError("duplicate prompt version identity");
    if (new Set(out.skillDefinitions.map((s) => s.slug)).size !== out.skillDefinitions.length) throw stateError("duplicate skill slug");
    const skills = new Map(out.skillDefinitions.map((s) => [s.slug, s]));
    const visiting = new Set<string>(), checked = new Set<string>();
    const checkDependencies = (slug: string) => {
      if (visiting.has(slug)) throw stateError(`circular skill dependency: ${slug}`);
      if (checked.has(slug)) return;
      visiting.add(slug);
      for (const dep of skills.get(slug)?.dependencies ?? []) if (skills.has(dep)) checkDependencies(dep);
      visiting.delete(slug); checked.add(slug);
    };
    for (const slug of skills.keys()) checkDependencies(slug);
    if (new Set(out.memory.map((m) => `${m.type}\0${m.key}`)).size !== out.memory.length) throw stateError("duplicate memory key/type");
    return out;
  }

  async pull(project: Project): Promise<RepositorySnapshot> {
    return this.locked(project, async () => {
      try {
        const raw = await this.raw(project);
        const cached = this.decoded.get(this.cacheKey(project));
        const out = cached?.sha === raw.sha ? structuredClone(cached.state) : this.decode(raw);
        if (cached?.sha !== raw.sha) this.decoded.set(this.cacheKey(project), { sha: raw.sha, state: structuredClone(out) });
        this.baselines.set(this.cacheKey(project), new Map(raw.contents));
        return out;
      } catch (err) { throw stateError("read/validation failed; cached definitions were not substituted", err); }
    });
  }

  /** Only genuine absence may be initialized. A concurrent edit always wins. */
  async ensureFiles(project: Project, files: GithubFile[], expectedSha?: string): Promise<boolean> {
    return this.locked(project, async () => {
      const current = await this.raw(project);
      const missing = files.filter((f) => !current.contents.has(f.path));
      if (!missing.length) return true;
      // AI generation used a particular snapshot. Never commit its assumptions over changed state.
      if (expectedSha && expectedSha !== current.sha) throw conflict("bootstrap snapshot");
      await this.commit(project, current, missing, "[CodeVia] initialize missing project state");
      return true;
    });
  }
  private async commit(p: Project, current: { sha: string; contents: Map<string, string> }, files: GithubFile[], message: string): Promise<void> {
    if (files.some((f) => !isStatePath(f.path))) throw stateError("writes must stay inside CodeVia/");
    if (new Set(files.map((f) => f.path)).size !== files.length) throw stateError("duplicate write target");
    const changed = files.filter((f) => current.contents.get(f.path) !== f.content);
    if (!changed.length) return;
    const staged = new Map(current.contents);
    for (const file of changed) {
      assertNoCredentialMaterial(file.content);
      if (Buffer.byteLength(file.content) > 8_000_000) throw stateError(`file ${file.path} exceeds the state size limit`);
      staged.set(file.path, file.content);
    }
    if ([...staged.values()].reduce((size, text) => size + Buffer.byteLength(text), 0) > 32_000_000) throw stateError("total project state exceeds the 32 MB limit");
    let decoded: RepositorySnapshot;
    try { decoded = this.decode({ sha: current.sha, contents: staged }); }
    catch (error) { throw Object.assign(new Error(`Invalid CodeVia definition; no files were written (${String(error)})`), { statusCode: 422, retryable: false }); }
    try {
      const committed = await this.github(p).commit(this.ref(p), p.branch, message, changed.map(({ path, content }) => ({ path, content })), current.sha);
      const contents = new Map(current.contents); for (const f of changed) contents.set(f.path, f.content);
      this.decoded.set(this.cacheKey(p), { sha: committed.sha, state: { ...decoded, sha: committed.sha, contents: new Map(contents) } });
      this.remember(p, committed.sha, contents);
      this.snapshots.set(this.cacheKey(p), { sha: committed.sha, contents });
      // Do not advance untouched file baselines: an external edit still needs a fresh read.
      const basis = this.baselines.get(this.cacheKey(p)) ?? new Map<string, string>();
      for (const f of changed) basis.set(f.path, f.content);
      this.baselines.set(this.cacheKey(p), basis);
    } catch (error) {
      this.snapshots.delete(this.cacheKey(p));
      if ((error as { status?: number })?.status === 404) {
        // GitHub returns 404 for repos that don't exist AND for repos the
        // acting token cannot access (to avoid leaking repo existence). When a
        // repo "exists and you have access", this means the credential that is
        // actually writing differs from the one with access — so say so clearly.
        // Identify the *acting* identity (login + granted scopes) so the user
        // can see at a glance which account/token failed instead of guessing.
        let actor = "";
        try {
          const gh = this.github(p);
          const viewer = await gh.getViewer();
          const scopes = viewer.scopes?.length ? viewer.scopes.join(", ") : "none (fine-grained/installation token)";
          actor = ` — the write was attempted as @${viewer.login || "?"} (scopes: ${scopes})`;
        } catch { /* diagnostic only; never mask the original 404 */ }
        throw stateError(
          `commit failed: GitHub returned 404 (Not Found) for ${this.ref(p).owner}/${this.ref(p).name}. This usually means the repository does not exist under the connected account, or the token/connection performing the write cannot access it. Re-check the project's connected repository and re-link your GitHub account${actor}; state was not acknowledged as saved`,
          error,
        );
      }
      throw stateError("commit failed; state was not acknowledged as saved", error);
    }
  }
  async writeFiles(p: Project, files: StateWrite[], message: string, checkConflicts = true): Promise<boolean> {
    const fallback = this.baselines.has(this.cacheKey(p)) ? new Map(this.baselines.get(this.cacheKey(p))) : undefined;
    const result = await this.locked(p, async () => {
      const current = await this.raw(p);
      if (checkConflicts) for (const file of files) {
        if (file.runtime || current.contents.get(file.path) === file.content) continue;
        const sourceSha = file.sourceSha ?? p.repositoryRevision;
        const basis = sourceSha ? this.revisions.get(this.cacheKey(p))?.get(sourceSha) : fallback;
        if (sourceSha && !basis) throw conflict(file.path);
        if (basis && basis.get(file.path) !== current.contents.get(file.path)) throw conflict(file.path);
      }
      await this.commit(p, current, files, message); return true;
    });
    // User writes are indexed only after Git accepted them. Reading again also
    // advances each entity's own stamp; concurrent readers cannot mask conflicts.
    if (checkConflicts && this.deps.repositories) await this.restore(p);
    return result;
  }

  private entityPath(p: Project, kind: string, dir: string, id: string): string {
    return this.entityPaths.get(this.cacheKey(p))?.get(`${kind}:${id}`) ?? statePath(dir, id);
  }
  pathFor(p: Project, kind: "workflow" | "conversation" | "task", id: string): string {
    return this.entityPath(p, kind, { workflow: WORKFLOW_DIR, conversation: CONVERSATION_DIR, task: TASKS_DIR }[kind], id);
  }

  private promptPath(p: Project, agentId: string, agent?: Agent): string {
    const existing = this.entityPaths.get(this.cacheKey(p))?.get(`prompt-history:${agentId}`);
    if (existing) return existing;
    const current = agent ?? this.deps.repositories?.agentRepo.findById(agentId)?.data;
    // Follow the agent's actual file path, which remains stable when a folder is copied.
    if (current?.projectId === p.id) {
      const base = `${PROMPT_HISTORY_DIR}/${this.agentPath(current).slice(AGENTS_DIR.length + 1)}`;
      const occupied = [...(this.entityPaths.get(this.cacheKey(p)) ?? [])].some(([key, path]) => key.startsWith("prompt-history:") && key !== `prompt-history:${agentId}` && path === base);
      // A deleted agent's history may outlive its definition. A replacement unit
      // must get its own ledger, without overwriting or adopting that history.
      return occupied ? `${base.slice(0, -3)}--${localId("CodeVia", "history-path", `${base}\0${current.createdAt}`).slice(-16)}.md` : base;
    }
    return statePath(PROMPT_HISTORY_DIR, agentId);
  }

  /** Only absent ledgers get an observed baseline or genuine legacy history. */
  missingPromptHistoryFiles(p: Project, agents: Agent[], snapshot: RepositorySnapshot, records = this.deps.repositories?.promptVersionRepo?.byProject(p.id) ?? []): GithubFile[] {
    const repo = this.deps.repositories?.promptVersionRepo;
    if (!repo) return [];
    const files: GithubFile[] = [];
    if (!snapshot.promptHistoryInitialized) files.push({ path: PROMPT_HISTORY_INDEX, content: renderPromptHistoryIndex() });
    const byId = new Map(agents.map((a) => [a.id, a]));
    const ids = new Set([...byId.keys(), ...records.map((v) => v.agentId)]);
    for (const agentId of ids) {
      const agent = byId.get(agentId), path = this.promptPath(p, agentId, agent);
      if (snapshot.contents.has(path)) continue; // includes intentionally empty/tombstoned ledgers
      const history = records.filter((v) => v.agentId === agentId && v.projectId === p.id);
      if (agent) {
        const observed = repo.draft(agent, { source: "repository:observed" }, history);
        if (!history.some((v) => v.id === observed.id)) history.push(observed);
      }
      if (history.length) files.push({ path, content: renderPromptHistory({ projectId: p.id, agentId, versions: history }) });
    }
    return files;
  }

  /** Used before prompt editing/reading on old installations; never invokes AI. */
  async ensurePromptHistory(p: Project): Promise<void> {
    if (!this.deps.repositories?.promptVersionRepo) return;
    const snapshot = await this.pull(p);
    await this.restore(p, undefined, { snapshot });
    const agents = this.deps.repositories.agentRepo.byProject(p.id);
    const files = this.missingPromptHistoryFiles(p, agents, snapshot);
    if (!files.length) return;
    await this.ensureFiles(p, files, snapshot.sha);
    await this.restore(p);
  }

  private promptWrites(p: Project, agents: Agent[], supplied?: PromptVersion[], all = false): StateWrite[] {
    const repo = this.deps.repositories?.promptVersionRepo;
    if (!repo && !supplied) return [];
    const ids = new Set(agents.map((a) => a.id));
    if (supplied?.some((v) => v.projectId !== p.id || (!all && !ids.has(v.agentId)))) throw stateError("prompt history write crosses project/agent boundaries");
    const cached = repo?.byProject(p.id) ?? [];
    const replaced = new Set(supplied?.map((v) => v.agentId) ?? []);
    const records = supplied ? [...cached.filter((v) => !replaced.has(v.agentId)), ...supplied] : cached;
    const knownAgents = new Map((this.deps.repositories?.agentRepo.byProject(p.id) ?? []).map((a) => [a.id, a]));
    for (const a of agents) knownAgents.set(a.id, a);
    const files = new Map<string, StateWrite>();
    const snapshot = this.decoded.get(this.cacheKey(p))?.state;
    if (snapshot) for (const f of this.missingPromptHistoryFiles(p, [...knownAgents.values()], snapshot, records)) files.set(f.path, f);
    for (const agentId of new Set(records.map((v) => v.agentId))) {
      if (!all && !ids.has(agentId)) continue;
      const versions = records.filter((v) => v.agentId === agentId);
      const path = this.promptPath(p, agentId, knownAgents.get(agentId));
      // Automatic saves cannot revive an intentionally removed ledger.
      if (!supplied && this.isTombstoned(p, path)) continue;
      files.set(path, { path, content: renderPromptHistory({ projectId: p.id, agentId, versions }), sourceSha: versions.find((v) => v.repositoryRevision)?.repositoryRevision ?? p.repositoryRevision });
    }
    return [...files.values()];
  }

  async syncAll(project: Project, input: { agents: Agent[]; tasks: Task[]; memory: MemoryEntry[]; skillCatalog?: Array<{ slug: string; description?: string }>; workflows?: Workflow[]; runs?: Run[]; conversations?: Conversation[]; promptVersions?: PromptVersion[] }, opts: { recoverMissingMock?: boolean } = {}): Promise<boolean> {
    const definitions = (input.skillCatalog ?? []).filter((s): s is Skill => "instructions" in s);
    const files: StateWrite[] = [
      { path: PROJECT_FILE, content: renderProjectFile(project, input.agents, input.tasks, input.memory) },
      { path: RULES_FILE, content: renderRulesFile(project.settings.rules) },
      ...input.agents.map((a) => ({ path: this.agentPath(a), content: renderAgentFile(a), sourceSha: a.repositoryRevision })),
      { path: SKILLS_FILE, content: renderSkillsFile(project, input.skillCatalog ?? []) },
      ...definitions.map((s) => ({ path: statePath(SKILL_DIR, s.slug), content: renderSkillFile(s), sourceSha: s.repositoryRevision })),
      ...input.tasks.map((t) => ({ path: this.entityPath(project, "task", TASKS_DIR, t.id), content: renderTaskFile(t), runtime: true })),
      { path: MEMORY_FILE, content: renderMemoryFile(input.memory) },
      ...(input.workflows ?? []).map((w) => ({ path: this.entityPath(project, "workflow", WORKFLOW_DIR, w.id), content: renderWorkflowFile(w), sourceSha: w.repositoryRevision })),
      ...(input.runs ?? []).map((r) => ({ path: this.entityPath(project, "run", RUN_DIR, r.id), content: renderRunFile(r), runtime: true })),
      ...(input.conversations ?? []).map((c) => ({ path: this.entityPath(project, "conversation", CONVERSATION_DIR, c.id), content: renderConversationFile(c), sourceSha: c.repositoryRevision })),
      ...this.promptWrites(project, input.agents, input.promptVersions, true),
    ];
    if (opts.recoverMissingMock) {
      // Recovery is not a general conflict-check bypass. Only a missing mock
      // snapshot may be filled, and the absence check + commit share one lock.
      return this.locked(project, async () => {
        if (this.github(project).kind !== "mock") throw stateError("mock recovery cannot write to real GitHub");
        const current = await this.raw(project);
        if (current.contents.size) return false;
        await this.commit(project, current, files, "[CodeVia] recover missing mock project state");
        return true;
      });
    }
    return this.writeFiles(project, files, "[CodeVia] save project state");
  }
  agentPath(a: Agent): string {
    const path = a.configPath ?? statePath(AGENTS_DIR, a.id);
    if (!isStatePath(path) || !path.startsWith(`${AGENTS_DIR}/`) || !path.endsWith(".md")) {
      const raw = a.configPath ?? `(unset; would fall back to ${path})`;
      throw stateError(`agent definition path must be inside CodeVia/agents/; agent ${a.id} (type "${a.type}", slug "${a.slug ?? a.type}") has configPath "${raw}". Move its definition under CodeVia/agents/ (or delete the stale record) and pull/refresh.`);
    }
    return path;
  }
  syncTask(p: Project, t: Task): Promise<boolean> { return this.writeFiles(p, [{ path: this.entityPath(p, "task", TASKS_DIR, t.id), content: renderTaskFile(t), runtime: true }], `[CodeVia] task ${t.id} → ${t.status}`, false); }
  syncRun(p: Project, r: Run): Promise<boolean> { return this.writeFiles(p, [{ path: this.entityPath(p, "run", RUN_DIR, r.id), content: renderRunFile(r), runtime: true }], `[CodeVia] run ${r.id} → ${r.status}`, false); }
  syncAgents(p: Project, agents: Agent[], versions?: PromptVersion[]): Promise<boolean> { return this.writeFiles(p, [...agents.map((a) => ({ path: this.agentPath(a), content: renderAgentFile(a), sourceSha: a.repositoryRevision })), ...this.promptWrites(p, agents, versions)], "[CodeVia] save agents and prompt history"); }
  syncSkills(p: Project, catalog: Array<{ slug: string; description?: string }> = []): Promise<boolean> { return this.writeFiles(p, [{ path: SKILLS_FILE, content: renderSkillsFile(p, catalog) }, ...catalog.filter((s): s is Skill => "instructions" in s).map((s) => ({ path: statePath(SKILL_DIR, s.slug), content: renderSkillFile(s), sourceSha: s.repositoryRevision }))], "[CodeVia] save skills"); }
  syncMemory(p: Project, entries: MemoryEntry[]): Promise<boolean> { return this.writeFiles(p, [{ path: MEMORY_FILE, content: renderMemoryFile(entries) }], "[CodeVia] save memory"); }
  syncWorkflow(p: Project, w: Workflow): Promise<boolean> { return this.writeFiles(p, [{ path: this.entityPath(p, "workflow", WORKFLOW_DIR, w.id), content: renderWorkflowFile(w), sourceSha: w.repositoryRevision }], "[CodeVia] save workflow"); }
  syncConversation(p: Project, c: Conversation): Promise<boolean> { return this.writeFiles(p, [{ path: this.entityPath(p, "conversation", CONVERSATION_DIR, c.id), content: renderConversationFile(c), sourceSha: c.repositoryRevision }], "[CodeVia] save conversation"); }
  syncContext(p: Project, content: string): Promise<boolean> { return this.writeFiles(p, [{ path: RUNTIME_CONTEXT_FILE, content }], "[CodeVia] save runtime context", false); }
  async readContext(p: Project): Promise<string | undefined> { const state = await this.pull(p); return state.contents.get(RUNTIME_CONTEXT_FILE) ?? state.contents.get(CONTEXT_FILE); }
  /**
   * Intentional removal. The tombstone records the entity identity (kind, id,
   * slug/type) so a copied repository — where IDs are re-bound to a new project
   * — still recognizes the deletion (R03/R04); the file path alone is not a
   * stable identity across copies.
   */
  tombstone(p: Project, path: string, meta: { kind?: string; id?: string; slug?: string; type?: string } = {}): Promise<boolean> {
    return this.writeFiles(p, [{ path, content: matter({ schemaVersion: 2, deleted: true, ...meta }, "Intentionally removed. Do not regenerate automatically.") }], "[CodeVia] remove definition");
  }

  async updateMemory(p: Project, mutate: (entries: MemoryEntry[]) => MemoryEntry[]): Promise<MemoryEntry[]> {
    return this.locked(p, async () => {
      const raw = await this.raw(p);
      const old = raw.contents.get(MEMORY_FILE);
      const entries = (old ? parseMemoryFile(old) : []).map((e) => this.memoryEntry(p, e));
      // Keep an exact archival copy when the old aggregate used the ambiguous
      // legacy heading format. Subsequent writes use the lossless v2 entries.
      if (old?.trim() && parseMatter(old).data.schemaVersion !== 2 && !entries.some((e) => e.key === "_legacy/CodeVia-memory.md")) {
        entries.push({ id: localId(p.id, "memory", "knowledge\0_legacy/CodeVia-memory.md"), projectId: p.id, scope: "project", type: "knowledge", key: "_legacy/CodeVia-memory.md", content: old, tags: ["legacy-import"], refs: [], source: "legacy:CodeVia/memory.md", version: 1, createdAt: p.createdAt, updatedAt: p.updatedAt });
      }
      const next = z.array(memorySchema).max(10_000).parse(mutate(entries));
      await this.commit(p, raw, [{ path: MEMORY_FILE, content: renderMemoryFile(next) }], "[CodeVia] update memory");
      if (this.deps.repositories) this.indexMemory(p, next, this.deps.repositories.memoryRepo);
      return next;
    });
  }
  private memoryEntry(p: Project, e: ParsedMemoryEntry): MemoryEntry {
    return { ...e, id: localId(p.id, "memory", `${e.type}\0${e.key}`), projectId: p.id, scope: e.scope ?? "project", type: e.type as MemoryEntry["type"], refs: e.refs ?? [], source: e.source || "repository", createdAt: e.createdAt || e.updatedAt || p.createdAt, updatedAt: e.updatedAt || p.updatedAt };
  }
  private indexMemory(p: Project, entries: MemoryEntry[], repo: MemoryRepository): void {
    repo.deleteByProject(p.id);
    for (const e of entries) repo.upsert(e, { projectId: p.id, key: e.key });
  }

  async restore(p: Project, repositories?: StateRepositories, opts: { includeTasks?: boolean; snapshot?: RepositorySnapshot } = {}): Promise<PullSummary> {
    const repos = { ...this.deps.repositories, ...repositories } as StateRepositories;
    if (!repos.projectRepo || !repos.agentRepo) throw stateError("cache repositories are not configured");
    const snapshot = opts.snapshot ?? await this.pull(p);
    const now = new Date().toISOString();
    // The file's own project namespace controls ID rebinding when a folder is copied.
    const imported = Boolean(snapshot.manifest?.id && snapshot.manifest.id !== p.id);
    const remap = new Map<string, string>();
    const local = new Set<string>();
    for (const [kind, entities] of [["agent", snapshot.agents], ["task", snapshot.tasks], ["workflow", snapshot.workflows], ["run", snapshot.runs], ["conversation", snapshot.conversations]] as const) {
      for (const entity of entities) {
        const mapped = imported && entity.projectId !== p.id ? localId(p.id, kind, entity.id) : entity.id;
        remap.set(`${kind}:${entity.id}`, mapped); local.add(`${kind}:${mapped}`);
      }
    }
    for (const h of snapshot.promptHistories) {
      const mapped = imported && h.projectId !== p.id ? localId(p.id, "agent", h.agentId) : h.agentId;
      remap.set(`agent:${h.agentId}`, mapped); local.add(`agent:${mapped}`);
      for (const v of h.versions) {
        const key = imported && v.projectId !== p.id ? localId(p.id, "prompt-version", v.id) : v.id;
        remap.set(`prompt-version:${v.id}`, key); local.add(`prompt-version:${key}`);
      }
    }
    const id = (kind: string, source: string | undefined): string | undefined => source && (remap.get(`${kind}:${source}`) ?? (local.has(`${kind}:${source}`) || !imported ? source : localId(p.id, kind, source)));
    for (const e of snapshot.memory) if (e.id) remap.set(`memory:${e.id}`, localId(p.id, "memory", `${e.type}\0${e.key}`));
    const rebind = (value: unknown, key = ""): unknown => {
      if (Array.isArray(value)) return value.map((v) => rebind(v, key));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebind(v, k)]));
      if (typeof value !== "string") return value;
      const kind = /(?:agent|task|workflow|run|conversation|memory)Ids?$/i.exec(key)?.[0].replace(/Ids?$/i, "").toLowerCase();
      if (kind) return remap.get(`${kind}:${value}`) ?? value;
      if (key === "refs") {
        const candidates = [...new Set([...remap].filter(([k]) => k.endsWith(`:${value}`)).map(([, v]) => v))];
        if (candidates.length === 1) return candidates[0];
      }
      return value;
    };
    const paths = new Map<string, string>();
    for (const [path, content] of snapshot.contents) {
      if (![TASKS_DIR, WORKFLOW_DIR, RUN_DIR, CONVERSATION_DIR, PROMPT_HISTORY_DIR].some((dir) => path.startsWith(`${dir}/`) && path.endsWith(".md")) || /(?:^|\/)README\.md$/i.test(path)) continue;
      const { data } = parseMatter(content);
      if (data.deleted) continue;
      if (path.startsWith(`${PROMPT_HISTORY_DIR}/`)) {
        const history = parsePromptHistory(content);
        paths.set(`prompt-history:${id("agent", history.agentId)}`, path);
        continue;
      }
      for (const [kind, dir, key] of [["task", TASKS_DIR, undefined], ["workflow", WORKFLOW_DIR, "workflow"], ["run", RUN_DIR, "run"], ["conversation", CONVERSATION_DIR, "conversation"]] as const) {
        if (path.startsWith(`${dir}/`) && path.endsWith(".md")) {
          const value = key ? data[key] as { id?: string } : data;
          if (value?.id) paths.set(`${kind}:${id(kind, String(value.id))}`, path);
        }
      }
    }
    const apply = () => {
      const stored = repos.projectRepo.findById(p.id)?.data ?? p;
      let project = stored;
      if (snapshot.manifest?.definition) {
        const def = definitionSchema.parse(snapshot.manifest.definition);
        let links = normalizeRepositories(def.repositories);
        if (!links.some((r) => r.repo === p.configRepo && r.branch === p.branch)) {
          if (!imported) throw stateError("manifest cannot redirect the connected repository; update the connection explicitly");
          links = links.map((r) => r.isConfigRepo ? { ...r, repo: p.configRepo, branch: p.branch } : r);
        }
        project = hydrateProject({ ...stored, ...def, capabilities: normalizeCapabilities(def.capabilities), id: p.id, slug: stored.slug, repositories: links.map((r) => ({ ...r, isConfigRepo: r.repo === p.configRepo && r.branch === p.branch })), configRepo: p.configRepo, branch: p.branch,
          defaultModelId: def.defaultModelId ?? undefined, defaultAgentId: id("agent", def.defaultAgentId ?? undefined), telegramChatId: def.telegramChatId ?? undefined,
          settings: { ...def.settings, permissions: def.settings.permissions as Project["settings"]["permissions"], workflows: def.settings.workflows.map((w) => id("workflow", w)!) },
          repositoryState: def.repositoryState ?? { version: 2, generation: "imported", initializedAt: now },
        } as Project);
      } else if (snapshot.manifest) {
        const m = snapshot.manifest, prompt = m.promptSettings as Partial<Project["settings"]> | undefined;
        project = hydrateProject({ ...stored, description: typeof m.description === "string" ? m.description : stored.description,
          capabilities: (m.capabilities as Project["capabilities"]) ?? stored.capabilities,
          settings: { ...stored.settings, ...(prompt?.rules ? { rules: stringList.parse(prompt.rules) } : {}), ...(prompt?.environment ? { environment: z.enum(["development", "staging", "production"]).parse(prompt.environment) } : {}), ...(prompt?.generatedSkills ? { generatedSkills: stringList.parse(prompt.generatedSkills) } : {}) },
        });
      }
      if (snapshot.skillsLoaded) project = { ...project, settings: { ...project.settings, skills: snapshot.skills } };
      if (snapshot.rules !== undefined) project = { ...project, settings: { ...project.settings, rules: snapshot.rules } };
      repos.projectRepo.upsert({ ...project, repositoryRevision: snapshot.sha }, { key: project.slug });
      if (project.repositoryState || snapshot.manifest || snapshot.agents.length) {
        const keep = new Set(snapshot.agents.map((a) => id("agent", a.id)));
        for (const cached of repos.agentRepo.byProject(p.id)) if (!keep.has(cached.id)) repos.agentRepo.deleteById(cached.id);
      }
      for (const a of snapshot.agents) {
        const key = id("agent", a.id)!;
        const existing = repos.agentRepo.findById(key)?.data;
        if (existing && existing.projectId !== p.id) throw stateError(`agent identity crosses projects: ${key}`);
        const agent: Agent = { ...a, repositoryRevision: snapshot.sha, id: key, projectId: p.id, type: a.type as Agent["type"], slug: a.slug ?? a.type, systemPrompt: a.systemPrompt, configPath: a.configPath,
          createdAt: a.createdAt ?? existing?.createdAt ?? now, updatedAt: a.updatedAt ?? now };
        repos.agentRepo.upsert(agent, { projectId: p.id });
      }
      if (repos.promptVersionRepo) {
        // Without an index marker old installs may still have genuine DB-only
        // history. Keep it just long enough for explicit migration, never over a
        // ledger that already exists in Git.
        if (snapshot.promptHistoryInitialized) repos.promptVersionRepo.deleteByProject(p.id);
        for (const h of snapshot.promptHistories) {
          const agentId = id("agent", h.agentId)!;
          if (!snapshot.promptHistoryInitialized) for (const v of repos.promptVersionRepo.forAgent(agentId)) if (v.projectId === p.id) repos.promptVersionRepo.deleteById(v.id);
          for (const v of h.versions) {
            const key = id("prompt-version", v.id)!;
            const existing = repos.promptVersionRepo.findById(key)?.data;
            if (existing && existing.projectId !== p.id) throw stateError(`prompt version identity crosses projects: ${key}`);
            repos.promptVersionRepo.upsert({ ...v, id: key, agentId, projectId: p.id, repositoryRevision: snapshot.sha }, { projectId: p.id, parentId: agentId });
          }
        }
      }
      if (repos.skillRepo && (project.repositoryState || snapshot.skillDefinitions.length)) {
        repos.skillRepo.deleteByProject(p.id);
        for (const s of snapshot.skillDefinitions) repos.skillRepo.upsert({ ...s, repositoryRevision: snapshot.sha, projectId: p.id, id: localId(p.id, "skill", s.slug) }, { projectId: p.id, key: s.slug });
      }
      if (project.repositoryState || snapshot.contents.has(MEMORY_FILE)) this.indexMemory(p, snapshot.memory.map((e) => this.memoryEntry(p, { ...e, refs: rebind(e.refs ?? [], "refs") as string[] })), repos.memoryRepo);
      if (repos.workflowRepo && (project.repositoryState || snapshot.workflows.length)) {
        repos.workflowRepo.deleteByProject(p.id);
        for (const w of snapshot.workflows) repos.workflowRepo.upsert({ ...w, repositoryRevision: snapshot.sha, id: id("workflow", w.id)!, projectId: p.id, nodes: w.nodes.map((n) => ({ ...n, config: { ...n.config, ...(typeof n.config.agentId === "string" ? { agentId: id("agent", n.config.agentId) } : {}) } })) }, { projectId: p.id });
      }
      if (opts.includeTasks !== false) for (const t of snapshot.tasks) {
        const key = id("task", t.id)!;
        const existing = repos.taskRepo.findById(key)?.data;
        if (existing && existing.projectId !== p.id) throw stateError(`task identity crosses projects: ${key}`);
        if (existing) {
          // (R02) Runtime owns the status of live work — Git history never
          // resurrects cancellation. But finished work is history: content
          // edits made in Git (title/description/brief/error) must reach the
          // API instead of staying DB-authoritative forever.
          if (!["created", "queued", "running", "waiting_for_approval"].includes(existing.status)) {
            const brief = typeof t.researchBrief === "string" ? t.researchBrief : undefined;
            const changed = existing.title !== t.title || existing.description !== t.description || existing.error !== (t.error ?? undefined) || (brief !== undefined && existing.input?.researchBrief !== brief);
            if (changed) repos.taskRepo.upsert({
              ...existing, title: t.title, description: t.description, error: t.error ?? undefined, updatedAt: t.updatedAt || existing.updatedAt,
              input: { ...existing.input, ...(brief !== undefined ? { researchBrief: brief } : {}) },
            }, { projectId: p.id, parentId: id("task", t.parentTaskId) });
          }
          continue;
        }
        const interrupted = ["running", "queued", "waiting_for_approval"].includes(t.status);
        repos.taskRepo.upsert({ ...t, id: key, projectId: p.id, agentType: t.agentType as Task["agentType"], assignedAgentId: id("agent", t.assignedAgentId), workflowId: id("workflow", t.workflowId), parentTaskId: id("task", t.parentTaskId),
          status: interrupted ? "failed" : t.status, error: interrupted ? "Restored interrupted execution; review before explicitly retrying." : t.error,
          correlationId: t.correlationId ?? `restored-${key}`, result: rebind(t.result) as Task["result"], input: { ...rebind(t.input) as Task["input"], ...(t.researchBrief ? { researchBrief: t.researchBrief } : {}), ...(Array.isArray(t.input?.dependsOn) ? { dependsOn: t.input.dependsOn.map((dep) => id("task", String(dep))) } : {}) },
        }, { projectId: p.id, parentId: id("task", t.parentTaskId) });
      }
      if (opts.includeTasks !== false && repos.runRepo) for (const r of snapshot.runs) {
        const key = id("run", r.id)!; const existing = repos.runRepo.findById(key)?.data;
        if (existing && existing.projectId !== p.id) throw stateError(`run identity crosses projects: ${key}`);
        if (!existing) repos.runRepo.upsert({ ...r, steps: rebind(r.steps) as Run["steps"], id: key, projectId: p.id, taskId: id("task", r.taskId)!, agentId: id("agent", r.agentId)!, workflowId: id("workflow", r.workflowId), status: ["running", "queued", "waiting_for_approval"].includes(r.status) ? "failed" : r.status }, { projectId: p.id, parentId: id("task", r.taskId) });
        // (R02) Completed runs are history: Git edits to the human-visible
        // content (summary/verification/error) flow through; status and steps
        // stay runtime-owned.
        else {
          const changed = existing.summary !== r.summary || existing.verification !== r.verification || existing.error !== r.error;
          if (changed) repos.runRepo.upsert({ ...existing, summary: r.summary, verification: r.verification, error: r.error }, { projectId: p.id, parentId: id("task", r.taskId) });
        }
      }
      if (repos.conversationRepo && project.repositoryState) {
        const keep = new Set(snapshot.conversations.map((c) => id("conversation", c.id)));
        for (const r of repos.conversationRepo.findMany({ projectId: p.id })) if (!keep.has(r.data.id)) repos.conversationRepo.deleteById(r.data.id);
      }
      if (repos.conversationRepo) for (const c of snapshot.conversations) {
        const key = id("conversation", c.id)!; const existing = repos.conversationRepo.findById(key)?.data;
        if (existing && existing.projectId !== p.id) throw stateError(`conversation identity crosses projects: ${key}`);
        repos.conversationRepo.upsert({ ...c, repositoryRevision: snapshot.sha, id: key, projectId: p.id, activeAgentId: id("agent", c.activeAgentId) }, { projectId: p.id, parentId: c.userId });
      }
    };
    if (this.deps.transaction) this.deps.transaction(apply); else apply();
    this.entityPaths.set(this.cacheKey(p), paths);
    return { promptVersions: snapshot.promptHistories.reduce((count, h) => count + h.versions.length, 0), agents: snapshot.agents.length, tasks: opts.includeTasks === false ? 0 : snapshot.tasks.length, memory: snapshot.memory.length, skills: snapshot.skills, files: snapshot.files, sha: snapshot.sha, workflows: snapshot.workflows.length, runs: snapshot.runs.length, conversations: snapshot.conversations.length };
  }
}
