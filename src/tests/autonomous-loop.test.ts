import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Container } from "../app/container.js";
import { AutonomousOrchestrator, deterministicBreakdown, deterministicBrief, type PhaseExecutor } from "../agents/orchestrator.js";
import { extractJson } from "../agents/llm.js";
import type { Agent, Project, Run, Task } from "../domain/entities.js";
import type { IModelProvider } from "../ai/types.js";
import { ProviderRegistry } from "../ai/provider-registry.js";
import { MockGitHubService } from "../github/mock-service.js";
import { CONTEXT_FILE, MEMORY_FILE } from "../github/project-files.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Autonomous task loop: task → research → breakdown → implementers
 * (code → git → PR) → QA gate → bounded fix loop → done.
 * ------------------------------------------------------------------ */

function stubRun(task: Task, status: Run["status"], failedLabel?: string): Run {
  return {
    id: `run-${task.id}`,
    taskId: task.id,
    projectId: task.projectId,
    agentType: task.agentType ?? "backend-developer",
    status,
    steps: failedLabel
      ? [{ index: 0, label: "Do work", status: "running" }, { index: 1, label: failedLabel, status: "failed", detail: "boom: assertion failed", data: task.agentType === "qa-test" ? { verification: "failed", fixable: true } : undefined }]
      : [{ index: 0, label: "Do work", status: "succeeded" }],
  } as Run;
}

describe("extractJson", () => {
  it("parses raw JSON", () => {
    expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it("parses fenced JSON", () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
  it("extracts JSON embedded in prose", () => {
    expect(extractJson('Here you go: {"a": [1,2]} thanks')).toEqual({ a: [1, 2] });
  });
  it("returns undefined for non-JSON", () => {
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
  });
});

describe("deterministicBreakdown", () => {
  const project = { capabilities: {} } as Project;
  const task = (title: string, description = ""): Task => ({ id: "t1", title, description }) as Task;

  it("always includes a backend implementer", () => {
    const items = deterministicBreakdown(project, task("Add login API", "REST endpoint"));
    expect(items.map((i) => i.agentType)).toContain("backend-developer");
  });
  it("adds frontend for UI-ish work", () => {
    const items = deterministicBreakdown(project, task("Fix the login page layout on mobile"));
    expect(items.map((i) => i.agentType)).toEqual(expect.arrayContaining(["backend-developer", "frontend-developer"]));
  });
  it("adds database for schema-ish work", () => {
    const items = deterministicBreakdown(project, task("Add user migration", "new table for sessions"));
    expect(items.map((i) => i.agentType)).toContain("database");
  });
  it("targets one file per item", () => {
    const items = deterministicBreakdown(project, task("Add login API"));
    for (const i of items) expect(i.files.length).toBeGreaterThanOrEqual(1);
  });
});

describe("deterministicBrief", () => {
  const project = {
    id: "p1", name: "Shop", slug: "shop", description: "store", branch: "main", configRepo: "acme/shop",
    repositories: [{ repo: "acme/shop", branch: "main", role: "primary", isConfigRepo: true }],
    capabilities: {
      platforms: ["web"], languages: ["csharp"], frameworks: ["dotnet"], databases: ["sqlserver"],
      deploymentTargets: ["docker"], features: ["auth"], integrations: ["telegram"], agentTypes: [],
    },
    settings: {}, active: true, createdAt: "", updatedAt: "",
  } as unknown as Project;
  const task = { id: "t1", title: "Add login page", description: "Build the login screen. Validate input." } as Task;

  it("distills requirements, areas, owners and embeds the definition selections", () => {
    const brief = deterministicBrief(project, task, ["src/a.ts"], "- Understand request: succeeded");
    expect(brief).toContain("Requirements:");
    expect(brief).toContain("Affected areas:");
    expect(brief).toContain("UI/pages");
    expect(brief).toContain("Suggested owners: backend-developer, frontend-developer");
    expect(brief).toContain("Platforms: web");
    expect(brief).toContain("Key features: auth");
    expect(brief).toContain("Standing risks:");
  });
});

describe("AutonomousOrchestrator with stub executor", () => {
  let fx: ReturnType<typeof freshDb>;
  let container: Container;

  beforeEach(async () => {
    fx = freshDb();
    container = new Container();
    await container.ensureSeed();
  });
  afterEach(() => fx.cleanup());

  function build(script: (task: Task, agent: Agent) => Run): AutonomousOrchestrator {
    const executor: PhaseExecutor = async (task, agent, _project, _plan) => script(task, agent);
    return new AutonomousOrchestrator({
      projectRepo: container.projectRepo,
      taskRepo: container.taskRepo,
      agentRepo: container.agentRepo,
      agentRunner: container.agentRunner,
      agentRouter: container.agentRouter,
      github: container.github,
      modelRepo: container.modelRepo,
      providerRepo: container.providerRepo,
      executor,
      maxFixLoops: 2,
    });
  }

  async function parentTask(): Promise<Task> {
    const project = await container.agentManager.createProject({
      name: "Loop App", description: "app", configRepo: "acme/loop",
    });
    return container.agentManager.createTask({
      projectId: project.id, title: "Add login page and API", description: "full login feature",
    });
  }

  it("runs research → build → QA and succeeds when QA passes", async () => {
    const parent = await parentTask();
    const seen: string[] = [];
    const orch = build((task) => {
      seen.push(`${task.agentType}:${task.title.slice(0, 12)}`);
      return stubRun(task, "succeeded");
    });
    const summary = await orch.run(parent.id);
    expect(summary.fixLoops).toBe(0);
    expect(summary.usedRealAi).toBe(false);
    expect(summary.buildTaskIds.length).toBeGreaterThanOrEqual(2); // backend + frontend
    expect(summary.qaTaskIds.length).toBe(1);
    expect(seen[0]).toMatch(/^research:/);
    const kids = container.taskRepo.findMany({ parentId: parent.id });
    expect(kids.length).toBe(1 + summary.buildTaskIds.length + summary.qaTaskIds.length);
    expect(kids.every((k) => k.data.status === "succeeded")).toBe(true);
  });

  it("routes QA failures back to an implementer and re-verifies", async () => {
    const parent = await parentTask();
    let qaRuns = 0;
    const orch = build((task) => {
      if (task.agentType === "qa-test") {
        qaRuns += 1;
        return stubRun(task, qaRuns === 1 ? "failed" : "succeeded", qaRuns === 1 ? "Run test suite" : undefined);
      }
      return stubRun(task, "succeeded");
    });
    const summary = await orch.run(parent.id);
    expect(summary.fixLoops).toBe(1);
    expect(summary.qaTaskIds.length).toBe(2);
    const kids = container.taskRepo.findMany({ parentId: parent.id }).map((k) => k.data);
    expect(kids.some((k) => k.title.startsWith("Fix (attempt 1)"))).toBe(true);
    expect(kids.filter((k) => k.agentType === "qa-test").length).toBe(2);
  });

  it("gives up after maxFixLoops and reports the QA error", async () => {
    const parent = await parentTask();
    const orch = build((task) => stubRun(task, task.agentType === "qa-test" ? "failed" : "succeeded", task.agentType === "qa-test" ? "Run test suite" : undefined));
    await expect(orch.run(parent.id)).rejects.toThrow(/QA still failing after 2 fix loop/);
    const kids = container.taskRepo.findMany({ parentId: parent.id }).map((k) => k.data);
    expect(kids.filter((k) => k.title.startsWith("Fix (attempt")).length).toBe(2);
    expect(kids.filter((k) => k.agentType === "qa-test").length).toBe(3);
  });

  it("fails the preflight checklist when research is unavailable", async () => {
    const parent = await parentTask();
    const research = container.agentRepo.byType(parent.projectId, "research")!;
    container.agentRepo.upsert({ ...research, enabled: false }, { projectId: parent.projectId });
    const orch = build((task) => stubRun(task, "succeeded"));
    await expect(orch.run(parent.id)).rejects.toThrow(/preflight[\s\S]*research/);
  });

  it("specifies each unit's duty and attaches the research brief", async () => {
    const parent = await parentTask();
    const orch = build((task) => stubRun(task, "succeeded"));
    await orch.run(parent.id);
    const kids = container.taskRepo.findMany({ parentId: parent.id }).map((k) => k.data);
    for (const k of kids) {
      if (k.agentType === "research") continue;
      expect(k.description, `${k.agentType} duty`).toContain("Your duty:");
      expect(k.description, `${k.agentType} brief`).toContain("Research brief:");
    }
    const reloaded = container.taskRepo.findById(parent.id)!.data;
    expect(String(reloaded.input.researchBrief ?? "")).toContain("Research brief for");
  });

  it("fails fast when an implementer fails", async () => {
    const parent = await parentTask();
    const orch = build((task) => stubRun(task, task.agentType === "backend-developer" ? "failed" : "succeeded", task.agentType === "backend-developer" ? "Implement the change" : undefined));
    await expect(orch.run(parent.id)).rejects.toThrow(/failed/);
  });
});

describe("autonomous loop end-to-end (mock AI + mock GitHub)", () => {
  let fx: ReturnType<typeof freshDb>;
  let container: Container;

  beforeEach(async () => {
    fx = freshDb();
    container = new Container();
    await container.ensureSeed();
  });
  afterEach(() => fx.cleanup());

  it("completes a task through research, implementers, git and QA", async () => {
    const project = await container.agentManager.createProject({
      name: "E2E App", description: "A web app", configRepo: "acme/e2e",
    });
    const task = container.agentManager.createTask({
      projectId: project.id,
      title: "Add login page and API",
      description: "Build the login screen and the session endpoint",
      input: { executionMode: "autonomous" },
    });
    const done = await container.agentManager.runTask(task.id);
    expect(done.status).toBe("succeeded");

    const kids = container.taskRepo.findMany({ parentId: task.id }).map((k) => k.data);
    const types = kids.map((k) => k.agentType);
    expect(types).toContain("research");
    expect(types).toContain("backend-developer");
    expect(types).toContain("frontend-developer");
    expect(types).toContain("qa-test");
    expect(kids.every((k) => k.status === "succeeded")).toBe(true);

    // The research brief (with the definition selections) is stored on the
    // parent and every unit's subtask states its duty explicitly.
    const reloaded = container.taskRepo.findById(task.id)!.data;
    expect(String(reloaded.input.researchBrief ?? "")).toContain("Research brief for");
    expect(String(reloaded.input.researchBrief ?? "")).toContain("Project: E2E App");
    for (const k of kids) {
      if (k.agentType === "research") continue;
      expect(k.description).toContain("Your duty:");
      expect(k.description).toContain("Research brief:");
    }

    // Every phase produced a successful run…
    const runs = container.runRepo.byProject(project.id);
    expect(runs.length).toBeGreaterThanOrEqual(kids.length);
    expect(runs.every((r) => r.status === "succeeded")).toBe(true);

    // …and the implementers committed real scaffolds on per-subtask
    // branches + opened PRs from those branches on GitHub.
    const [owner, ...rest] = project.configRepo.split("/");
    const repo = { owner, name: rest.join("/") };
    const pulls = await container.github.listPullRequests(repo);
    expect(pulls.length).toBe(1);
    expect(done.result?.verification).toBe("simulated");
    const branches = (await container.github.listBranches(repo)).map((b) => b.name);
    for (const pr of pulls) {
      // Every PR head is a branch that actually exists (no dangling PRs).
      expect(branches).toContain(pr.head);
      expect(pr.head.startsWith("agent-")).toBe(true);
      const branchFiles = await container.github.listFiles(repo, pr.head);
      // Scaffolded source file + traceability note side by side.
      expect(branchFiles.some((f) => f.path.includes(task.id) && f.path.startsWith("docs/tasks/"))).toBe(true);
      const code = branchFiles.find((f) => /\.(ts|tsx|cs|py|java|php|go|vue|sql)$/.test(f.path));
      expect(code).toBeTruthy();
      const body = (await container.github.getFile(repo, code!.path, pr.head))?.content ?? "";
      expect(body).toContain("TODO");
      expect(body).toContain("Scaffolded by");
    }
  }, 60000);
});

describe("autonomous loop with simulated real AI (canned provider, no network)", () => {
  let fx: ReturnType<typeof freshDb>;
  let container: Container;
  const prompts: Array<{ system: string; user: string }> = [];
  let breakdownJson = "[]";

  function cannedRuntime(providerId: string): IModelProvider {
    return {
      id: providerId,
      type: "openai",
      name: "Canned",
      chat: async (req) => {
        const system = req.messages.find((m) => m.role === "system")?.content ?? "";
        const user = req.messages.find((m) => m.role === "user")?.content ?? "";
        prompts.push({ system, user });
        let content = "canned";
        if (system.includes("business analyst")) content = "CANNED BRIEF: throttle logins, reuse the login handler.";
        else if (system.includes("engineering manager")) content = breakdownJson;
        else if (user.includes("--- START CURRENT FILE ---")) {
          content = JSON.stringify({ edits: [{ oldText: "public class LoginHandler {}", newText: "public class LoginHandler { public bool Throttle() => true; }" }] });
        } else {
          const target = user.match(/complete content of "([^"]+)"/)?.[1] ?? "file";
          content = target.startsWith("docs/tasks/")
            ? `# note for ${target}\n\ncanned note\n`
            : `// CANNED CODE for ${target}\n// built on existing project context\npublic class Canned {}\n`;
        }
        return { content, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, modelId: req.modelId, providerId };
      },
      listModels: async () => [],
      resolveApiKey: () => undefined,
      health: async () => true,
    };
  }

  beforeEach(async () => {
    fx = freshDb();
    container = new Container();
    await container.ensureSeed();
    prompts.length = 0;
  });
  afterEach(() => fx.cleanup());

  /** Real AI path, end to end: canned model drives breakdown + codegen. */
  it("reads context, remaps invented paths to owned files, commits model output", async () => {
    const project = await container.agentManager.createProject({
      name: "Canned App", description: "d", configRepo: "acme/canned",
      capabilities: { languages: ["csharp"], frameworks: ["dotnet"] } as Project["capabilities"],
    });
    const gh = container.github as unknown as MockGitHubService;
    const ref = { owner: "acme", name: "canned" };
    const owned = "src/CannedApp.Api/Handlers/LoginHandler.cs";

    // Merged reality: a handwritten login handler + a registry claiming it.
    await gh.commit(ref, "main", "handwritten login", [{ path: owned, content: "// HANDWRITTEN v1\npublic class LoginHandler {}\n" }]);
    await gh.commit(ref, "main", "seed context", [{
      path: CONTEXT_FILE,
      content: `---\nregistry: {"Login":{"entity":"Login","path":"${owned}","paths":{"backend-developer":"${owned}"},"agentType":"backend-developer","subtaskId":"task-old","at":"t"}}\n---\n\n# ctx\n`,
    }]);
    // External memory edit in git (never synced to the DB) — pre-sync must adopt it.
    await gh.commit(ref, "main", "external memory edit", [{
      path: MEMORY_FILE,
      content: `---\nupdatedAt: "t"\ncount: 1\n---\n\n# Project memory (1)\n\n## decision\n\n### auth.strategy (v1)\n_tags: auth · updated: t · source: human_\n\nUse JWT everywhere\n`,
    }]);

    // The model invents a parallel path for the already-owned Login entity…
    breakdownJson = JSON.stringify([{
      agentType: "backend-developer", title: "Implement login throttling",
      description: "Throttle login attempts", files: ["src/Invented/LoginStuff.cs"],
    }]);

    const provider = container.providerRepo.create({
      name: "Canned", type: "openai", authType: "none", apiFormat: "openai",
      timeoutMs: 1000, maxTokensDefault: 1000, defaultTemperature: 0, rateLimitPerMinute: 100, active: true,
    });
    container.modelRepo.create({
      providerId: provider.id, modelId: "canned-1", displayName: "Canned",
      contextWindow: 8000, inputCostPer1k: 0, outputCostPer1k: 0,
      capabilities: { vision: false, tools: false, structuredOutput: true, code: true, reasoning: true, streaming: false },
      active: true, priority: 1, fallbackPriority: 1, tags: [],
    });
    const registry = new ProviderRegistry();
    registry.register(cannedRuntime(provider.id));

    const task = container.agentManager.createTask({
      projectId: project.id, title: "Add login rate limiting", description: "Throttle login attempts",
    });
    const orch = new AutonomousOrchestrator({
      projectRepo: container.projectRepo,
      taskRepo: container.taskRepo,
      agentRepo: container.agentRepo,
      agentRunner: container.agentRunner,
      agentRouter: container.agentRouter,
      github: container.github,
      modelRepo: container.modelRepo,
      providerRepo: container.providerRepo,
      providerRegistry: registry,
      files: container.projectFiles,
      memoryRepo: container.memoryRepo,
    });
    const summary = await orch.run(task.id);
    expect(summary.usedRealAi).toBe(true);

    // The canned brief flowed into the parent task.
    expect(String(container.taskRepo.findById(task.id)!.data.input.researchBrief ?? "")).toContain("CANNED BRIEF");

    // Breakdown was told to reuse owned files…
    const bdPrompt = prompts.find((p) => p.system.includes("engineering manager"))?.user ?? "";
    expect(bdPrompt).toContain("Reuse the exact existing files");
    expect(bdPrompt).toContain(owned);

    // …and the invented parallel path was remapped to the owned file: the
    // change landed on the SAME file, no duplicate was created.
    const prs = await gh.listPullRequests(ref);
    expect(prs.length).toBe(1);
    const branchFiles = (await gh.listFiles(ref, prs[0].head)).map((f) => f.path);
    expect(branchFiles).toContain(owned);
    expect(branchFiles).not.toContain("src/Invented/LoginStuff.cs");

    // Codegen saw the existing file content and its output was committed verbatim.
    const cgPrompt = prompts.find((p) => p.user.includes("--- START CURRENT FILE ---"))?.user ?? "";
    expect(cgPrompt).toContain("EXTEND it");
    expect(cgPrompt).toContain("HANDWRITTEN v1");
    expect((await gh.getFile(ref, owned, prs[0].head))?.content).toContain("public bool Throttle()");
    expect((await gh.getFile(ref, owned, prs[0].head))?.content).toContain("HANDWRITTEN v1");

    // Pre-sync adopted the external memory edit from git into the DB…
    expect(container.memoryRepo.byProject(project.id).map((m) => m.key)).toContain("auth.strategy");
    // …while the live task state stayed owned by the run (pre-sync skips
    // tasks): flip it to running mid-run semantics and confirm no clobber.
    container.taskRepo.upsert(
      { ...container.taskRepo.findById(task.id)!.data, status: "running" },
      { projectId: project.id, parentId: undefined },
    );
    const re = await container.projectFiles.restore(
      project,
      { projectRepo: container.projectRepo, agentRepo: container.agentRepo, taskRepo: container.taskRepo, memoryRepo: container.memoryRepo },
      { includeTasks: false },
    );
    expect(re.tasks).toBe(0);
    expect(container.taskRepo.findById(task.id)!.data.status).toBe("running");
  }, 90000);

  it("deterministic breakdown reuses registry-owned files", () => {
    const items = deterministicBreakdown(
      { capabilities: { languages: ["csharp"], frameworks: ["dotnet"] } } as Project,
      { id: "t1", title: "Add login rate limiting", description: "throttle" } as Task,
      { Login: { entity: "Login", path: "src/Custom/LoginHandler.cs", paths: { "backend-developer": "src/Custom/LoginHandler.cs" }, agentType: "backend-developer", subtaskId: "t", at: "t" } },
    );
    expect(items.find((i) => i.agentType === "backend-developer")!.files[0]).toBe("src/Custom/LoginHandler.cs");
  });

  it("pre-sync restore skips tasks but adopts agents/memory/skills", async () => {
    const project = await container.agentManager.createProject({ name: "Pre", description: "d", configRepo: "acme/pre" });
    const task = container.agentManager.createTask({ projectId: project.id, title: "T", description: "d" });
    await container.agentManager.syncProjectState(project.id);
    const gh = container.github as unknown as MockGitHubService;
    const ref = { owner: "acme", name: "pre" };

    // Rewrite the task file in git to a bogus status behind the DB's back.
    const taskFile = (await gh.getFile(ref, `CodeVia/tasks/${task.id}.md`, "main"))!.content;
    await gh.commit(ref, "main", "external task edit", [
      { path: `CodeVia/tasks/${task.id}.md`, content: taskFile.replace(/status: "[^"]*"/, `status: "failed"`) },
    ]);

    const summary = await container.projectFiles.restore(
      project,
      { projectRepo: container.projectRepo, agentRepo: container.agentRepo, taskRepo: container.taskRepo, memoryRepo: container.memoryRepo },
      { includeTasks: false },
    );
    expect(summary.tasks).toBe(0);
    expect(container.taskRepo.findById(task.id)!.data.status).not.toBe("failed");
  });
});
