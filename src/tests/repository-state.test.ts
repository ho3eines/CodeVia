import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { Db } from "../db/client.js";
import { freshDb } from "./test-helpers.js";
import type { Agent, MemoryEntry, Project, Skill } from "../domain/entities.js";
import type { ChatRequest, IModelProvider } from "../ai/types.js";
import {
  ProjectRepository,
  TaskRepository,
  MemoryRepository,
  WorkflowRepository,
  ConversationRepository,
} from "../domain/repos.js";
import { AgentRepository } from "../agents/agent-repo.js";
import { SkillRepository, SkillRegistry } from "../skills/registry.js";
import { RunRepository } from "../observability/repos.js";
import { PromptVersionRepository } from "../prompts/versions.js";
import {
  PROMPT_HISTORY_INDEX,
  PROMPT_HISTORY_DIR,
  parsePromptHistory,
  renderPromptHistory,
} from "../github/prompt-history.js";
import { ProjectStateGenerator } from "../agents/state-generator.js";
import {
  ProjectFilesService,
  parseMatter,
  matter,
  PROJECT_FILE,
  MEMORY_FILE,
  CONTEXT_FILE,
  RUNTIME_CONTEXT_FILE,
  renderAgentFile,
  renderMemoryFile,
  renderProjectFile,
} from "../github/project-files.js";
import { localId, parseSkillFile, renderSkillFile, RULES_FILE } from "../github/state-codec.js";
import { MockGitHubService } from "../github/mock-service.js";
import { CodeViaMemoryStore } from "../memory/codevia-store.js";
import { isStateOnlyPush } from "../github/automation.js";
import { syncProjectContext } from "../agents/context.js";

let fx: ReturnType<typeof freshDb>, c: Container, p: Project, gh: MockGitHubService;
let app: FastifyInstance | undefined;
const ref = (project = p) => {
  const [owner, name] = project.configRepo.split("/");
  return { owner, name };
};
const get = async (path: string, project = p) => (await gh.getFile(ref(project), path, project.branch))!.content;
const edit = async (path: string, content: string, project = p) =>
  gh.commit(ref(project), project.branch, "Human repository edit", [{ path, content }]);
const body =
  "# Design\n\nمتن فارسی 🎯\n\n## Risks\nKeep this entire section.\n\n### Details\n```ts\nexport const n = 1;\n```\n\n" +
  "Long evidence. ".repeat(600);
const memory = (project = p): MemoryEntry => ({
  id: localId(project.id, "memory", "decision\0shared/key"),
  projectId: project.id,
  type: "decision",
  scope: "task",
  key: "shared/key",
  content: body,
  tags: ["architecture", "فارسی"],
  refs: ["task-a", "https://example.test/spec"],
  source: "human",
  version: 7,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});
const customSkill = (slug: string, over: Partial<Skill> = {}): Skill => ({
  id: "external-skill",
  slug,
  name: "Repository skill",
  description: "Only in Git",
  category: "project",
  instructions: "# Exact knowledge\n\nUse the existing session contract.\n",
  version: "7.2.0",
  enabled: true,
  builtIn: false,
  tools: [],
  dependencies: [],
  compatibleAgentTypes: ["*"],
  metadata: { author: "human" },
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  ...over,
});
async function server() {
  app ??= (await buildServer(c)).app;
  await app.ready();
  return app;
}

beforeEach(async () => {
  fx = freshDb();
  c = new Container();
  await c.ensureSeed();
  gh = c.github as MockGitHubService;
  p = await c.agentManager.createProject({
    name: "Canonical",
    configRepo: "acme/canonical",
    description: "A TypeScript session service",
    capabilities: { languages: ["typescript"], frameworks: ["react"] },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  c.githubAutomation.stop();
  await app?.close();
  app = undefined;
  await new Promise<void>((r) => setImmediate(r));
  fx.cleanup();
});

async function model(name = "author", respond?: (req: ChatRequest) => string | Promise<string>) {
  const provider = c.providerRepo.create({
    name,
    type: "openai",
    baseUrl: "https://unused.invalid/v1",
    authType: "none",
    apiFormat: "openai",
    rateLimitPerMinute: 100,
    timeoutMs: 1000,
    defaultTemperature: 0.2,
    maxTokensDefault: 4500,
    active: true,
  });
  const m = c.modelRepo.create({
    providerId: provider.id,
    modelId: name,
    displayName: name,
    contextWindow: 128000,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.02,
    capabilities: {
      code: true,
      reasoning: true,
      structuredOutput: true,
      tools: false,
      streaming: false,
      vision: false,
    },
    active: true,
    priority: 1,
    fallbackPriority: 1,
    tags: [],
  });
  const requests: ChatRequest[] = [];
  const runtime: IModelProvider = {
    id: provider.id,
    type: "openai",
    name,
    health: async () => true,
    listModels: async () => [],
    resolveApiKey: () => undefined,
    chat: async (req) => {
      requests.push(req);
      const entries = JSON.parse(req.messages[1].content.split("--- Current operation ---\n").at(-1)!) as Record<
        string,
        { fields: Record<string, unknown> }
      >;
      const result = Object.fromEntries(
        Object.entries(entries).map(([key, spec]) => [
          key,
          Object.fromEntries(
            Object.keys(spec.fields).map((field) => [
              field,
              field === "rules"
                ? ["Use the documented session contract; do not invent history."]
                : `AI ${key} ${field}: use the existing session contract and verify changes.`,
            ]),
          ),
        ]),
      );
      return {
        content: respond ? await respond(req) : JSON.stringify(result),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        costUsd: 0,
        modelId: req.modelId,
        providerId: provider.id,
      };
    },
  };
  c.providerRegistry.register(runtime);
  return { model: m, requests };
}
async function copyPartial(name: string, omit: string[], defaultModelId?: string) {
  const state = await c.projectFiles.pull(p);
  const files = [...state.contents]
    .filter(([path]) => !omit.includes(path))
    .map(([path, content]) => ({ path, content }));
  const manifest = files.find((f) => f.path === PROJECT_FILE)!;
  const parsed = parseMatter(manifest.content);
  if (defaultModelId) (parsed.data.definition as Record<string, unknown>).defaultModelId = defaultModelId;
  manifest.content = matter(parsed.data, parsed.body.replace(/^\n/, ""));
  gh.seedRepo("acme", name, { files, branch: "main" });
  return files;
}

describe("canonical CodeVia definitions", () => {
  it("writes complete versioned definitions and explicitly labels offline initialization", async () => {
    const state = await c.projectFiles.pull(p);
    expect(p.repositoryState?.generation).toBe("simulation");
    expect(state.manifest?.schemaVersion).toBe(2);
    expect(state.skillDefinitions.length).toBeGreaterThan(8);
    expect(state.workflows).toHaveLength(2);
    expect(state.files).toEqual(
      expect.arrayContaining([PROJECT_FILE, MEMORY_FILE, CONTEXT_FILE, RULES_FILE, "CodeVia/skills/testing.md"]),
    );
    const skill = c.skillRepo.findBySlug("testing", p.id)!;
    expect(parseSkillFile(await get("CodeVia/skills/testing.md"))).toMatchObject({
      instructions: skill.instructions,
      dependencies: skill.dependencies,
      version: skill.version,
      enabled: true,
    });
    expect((await gh.listFiles(ref(p), p.branch)).some((f) => f.path.startsWith(".ai-engineering/"))).toBe(false);
  });

  it("does not call AI or commit when all definitions already exist", async () => {
    const before = await c.projectFiles.pull(p);
    const generate = vi.spyOn(ProjectStateGenerator.prototype, "generate"),
      commit = vi.spyOn(gh, "commit");
    await c.agentManager.onboardProject(p.id);
    await c.agentManager.onboardProject(p.id);
    expect(generate).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect((await c.projectFiles.pull(p)).contents).toEqual(before.contents);
  });

  it("preserves custom prompts, models, tools, permissions, limits, version and disabled agents", async () => {
    const a = c.agentRepo.byType(p.id, "research")!;
    const changed: Agent = {
      ...a,
      systemPrompt: "HUMAN RESEARCH PROMPT",
      projectPrompt: "Custom context",
      enabled: false,
      tools: [],
      permissions: [],
      memorySources: ["decision"],
      models: { primary: "do-not-replace", fallbacks: [], specialized: {} },
      maxIterations: 2,
      timeoutMs: 9000,
      tokenBudget: 1234,
      version: 29,
    };
    const file = renderAgentFile(changed);
    await edit(a.configPath!, file);
    await c.agentManager.onboardProject(p.id);
    expect(await get(a.configPath!)).toBe(file);
    const restored = c.agentRepo.findById(a.id)!.data;
    for (const key of [
      "systemPrompt",
      "projectPrompt",
      "enabled",
      "tools",
      "permissions",
      "models",
      "maxIterations",
      "timeoutMs",
      "tokenBudget",
      "memorySources",
      "version",
    ] as const)
      expect(restored[key]).toEqual(changed[key]);
  });

  it("discovers a skill placed in Git automatically through the project catalog API", async () => {
    const skill = customSkill("session-contract");
    await edit("CodeVia/skills/session-contract.md", renderSkillFile(skill));
    const srv = await server();
    const list = (await srv.inject({ method: "GET", url: `/skills?projectId=${p.id}` })).json() as Skill[];
    expect(list.find((s) => s.slug === skill.slug)).toMatchObject({
      projectId: p.id,
      instructions: skill.instructions,
      dependencies: [],
    });
    expect(c.skillRepo.globalCatalog().some((s) => s.slug === skill.slug)).toBe(false);
    const settings = c.projectRepo.findById(p.id)!.data.settings;
    expect(settings.skills).not.toContain(skill.slug); // Discovery is not indiscriminate task application.
  });

  it("keeps project overrides independent from global marketplace upgrades", async () => {
    const global = c.skillRepo.findBySlug("testing")!;
    c.skillRepo.upsert({ ...global, instructions: "GLOBAL REPLACEMENT", enabled: false }, { key: global.slug });
    await c.agentManager.readProject(p.id);
    expect(c.skillRepo.findBySlug("testing", p.id)!.instructions).not.toContain("GLOBAL REPLACEMENT");
    expect(c.skillsRegistry.catalog(p).find((s) => s.slug === "testing")!.enabled).toBe(true);
  });

  it("detects conflicting writes even if a different reader refreshed the shared cache", async () => {
    const old = c.agentRepo.byType(p.id, "research")!;
    const human = renderAgentFile({ ...old, systemPrompt: "New human edit" });
    await edit(old.configPath!, human);
    await c.agentManager.readProject(p.id);
    await expect(c.projectFiles.syncAgents(p, [{ ...old, systemPrompt: "Stale request" }])).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await get(old.configPath!)).toBe(human);
  });

  it("does not overwrite project-owned context when execution updates its entity registry", async () => {
    await edit(CONTEXT_FILE, "# Human architecture\n\nNever replace my notes.\n");
    await syncProjectContext({
      files: c.projectFiles,
      github: gh,
      project: p,
      entries: [
        {
          entity: "Session",
          path: "src/session.ts",
          agentType: "backend-developer",
          subtaskId: "task-1",
          at: p.updatedAt,
        },
      ],
    });
    expect(await get(CONTEXT_FILE)).toContain("Never replace my notes.");
    expect(await get(RUNTIME_CONTEXT_FILE)).toContain("src/session.ts");
  });

  it("prevents two local projects from competing over one canonical folder", async () => {
    await expect(
      c.agentManager.createProject({
        description: "Session service",
        name: "Conflicting project",
        configRepo: p.configRepo,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("lossless memory and restore", () => {
  it("round-trips nested headings, fences, Persian, references, scope, versions and >4K content", async () => {
    const entry = memory();
    await edit(MEMORY_FILE, renderMemoryFile([entry]));
    await c.agentManager.readProject(p.id);
    expect(c.memoryRepo.byProject(p.id)).toEqual([entry]);
    const store = new CodeViaMemoryStore(c.projectFiles, p);
    expect(await store.get("decision", "shared/key")).toBe(body);
    expect((await store.search("entire section"))[0].content).toBe(body);
  });

  it("isolates identical memory keys across two project repositories", async () => {
    const b = await c.agentManager.createProject({
      description: "Session service",
      name: "Second",
      configRepo: "acme/second",
    });
    const aStore = new CodeViaMemoryStore(c.projectFiles, p),
      bStore = new CodeViaMemoryStore(c.projectFiles, b);
    await Promise.all([aStore.update({ ...memory(), content: "A" }), bStore.update({ ...memory(b), content: "B" })]);
    expect(c.memoryRepo.byProject(p.id)).toHaveLength(1);
    expect(c.memoryRepo.byProject(b.id)).toHaveLength(1);
    expect(await aStore.get("decision", "shared/key")).toBe("A");
    expect(await bStore.get("decision", "shared/key")).toBe("B");
    expect(c.memoryRepo.byProject(p.id)[0].id).not.toBe(c.memoryRepo.byProject(b.id)[0].id);
  });

  it("serializes concurrent appends without losing either complete memory record", async () => {
    const a = new CodeViaMemoryStore(c.projectFiles, p),
      b = new CodeViaMemoryStore(c.projectFiles, p);
    await Promise.all([
      a.append({ ...memory(), content: "First", refs: ["one"] }),
      b.append({ ...memory(), content: "Second", refs: ["two"] }),
    ]);
    const entry = c.memoryRepo.byProject(p.id)[0];
    expect(entry.content).toContain("First");
    expect(entry.content).toContain("Second");
    expect(entry.version).toBe(2);
    expect(entry.refs).toEqual(["one", "two"]);
  });

  it("restores complete definitions and histories into a genuinely separate empty database", async () => {
    const task = c.agentManager.createTask({
      projectId: p.id,
      title: "Inspect session",
      description: "Check authentication",
      agentType: "research",
    });
    await c.agentManager.runTask(task.id);
    await edit(MEMORY_FILE, renderMemoryFile([memory()]));
    const conv = c.conversationRepo.create({
      projectId: p.id,
      userId: "local-user",
      source: "web",
      title: "Design review",
      activeAgentId: c.agentRepo.byType(p.id, "research")!.id,
      messages: [{ id: "message-1", role: "user", content: "Keep the existing API", createdAt: p.createdAt }],
    });
    await c.projectFiles.syncConversation(c.projectRepo.findById(p.id)!.data, conv);
    const db = new Db(":memory:");
    try {
      const repositories = {
        projectRepo: new ProjectRepository(db),
        agentRepo: new AgentRepository(db),
        taskRepo: new TaskRepository(db),
        memoryRepo: new MemoryRepository(db),
        skillRepo: new SkillRepository(db),
        workflowRepo: new WorkflowRepository(db),
        runRepo: new RunRepository(db),
        conversationRepo: new ConversationRepository(db),
      };
      const files = new ProjectFilesService({ github: gh, repositories, transaction: (fn) => db.tx(fn) });
      await files.restore(p);
      expect(repositories.agentRepo.byProject(p.id).length).toBe(c.agentRepo.byProject(p.id).length);
      expect(
        new SkillRegistry(repositories.skillRepo).catalog(repositories.projectRepo.findById(p.id)!.data).length,
      ).toBeGreaterThan(8);
      expect(repositories.memoryRepo.byProject(p.id)[0]).toEqual(memory());
      expect(repositories.workflowRepo.byProject(p.id)).toHaveLength(2);
      expect(repositories.taskRepo.findById(task.id)!.data).toMatchObject({
        status: "succeeded",
        correlationId: task.correlationId,
      });
      expect(repositories.runRepo.byTask(task.id)[0].steps.length).toBeGreaterThan(0);
      expect(repositories.conversationRepo.findById(conv.id)!.data.messages).toEqual(conv.messages);
    } finally {
      db.close();
    }
  });

  it("never revives a cancelled live task from older Git history", async () => {
    const task = c.agentManager.createTask({ projectId: p.id, title: "Cancelled", description: "" });
    await c.agentManager.syncTaskFile(p.id, task);
    c.taskRepo.upsert({ ...task, status: "cancelled" }, { projectId: p.id });
    await c.projectFiles.restore(p);
    expect(c.taskRepo.findById(task.id)!.data.status).toBe("cancelled");
  });
});

describe("fail-closed repository boundary", () => {
  it.each([401, 403, 500])("does not regenerate or change cached state after GitHub %i", async (status) => {
    const before = c.agentRepo.byProject(p.id);
    const generate = vi.spyOn(ProjectStateGenerator.prototype, "generate");
    vi.spyOn(gh, "listBranches").mockRejectedValue(Object.assign(new Error("GitHub unavailable"), { status }));
    await expect(c.agentManager.onboardProject(p.id)).rejects.toThrow(/read\/validation failed/);
    expect(c.agentRepo.byProject(p.id)).toEqual(before);
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects an incomplete tree rather than initializing over hidden files", async () => {
    await edit("README.md", "New revision");
    vi.spyOn(gh, "listFiles").mockResolvedValue(
      Array.from({ length: 8000 }, (_, i) => ({
        path: `CodeVia/unknown-${i}.md`,
        type: "blob" as const,
        size: 0,
        sha: String(i),
      })),
    );
    await expect(c.agentManager.onboardProject(p.id)).rejects.toThrow(/incomplete snapshot/);
  });

  it("rejects a listed but unreadable file", async () => {
    await edit("README.md", "New revision");
    const original = gh.getFile.bind(gh);
    vi.spyOn(gh, "getFile").mockImplementation(async (r, path, branch) =>
      path === MEMORY_FILE ? undefined : original(r, path, branch),
    );
    await expect(c.agentManager.readProject(p.id)).rejects.toThrow(/could not be read/);
  });

  it.each(["memory", "agent", "schema"])("validates the entire %s snapshot before changing any cache", async (kind) => {
    const old = c.agentRepo.byType(p.id, "research")!;
    const files = [
      { path: old.configPath!, content: renderAgentFile({ ...old, name: "Should not partially hydrate" }) },
    ];
    if (kind === "memory")
      files.push({ path: MEMORY_FILE, content: matter({ schemaVersion: 2, entries: "not an array" }, "") });
    else if (kind === "agent") files[0].content = files[0].content.replace("enabled: true", 'enabled: "not a boolean"');
    else files.push({ path: RULES_FILE, content: matter({ schemaVersion: 99, rules: [] }, "") });
    await gh.commit(ref(), p.branch, "Invalid user edit", files);
    await expect(c.agentManager.readProject(p.id)).rejects.toThrow(/read\/validation failed/);
    expect(c.agentRepo.findById(old.id)!.data.name).toBe(old.name);
  });

  it("does not acknowledge failed commits as saved settings", async () => {
    const srv = await server();
    vi.spyOn(gh, "commit").mockRejectedValue(new Error("write access denied"));
    const result = await srv.inject({
      method: "PATCH",
      url: `/projects/${p.id}`,
      payload: { description: "Uncommitted" },
    });
    expect(result.statusCode).toBe(502);
    expect(c.projectRepo.findById(p.id)!.data.description).toBe(p.description);
    expect(await get(PROJECT_FILE)).not.toContain("Uncommitted");
  });

  it("excludes structured credentials and refuses recognizable plaintext credentials", async () => {
    const scoped = {
      ...p,
      ownerId: "local-account",
      githubConnection: { kind: "server-token" } as Project["githubConnection"],
      settings: {
        ...p.settings,
        metadata: {
          apiKey: "hidden-key",
          nested: {
            accessToken: "hidden-token",
            botToken: "hidden-bot",
            secretAccessKey: "hidden-aws",
            maxTokens: 5000,
            tokenBudget: 1000,
          },
        },
      },
    };
    const file = renderProjectFile(scoped, c.agentRepo.byProject(p.id), [], []);
    expect(file).not.toContain("hidden-key");
    expect(file).not.toContain("hidden-token");
    expect(file).not.toContain("hidden-bot");
    expect(file).not.toContain("hidden-aws");
    expect(file).not.toContain("local-account");
    expect(file).toContain("maxTokens");
    expect(file).toContain("tokenBudget");
    await expect(
      c.projectFiles.writeFiles(p, [{ path: "CodeVia/leak.md", content: `ghp_${"a".repeat(36)}` }], "No secrets"),
    ).rejects.toThrow(/credential material/);
    expect(await gh.getFile(ref(), "CodeVia/leak.md", p.branch)).toBeUndefined();
  });

  it("rebuilds a missing mock repository from current definitions instead of returning Mock repo not found", async () => {
    // Simulate an imported/legacy project whose repository was never seen by the
    // mock. Read/API actions must recover it from the database, not brick the UI.
    const legacy: Project = {
      ...p,
      id: "legacy-missing-repo",
      slug: "legacy-missing-repo",
      configRepo: "ho3eines/Projects",
      branch: "main",
      repositories: [{ repo: "ho3eines/Projects", branch: "main", role: "primary", isConfigRepo: true }],
      repositoryState: p.repositoryState,
    };
    c.projectRepo.upsert(legacy, { key: legacy.slug });
    const source = c.agentRepo.byType(p.id, "research")!;
    const restored = {
      ...source,
      id: "agent-research-legacy-missing",
      projectId: legacy.id,
      configPath: "CodeVia/agents/research.md",
      repositoryRevision: undefined,
    };
    c.agentRepo.upsert(restored, { projectId: legacy.id });
    for (const skill of c.skillRepo.byProject(p.id)) {
      c.skillRepo.upsert(
        { ...skill, id: localId(legacy.id, "skill", skill.slug), projectId: legacy.id },
        { key: skill.slug, projectId: legacy.id },
      );
    }

    await c.agentManager.readProject(legacy.id);
    expect(c.agentRepo.findById(restored.id)?.data.name).toBe(source.name);
    expect(c.agentRepo.findById(restored.id)?.data.systemPrompt).toBe(source.systemPrompt);
    expect(
      (await gh.listFiles({ owner: "ho3eines", name: "Projects" }, "main")).some(
        (f) => f.path === "CodeVia/agents/research.md",
      ),
    ).toBe(true);

    const srv = await server();
    const list = await srv.inject({ method: "GET", url: `/projects/${legacy.id}/agents` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ id: string }>).some((a) => a.id === restored.id)).toBe(true);
  });
});

describe("mock recovery safeguards", () => {
  async function loseMockSnapshot() {
    c.githubAutomation.stop();
    // Keep the restored database, but start with a fresh in-memory GitHub.
    c = new Container();
    await c.ensureSeed();
    gh = c.github as MockGitHubService;
  }

  it("does not overwrite canonical edits when only a linked mock repository is missing", async () => {
    const research = c.agentRepo.byType(p.id, "research")!;
    const linked: Project = {
      ...p,
      repositories: [...p.repositories, { repo: "acme/missing-linked", branch: "develop", role: "other" }],
    };
    c.projectRepo.upsert(linked, { key: linked.slug });
    await edit(PROJECT_FILE, renderProjectFile(linked, c.agentRepo.byProject(p.id), [], []));
    const human = renderAgentFile({
      ...research,
      systemPrompt: "New canonical prompt; never overwrite with the cache.",
    });
    await edit(research.configPath!, human);
    const commit = vi.spyOn(gh, "commit");

    await c.agentManager.readProject(p.id);

    expect(await get(research.configPath!)).toBe(human);
    expect(c.agentRepo.findById(research.id)!.data.systemPrompt).toContain("New canonical prompt");
    expect(commit).not.toHaveBeenCalled();
    expect(await gh.listBranches({ owner: "acme", name: "missing-linked" })).toEqual([
      expect.objectContaining({ name: "develop" }),
    ]);
  });

  it("rechecks canonical contents before bootstrapping after a stale repository listing", async () => {
    const research = c.agentRepo.byType(p.id, "research")!;
    const human = renderAgentFile({
      ...research,
      systemPrompt: "The repository appeared before recovery acquired the lock.",
    });
    await edit(research.configPath!, human);
    // Another read/recovery can create the repo after the absence check. The
    // inventory is not permission to replace its now-authoritative contents.
    vi.spyOn(gh, "listRepositories").mockResolvedValueOnce([]);
    const commit = vi.spyOn(gh, "commit");
    await c.agentManager.readProject(p.id);
    expect(await get(research.configPath!)).toBe(human);
    expect(commit).not.toHaveBeenCalled();
  });

  it("preserves customized disabled agents when explicit onboarding recovers a lost mock snapshot", async () => {
    const research = c.agentRepo.byType(p.id, "research")!;
    await c.projectFiles.syncAgents(p, [
      { ...research, enabled: false, systemPrompt: "Recovered user-authored prompt", version: 17 },
    ]);
    await loseMockSnapshot();

    await c.agentManager.onboardProject(p.id);

    expect(c.agentRepo.findById(research.id)!.data).toMatchObject({
      enabled: false,
      systemPrompt: "Recovered user-authored prompt",
      version: 17,
    });
    expect(await get(research.configPath!)).toContain("Recovered user-authored prompt");
  });

  it("preserves cached memory and skills even when a restored project has no agents", async () => {
    for (const agent of c.agentRepo.byProject(p.id)) c.agentRepo.deleteById(agent.id);
    const entry = memory();
    c.memoryRepo.upsert(entry, { projectId: p.id, key: entry.key });
    const skillCount = c.skillRepo.byProject(p.id).length;
    await loseMockSnapshot();

    await c.agentManager.readProject(p.id);

    expect(c.agentRepo.byProject(p.id)).toEqual([]);
    expect(c.memoryRepo.byProject(p.id)).toEqual([entry]);
    expect(c.skillRepo.byProject(p.id)).toHaveLength(skillCount);
    expect(await get(MEMORY_FILE)).toContain("Keep this entire section.");
  });
});

describe("missing-only AI generation", () => {
  it("authors initial project text with the selected model, accounts for usage and never grants capabilities", async () => {
    const selected = await model("selected-older");
    await model("unrelated-newer");
    const next = await c.agentManager.createProject({
      description: "Session service",
      name: "AI authored",
      configRepo: "acme/ai-authored",
      defaultModelId: selected.model.id,
      capabilities: { agentTypes: ["research"] },
    });
    expect(next.repositoryState).toMatchObject({ generation: "ai", modelId: selected.model.id });
    expect(selected.requests.length).toBeGreaterThan(1);
    expect(selected.requests.every((r) => r.modelId === "selected-older")).toBe(true);
    expect(c.costRepo.totals({ projectId: next.id }).calls).toBe(selected.requests.length);
    expect(c.agentRepo.byType(next.id, "research")!.systemPrompt).toContain("AI agent:research");
    expect(c.agentRepo.byType(next.id, "research")!.permissions).not.toContain("github.write");
    expect(c.skillRepo.byProject(next.id).every((s) => s.metadata.generatedBy === "ai")).toBe(true);
    expect(c.memoryRepo.byProject(next.id)[0].source).toContain("not completed-work history");
  });

  it("fills only missing agent/skill files in an existing copied folder and reuses them on retry", async () => {
    const selected = await model();
    const kept = await copyPartial(
      "partial",
      ["CodeVia/agents/backend-developer.md", "CodeVia/skills/testing.md"],
      selected.model.id,
    );
    const next = await c.agentManager.createProject({
      description: "Session service",
      name: "Reuse folder",
      configRepo: "acme/partial",
    });
    expect(selected.requests).toHaveLength(1);
    const request = selected.requests[0].messages[1].content.split("--- Current operation ---\n").at(-1)!;
    expect(Object.keys(JSON.parse(request)).sort()).toEqual(["agent:backend-developer", "skill:testing"]);
    for (const file of kept) expect(await get(file.path, next)).toBe(file.content);
    expect(c.agentRepo.byType(next.id, "backend-developer")!.systemPrompt).toContain("AI agent:backend-developer");
    expect(c.agentRepo.byType(next.id, "research")!.id).not.toBe(c.agentRepo.byType(p.id, "research")!.id);
    await c.agentManager.onboardProject(next.id);
    expect(selected.requests).toHaveLength(1);
    await c.agentManager.syncProjectState(next.id);
    await c.agentManager.onboardProject(next.id);
    expect(c.agentRepo.byProject(next.id)).toHaveLength(c.agentRepo.byProject(p.id).length);
  });

  it("treats tombstones and disabled definitions as intentional, not as missing material", async () => {
    const srv = await server();
    const a = c.agentRepo.byType(p.id, "backend-developer")!,
      s = c.skillRepo.findBySlug("testing", p.id)!;
    expect((await srv.inject({ method: "DELETE", url: `/agents/${a.id}` })).statusCode).toBe(200);
    expect((await srv.inject({ method: "POST", url: `/skills/${s.id}/disable` })).statusCode).toBe(200);
    const selected = await model();
    await c.agentManager.onboardProject(p.id);
    expect(selected.requests).toHaveLength(0);
    expect(c.agentRepo.findById(a.id)).toBeUndefined();
    expect(c.skillRepo.findBySlug("testing", p.id)!.enabled).toBe(false);
    expect(parseMatter(await get(a.configPath!)).data.deleted).toBe(true);
  });

  it("refuses missing material on a real connection without a model instead of writing simulated definitions", async () => {
    await copyPartial("no-model", ["CodeVia/skills/testing.md"]);
    Object.defineProperty(gh, "kind", { value: "real", configurable: true });
    await expect(
      c.agentManager.createProject({ description: "Session service", name: "No model", configRepo: "acme/no-model" }),
    ).rejects.toThrow(/active AI model/);
    expect(await gh.getFile({ owner: "acme", name: "no-model" }, "CodeVia/skills/testing.md", "main")).toBeUndefined();
  });

  it("does not commit a partially authored batch when the model response is malformed", async () => {
    const selected = await model("malformed", () => "{not JSON}");
    await copyPartial("malformed", ["CodeVia/skills/testing.md"], selected.model.id);
    await expect(
      c.agentManager.createProject({ description: "Session service", name: "Malformed", configRepo: "acme/malformed" }),
    ).rejects.toThrow();
    expect(await gh.getFile({ owner: "acme", name: "malformed" }, "CodeVia/skills/testing.md", "main")).toBeUndefined();
    expect(selected.requests).toHaveLength(1);
  });

  it("stops before a second model call when the configured initialization call budget is exhausted", async () => {
    const selected = await model();
    await expect(
      c.agentManager.createProject({
        description: "Session service",
        name: "One call",
        configRepo: "acme/one-call",
        defaultModelId: selected.model.id,
        settings: { ...p.settings, budget: { ...p.settings.budget, maxCallsPerRun: 1 } },
      }),
    ).rejects.toThrow(/Budget exceeded/);
    expect(selected.requests).toHaveLength(1);
    expect(await gh.getFile({ owner: "acme", name: "one-call" }, PROJECT_FILE, "main")).toBeUndefined();
  });

  it("aborts a slow authoring call and never commits its late response", async () => {
    let release!: (value: string) => void;
    const selected = await model(
      "slow",
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    await copyPartial("slow", ["CodeVia/skills/testing.md"], selected.model.id);
    const path = PROJECT_FILE,
      source = await gh.getFile({ owner: "acme", name: "slow" }, path, "main");
    const parsed = parseMatter(source!.content);
    (parsed.data.definition as Project).settings.budget.maxDurationMs = 100;
    await gh.commit({ owner: "acme", name: "slow" }, "main", "Set budget", [
      { path, content: matter(parsed.data, parsed.body.replace(/^\n/, "")) },
    ]);
    await expect(
      c.agentManager.createProject({ description: "Session service", name: "Slow", configRepo: "acme/slow" }),
    ).rejects.toThrow(/duration/);
    expect(selected.requests[0].signal?.aborted).toBe(true);
    release("{}");
    await new Promise<void>((r) => setImmediate(r));
    expect(await gh.getFile({ owner: "acme", name: "slow" }, "CodeVia/skills/testing.md", "main")).toBeUndefined();
  });
});

describe("repository-backed editing and reuse entry points", () => {
  it("writes and reloads a second agent of the same type without a path collision", async () => {
    const srv = await server();
    const original = c.agentRepo.byType(p.id, "research")!;
    const response = await srv.inject({
      method: "POST",
      url: "/agents",
      payload: {
        projectId: p.id,
        type: "research",
        name: "Independent researcher",
        systemPrompt: "Human prompt",
        enabled: false,
        tools: [],
        permissions: [],
      },
    });
    expect(response.statusCode).toBe(201);
    const agent = response.json() as Agent;
    expect(agent.configPath).not.toBe(original.configPath);
    await c.agentManager.onboardProject(p.id);
    expect(c.agentRepo.findById(agent.id)?.data).toMatchObject({
      enabled: false,
      systemPrompt: "Human prompt",
      tools: [],
      permissions: [],
    });
    expect(await get(original.configPath!)).not.toContain("Human prompt");
    expect(await get(agent.configPath!)).toContain("Human prompt");
  });

  it("uses AI for a new skill with omitted instructions but leaves supplied text untouched", async () => {
    const selected = await model();
    await c.agentManager.saveProject({ ...p, defaultModelId: selected.model.id });
    const srv = await server();
    const generated = (
      await srv.inject({
        method: "POST",
        url: "/skills",
        payload: { projectId: p.id, slug: "sessions", name: "Session contract" },
      })
    ).json() as Skill;
    expect(generated.instructions).toContain("AI skill:sessions");
    expect(selected.requests).toHaveLength(1);
    const manual = (
      await srv.inject({
        method: "POST",
        url: "/skills",
        payload: { projectId: p.id, slug: "manual", name: "Manual", instructions: "EXACT HUMAN KNOWLEDGE" },
      })
    ).json() as Skill;
    expect(manual.instructions).toBe("EXACT HUMAN KNOWLEDGE");
    expect(selected.requests).toHaveLength(1);
    expect(parseSkillFile(await get("CodeVia/skills/manual.md")).instructions).toBe(manual.instructions);
  });

  it("authors a skill for project technology that has no built-in template", async () => {
    const selected = await model();
    const next = await c.agentManager.createProject({
      name: "Rust service",
      description: "Typed session API",
      configRepo: "acme/rust",
      defaultModelId: selected.model.id,
      capabilities: { languages: ["rust"], frameworks: ["axum"] },
    });
    expect(c.skillRepo.findBySlug("axum")).toBeUndefined();
    expect(c.skillRepo.findBySlug("axum", next.id)?.instructions).toContain("AI skill:axum");
  });

  it("persists memory create, edit, rename and delete through the API", async () => {
    const srv = await server();
    const created = (
      await srv.inject({
        method: "POST",
        url: "/memory",
        payload: { projectId: p.id, type: "decision", key: "before", content: body, refs: ["source"] },
      })
    ).json() as MemoryEntry;
    const edited = (
      await srv.inject({ method: "PATCH", url: `/memory/${created.id}`, payload: { key: "after", tags: ["updated"] } })
    ).json() as MemoryEntry;
    expect(edited.id).not.toBe(created.id);
    expect(edited.content).toBe(body);
    expect(edited.version).toBe(2);
    expect((await c.projectFiles.pull(p)).memory[0]).toMatchObject({ key: "after", content: body, refs: ["source"] });
    expect((await srv.inject({ method: "DELETE", url: `/memory/${edited.id}` })).statusCode).toBe(200);
    await c.agentManager.onboardProject(p.id);
    expect(c.memoryRepo.byProject(p.id)).toEqual([]);
  });

  it("persists conversation messages and workflow deletion instead of reviving them on Pull", async () => {
    const srv = await server();
    const conv = (
      await srv.inject({
        method: "POST",
        url: "/conversations",
        payload: { projectId: p.id, title: "Continuity", userId: "local-user" },
      })
    ).json();
    const added = await srv.inject({
      method: "POST",
      url: `/conversations/${conv.id}/messages`,
      payload: { role: "user", content: "Remember the existing contract" },
    });
    expect(added.statusCode).toBe(200);
    c.conversationRepo.deleteById(conv.id);
    await c.agentManager.readProject(p.id);
    expect(c.conversationRepo.findById(conv.id)?.data.messages[0].content).toBe("Remember the existing contract");
    const w = c.workflowRepo.byProject(p.id)[0];
    expect((await srv.inject({ method: "DELETE", url: `/workflows/${w.id}` })).statusCode).toBe(200);
    await c.agentManager.onboardProject(p.id);
    expect(c.workflowRepo.findById(w.id)).toBeUndefined();
    expect((await srv.inject({ method: "DELETE", url: `/conversations/${conv.id}` })).statusCode).toBe(200);
    await c.agentManager.readProject(p.id);
    expect(c.conversationRepo.findById(conv.id)).toBeUndefined();
  });

  it("saves task edits/deletes and does not resurrect an intentionally deleted task", async () => {
    const srv = await server();
    const task = (
      await srv.inject({ method: "POST", url: "/tasks", payload: { projectId: p.id, title: "Old" } })
    ).json();
    expect(
      (await srv.inject({ method: "PATCH", url: `/tasks/${task.id}`, payload: { title: "New title" } })).statusCode,
    ).toBe(200);
    expect(await get(`CodeVia/tasks/${task.id}.md`)).toContain("New title");
    expect((await srv.inject({ method: "DELETE", url: `/tasks/${task.id}` })).statusCode).toBe(200);
    await c.agentManager.readProject(p.id);
    expect(c.taskRepo.findById(task.id)).toBeUndefined();
  });

  it("refreshes a direct runner before using an agent snapshot held by its caller", async () => {
    const a = c.agentRepo.byType(p.id, "research")!;
    const task = c.agentManager.createTask({ projectId: p.id, title: "Read", description: "" });
    await c.agentManager.syncTaskFile(p.id, task);
    await edit(a.configPath!, renderAgentFile({ ...a, enabled: false }));
    const execute = vi.spyOn(c.toolRegistry, "execute");
    await expect(c.agentRunner.run({ project: p, agent: a, task })).rejects.toThrow(/disabled/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves raw legacy memory before the first v2 update", async () => {
    const legacy =
      "# Legacy notes\n\n## decision\n\n### contract (v1)\n_tags: api · updated: 2026-01-01 · source: human_\n\nFirst line\n\n## Risks\nDo not drop this nested section.\n";
    await edit(MEMORY_FILE, legacy);
    const store = new CodeViaMemoryStore(c.projectFiles, p);
    await store.update({
      type: "knowledge",
      key: "new-note",
      scope: "project",
      content: "A new finding",
      refs: [],
      tags: [],
    });
    expect(c.memoryRepo.byProject(p.id).find((m) => m.key === "_legacy/CodeVia-memory.md")?.content).toBe(legacy);
  });

  it("rejects cyclic skill dependencies instead of hiding broken canonical definitions", async () => {
    await gh.commit(ref(), p.branch, "Broken graph", [
      { path: "CodeVia/skills/a.md", content: renderSkillFile(customSkill("a", { dependencies: ["b"] })) },
      { path: "CodeVia/skills/b.md", content: renderSkillFile(customSkill("b", { dependencies: ["a"] })) },
    ]);
    await expect(c.agentManager.onboardProject(p.id)).rejects.toThrow(/circular skill dependency/);
  });
});

describe("state webhook loop guard", () => {
  it("ignores only fully described state-only pushes, not mixed or truncated change sets", () => {
    const commit = { added: ["CodeVia/skills/session.md"], modified: ["CodeVia/memory.md"], removed: [] };
    expect(isStateOnlyPush({ commits: [commit] })).toBe(true);
    expect(isStateOnlyPush({ commits: [{ ...commit, modified: ["src/session.ts"] }] })).toBe(false);
    expect(isStateOnlyPush({ commits: [commit], size: 2 })).toBe(false);
    expect(isStateOnlyPush({ commits: [{ message: "[CodeVia] not enough evidence" }] })).toBe(false);
  });

  it("refreshes state-only webhook changes without enqueuing a new agent task", async () => {
    const before = c.taskRepo.byProject(p.id).length;
    const result = await c.githubAutomation.handle({
      id: "event-state",
      name: "github.push",
      correlationId: "state-loop",
      timestamp: p.createdAt,
      payload: {
        body: {
          repository: { full_name: p.configRepo },
          ref: "refs/heads/main",
          commits: [{ added: [], modified: ["CodeVia/memory.md"], removed: [] }],
        },
      },
    } as Parameters<typeof c.githubAutomation.handle>[0]);
    expect(result).toEqual([]);
    expect(c.taskRepo.byProject(p.id)).toHaveLength(before);
  });
});

it("validates manual writes before committing, leaving the previous valid definition usable", async () => {
  const srv = await server();
  const a = c.agentRepo.byType(p.id, "research")!;
  const previous = await get(a.configPath!);
  const result = await srv.inject({ method: "PATCH", url: `/agents/${a.id}`, payload: { skills: "not an array" } });
  expect(result.statusCode).toBe(422);
  expect(await get(a.configPath!)).toBe(previous);
  await c.agentManager.readProject(p.id);
  expect(c.agentRepo.findById(a.id)?.data.skills).toEqual(a.skills);
});

it("reads ordinary YAML blocks as well as generated JSON-valued front matter", () => {
  const text =
    "---\nname: Human edit\nrules:\n  - Preserve interfaces\n  - Keep tests deterministic\ninstructions: |\n  # Steps\n  Keep the full paragraph.\n---\n\nBody";
  expect(parseMatter(text).data).toMatchObject({
    rules: ["Preserve interfaces", "Keep tests deterministic"],
    instructions: "# Steps\nKeep the full paragraph.\n",
  });
  expect(() => parseMatter('---\nname: "unterminated\n---\n')).toThrow();
});

it("rebinds execution-history references when the folder is copied into another project", async () => {
  const task = c.agentManager.createTask({
    projectId: p.id,
    title: "Inspect API",
    description: "Check session contract",
    agentType: "research",
  });
  await c.agentManager.runTask(task.id);
  await copyPartial("history-copy", []);
  const next = await c.agentManager.createProject({
    name: "History copy",
    description: "Reusing the existing folder",
    configRepo: "acme/history-copy",
  });
  const restored = c.taskRepo.byProject(next.id).find((t) => t.title === task.title)!;
  expect(restored.id).not.toBe(task.id);
  const run = c.runRepo.byTask(restored.id)[0];
  expect(run.projectId).toBe(next.id);
  expect(restored.result?.runId).toBe(run.id);
  expect(c.agentRepo.findById(run.agentId)?.data.projectId).toBe(next.id);
});

describe("prompt history is repository state, not a local-only index", () => {
  const historyPath = () => `${PROMPT_HISTORY_DIR}/research.md`;

  it("persists baseline, edits, diff and restore and reloads versions after the index is wiped", async () => {
    const srv = await server();
    const a = c.agentRepo.byType(p.id, "research")!;
    const baseline = c.promptVersionRepo.forAgent(a.id)[0];
    expect(baseline.systemPrompt).toBe(a.systemPrompt);
    expect(
      (
        await srv.inject({
          method: "PATCH",
          url: `/agents/${a.id}`,
          payload: { systemPrompt: "NEW OBSERVED PROMPT", projectPrompt: "وظیفهٔ اختصاصی", note: "human edit" },
        })
      ).statusCode,
    ).toBe(200);
    const persisted = parsePromptHistory(await get(historyPath()));
    expect(persisted.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(persisted.versions[1]).toMatchObject({
      systemPrompt: "NEW OBSERVED PROMPT",
      projectPrompt: "وظیفهٔ اختصاصی",
      note: "human edit",
    });
    c.promptVersionRepo.deleteByProject(p.id);
    const versions = (await srv.inject({ method: "GET", url: `/agents/${a.id}/prompt-versions` })).json();
    expect(versions).toHaveLength(2);
    expect(versions[1].current).toBe(true);
    const diff = await srv.inject({ method: "GET", url: `/agents/${a.id}/prompt-versions/diff?from=1&to=2` });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().summary.added).toBeGreaterThan(0);
    expect(
      (await srv.inject({ method: "POST", url: `/agents/${a.id}/prompt-versions/1/restore`, payload: {} })).statusCode,
    ).toBe(200);
    expect(parsePromptHistory(await get(historyPath())).versions[2]).toMatchObject({
      version: 3,
      derivedFrom: 1,
      source: "restore",
      systemPrompt: baseline.systemPrompt,
    });
    const commits = vi.spyOn(gh, "commit");
    await c.agentManager.onboardProject(p.id);
    await c.agentManager.onboardProject(p.id);
    expect(commits).not.toHaveBeenCalled();
  });

  it("restores complete prompt versions into a separate empty database", async () => {
    const srv = await server();
    const a = c.agentRepo.byType(p.id, "research")!;
    await srv.inject({ method: "PATCH", url: `/agents/${a.id}`, payload: { systemPrompt: body } });
    const expected = c.promptVersionRepo.forAgent(a.id);
    const db = new Db(":memory:");
    try {
      const repositories = {
        projectRepo: new ProjectRepository(db),
        agentRepo: new AgentRepository(db),
        taskRepo: new TaskRepository(db),
        memoryRepo: new MemoryRepository(db),
        promptVersionRepo: new PromptVersionRepository(db),
      };
      const files = new ProjectFilesService({ github: gh, repositories, transaction: (fn) => db.tx(fn) });
      await files.restore(p);
      expect(repositories.promptVersionRepo.forAgent(a.id)).toEqual(expected);
    } finally {
      db.close();
    }
  });

  it("migrates genuine local-only versions without calling AI or replacing existing definitions", async () => {
    const source = await c.projectFiles.pull(p);
    gh.seedRepo("acme", "legacy-history", {
      files: [...source.contents]
        .filter(([path]) => !path.startsWith("CodeVia/prompts/"))
        .map(([path, content]) => ({ path, content })),
    });
    const legacy = {
      ...p,
      id: "legacy-history-project",
      slug: "legacy-history",
      configRepo: "acme/legacy-history",
      repositories: [{ repo: "acme/legacy-history", branch: "main", role: "primary" as const, isConfigRepo: true }],
    };
    c.projectRepo.upsert(legacy, { key: legacy.slug });
    await c.projectFiles.restore(legacy);
    const a = c.agentRepo.byType(legacy.id, "research")!;
    c.promptVersionRepo.snapshot({ ...a, systemPrompt: "A genuine older local prompt" }, { source: "legacy-web" });
    c.promptVersionRepo.snapshot(a, { source: "legacy-web" });
    const expected = c.promptVersionRepo.forAgent(a.id).map(({ repositoryRevision, ...v }) => v);
    const definition = await get(a.configPath!, legacy),
      generate = vi.spyOn(ProjectStateGenerator.prototype, "generate");
    await c.agentManager.onboardProject(legacy.id);
    expect(parsePromptHistory(await get(historyPath(), legacy)).versions).toEqual(expected);
    expect(await get(a.configPath!, legacy)).toBe(definition);
    expect(generate).not.toHaveBeenCalled();
    expect(await gh.getFile(ref(legacy), PROMPT_HISTORY_INDEX, legacy.branch)).toBeDefined();
  });

  it("treats Git as authoritative over a stale prompt history cache, without activating an old version", async () => {
    const a = c.agentRepo.byType(p.id, "research")!,
      original = await get(a.configPath!);
    const history = parsePromptHistory(await get(historyPath()));
    history.versions[0].systemPrompt = "Historical correction made in Git";
    await edit(historyPath(), renderPromptHistory(history));
    const srv = await server();
    const versions = (await srv.inject({ method: "GET", url: `/agents/${a.id}/prompt-versions` })).json();
    expect(versions[0].systemPrompt).toBe("Historical correction made in Git");
    expect(versions[0].current).toBe(false);
    expect(await get(a.configPath!)).toBe(original);
  });

  it("does not invent or recreate versions in an intentionally empty or removed history", async () => {
    const srv = await server();
    const a = c.agentRepo.byType(p.id, "research")!;
    await edit(historyPath(), renderPromptHistory({ projectId: p.id, agentId: a.id, versions: [] }));
    expect((await srv.inject({ method: "GET", url: `/agents/${a.id}/prompt-versions` })).json()).toEqual([]);
    await edit(historyPath(), matter({ schemaVersion: 2, deleted: true }, "Removed intentionally"));
    const commit = vi.spyOn(gh, "commit");
    await c.agentManager.onboardProject(p.id);
    expect((await srv.inject({ method: "GET", url: `/agents/${a.id}/prompt-versions` })).json()).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
    // An explicit new edit can begin a new observed history; reads cannot.
    expect(
      (await srv.inject({ method: "PATCH", url: `/agents/${a.id}`, payload: { systemPrompt: "Explicit new change" } }))
        .statusCode,
    ).toBe(200);
    expect(parsePromptHistory(await get(historyPath())).versions.at(-1)?.systemPrompt).toBe("Explicit new change");
  });

  it("does not retain an unpublished history version after a Git write failure", async () => {
    const srv = await server();
    const a = c.agentRepo.byType(p.id, "research")!,
      old = await get(historyPath());
    const versions = c.promptVersionRepo.forAgent(a.id);
    vi.spyOn(gh, "commit").mockRejectedValue(new Error("permission denied"));
    expect(
      (
        await srv.inject({
          method: "PATCH",
          url: `/agents/${a.id}`,
          payload: { systemPrompt: "MUST NOT BECOME HISTORY" },
        })
      ).statusCode,
    ).toBe(502);
    expect(await get(historyPath())).toBe(old);
    expect(c.promptVersionRepo.forAgent(a.id)).toEqual(versions);
    expect(c.agentRepo.findById(a.id)?.data.systemPrompt).toBe(a.systemPrompt);
  });

  it("validates history namespaces before changing any cached records", async () => {
    const a = c.agentRepo.byType(p.id, "research")!,
      versions = c.promptVersionRepo.forAgent(a.id);
    const history = parsePromptHistory(await get(historyPath()));
    history.versions[0].agentId = "unrelated-agent";
    await edit(historyPath(), matter({ schemaVersion: 2, promptHistory: history }, "Bad namespace"));
    await expect(c.agentManager.readProject(p.id)).rejects.toThrow(/different history/);
    expect(c.promptVersionRepo.forAgent(a.id)).toEqual(versions);
  });

  it("rebinds version identities when a repository folder is copied", async () => {
    const a = c.agentRepo.byType(p.id, "research")!,
      old = c.promptVersionRepo.forAgent(a.id);
    await copyPartial("prompt-copy", []);
    const next = await c.agentManager.createProject({
      name: "Prompt copy",
      description: "Reuse",
      configRepo: "acme/prompt-copy",
    });
    const copied = c.agentRepo.byType(next.id, "research")!,
      versions = c.promptVersionRepo.forAgent(copied.id);
    expect(versions).toHaveLength(old.length);
    expect(versions[0]).toMatchObject({ projectId: next.id, agentId: copied.id, systemPrompt: old[0].systemPrompt });
    expect(versions[0].id).not.toBe(old[0].id);
    await c.agentManager.syncProjectState(next.id);
    await c.agentManager.readProject(next.id);
    expect(c.promptVersionRepo.forAgent(copied.id)).toHaveLength(old.length);
    expect(c.promptVersionRepo.forAgent(a.id)).toEqual(old);
  });
});

describe("automatic discovery completes only needed skill dependencies", () => {
  it("authors absent dependencies of an enabled Git-added skill before it is attached", async () => {
    const selected = await model();
    await c.agentManager.saveProject({ ...p, defaultModelId: selected.model.id });
    const skill = customSkill("new-git-skill", { dependencies: ["new-prerequisite"] });
    const existing = renderSkillFile(skill);
    await edit("CodeVia/skills/new-git-skill.md", existing);
    await c.agentManager.onboardProject(p.id);
    expect(selected.requests).toHaveLength(1);
    expect(c.skillRepo.findBySlug("new-prerequisite", p.id)?.instructions).toContain("AI skill:new-prerequisite");
    expect(await get("CodeVia/skills/new-git-skill.md")).toBe(existing);
    expect(c.projectRepo.findById(p.id)?.data.settings.skills).not.toContain(skill.slug);
    await c.agentManager.onboardProject(p.id);
    expect(selected.requests).toHaveLength(1);
  });

  it("does not spend AI budget filling dependencies of disabled Git definitions", async () => {
    const selected = await model();
    const skill = customSkill("disabled-git-skill", { enabled: false, dependencies: ["must-stay-absent"] });
    await edit("CodeVia/skills/disabled-git-skill.md", renderSkillFile(skill));
    await c.agentManager.onboardProject(p.id);
    expect(selected.requests).toHaveLength(0);
    expect(await gh.getFile(ref(), "CodeVia/skills/must-stay-absent.md", p.branch)).toBeUndefined();
  });
});
