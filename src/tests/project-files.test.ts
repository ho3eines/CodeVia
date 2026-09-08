import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { MockGitHubService } from "../github/mock-service.js";
import {
  ProjectFilesService,
  matter, parseMatter, parseSections,
  renderAgentFile, parseAgentFile,
  renderTaskFile, parseTaskFile,
  renderMemoryFile, parseMemoryFile,
  renderProjectFile,
  PROJECT_FILE, SKILLS_FILE, MEMORY_FILE,
} from "../github/project-files.js";
import type { Agent, MemoryEntry, Project, Task } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Project folder (CodeVia/*): manifest, units, skills, tasks and the
 * managed memory file live in the project's own repo and can be pulled
 * back into the database instead of re-fetching/regenerating.
 * ------------------------------------------------------------------ */

describe("front-matter", () => {
  it("round-trips JSON values losslessly", () => {
    const { data } = parseMatter(matter({ s: "a:b\nc", n: 3, b: false, nil: null, a: ["x", "y"], o: { k: "v" } }, "body"));
    expect(data).toEqual({ s: "a:b\nc", n: 3, b: false, nil: null, a: ["x", "y"], o: { k: "v" } });
  });

  it("returns empty data without a fence", () => {
    expect(parseMatter("no fence").data).toEqual({});
  });

  it("splits bodies on ## sections", () => {
    const secs = parseSections("# T\n\n## Request\nhello\n\n## Research brief\nbrief text\n");
    expect(secs["Request"]).toBe("hello");
    expect(secs["Research brief"]).toBe("brief text");
  });
});

function agent(): Agent {
  const now = new Date().toISOString();
  return {
    id: "a1", projectId: "p1", type: "research", name: "Research Agent", slug: "research",
    role: "Research", description: "mission", systemPrompt: "You are research.\nLine two.",
    skills: ["research"], tools: ["search"], permissions: ["github.read"],
    models: { primary: "m", fallbacks: ["f"], specialized: {} },
    maxIterations: 5, timeoutMs: 1000, tokenBudget: 100, memorySources: ["project"],
    enabled: true, version: 2, createdAt: now, updatedAt: now,
  };
}

function task(): Task {
  const now = new Date().toISOString();
  return {
    id: "task-1", projectId: "p1", title: "Do it", description: "Do the thing.\nCarefully.",
    status: "succeeded", agentType: "qa-test", correlationId: "c",
    input: { executionMode: "autonomous", researchBrief: "Brief body here" },
    createdAt: now, updatedAt: now,
  };
}

function memoryEntries(): MemoryEntry[] {
  const now = new Date().toISOString();
  const e = (type: MemoryEntry["type"], key: string, content: string): MemoryEntry => ({
    id: `m-${key}`, projectId: "p1", scope: "project", type, key, content,
    tags: ["t1"], refs: [], source: "web", version: 2, createdAt: now, updatedAt: now,
  });
  return [e("decision", "auth.strategy", "Use JWT."), e("bug", "login.crash", "Fixed null ref.\nMulti-line.")];
}

describe("render → parse round-trips", () => {
  it("agent file", () => {
    const a = agent();
    const p = parseAgentFile(renderAgentFile(a))!;
    expect(p.id).toBe("a1");
    expect(p.type).toBe("research");
    expect(p.enabled).toBe(true);
    expect(p.version).toBe(2);
    expect(p.tools).toEqual(["search"]);
    expect(p.models).toEqual(a.models);
    expect(p.systemPrompt).toBe("You are research.\nLine two.");
  });

  it("task file", () => {
    const p = parseTaskFile(renderTaskFile(task()))!;
    expect(p.id).toBe("task-1");
    expect(p.status).toBe("succeeded");
    expect(p.agentType).toBe("qa-test");
    expect(p.description).toBe("Do the thing.\nCarefully.");
    expect(p.researchBrief).toBe("Brief body here");
  });

  it("memory file (multi-type, multi-line)", () => {
    const parsed = parseMemoryFile(renderMemoryFile(memoryEntries()));
    expect(parsed.length).toBe(2);
    const bug = parsed.find((e) => e.key === "login.crash")!;
    expect(bug.type).toBe("bug");
    expect(bug.version).toBe(2);
    expect(bug.content).toBe("Fixed null ref.\nMulti-line.");
    expect(bug.tags).toEqual(["t1"]);
  });

  it("rejects files without identity", () => {
    expect(parseAgentFile("hello")).toBeUndefined();
    expect(parseTaskFile("hello")).toBeUndefined();
  });
});

describe("sync + pull + restore (mock GitHub)", () => {
  let fx: ReturnType<typeof freshDb>;
  let container: Container;

  beforeEach(async () => {
    fx = freshDb();
    container = new Container();
    await container.ensureSeed();
  });
  afterEach(() => fx.cleanup());

  it("syncs the whole folder in one commit and pulls it back", async () => {
    const project = await container.agentManager.createProject({ name: "Files", description: "d", configRepo: "acme/files" });
    const task = container.agentManager.createTask({ projectId: project.id, title: "T", description: "d" });
    await container.agentManager.syncProjectState(project.id);

    const files = new ProjectFilesService({ github: container.github });
    const pulled = await files.pull(project);
    expect(pulled.files).toContain(PROJECT_FILE);
    expect(pulled.files).toContain(SKILLS_FILE);
    expect(pulled.files).toContain(MEMORY_FILE);
    expect(pulled.files.some((f) => f === `CodeVia/agents/research.md`)).toBe(true);
    expect(pulled.files.some((f) => f === `CodeVia/tasks/${task.id}.md`)).toBe(true);
    expect(pulled.agents.length).toBeGreaterThan(5);
    expect(pulled.manifest?.slug).toBe(project.slug);

    const memBefore = container.memoryRepo.byProject(project.id).length;
    void memBefore;
  });

  it("restores wiped database state from the repo folder", async () => {
    const project = await container.agentManager.createProject({ name: "Restore", description: "d", configRepo: "acme/restore" });
    container.agentManager.createTask({ projectId: project.id, title: "T", description: "d" });
    container.memoryRepo.upsert(
      {
        id: "mem-1", projectId: project.id, scope: "project", type: "decision", key: "auth.strategy",
        content: "Use JWT", tags: ["auth"], refs: [], source: "web", version: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      { projectId: project.id, key: "auth.strategy" },
    );
    await container.agentManager.syncProjectState(project.id);

    // Simulate a fresh/empty database: wipe everything for the project…
    for (const a of container.agentRepo.byProject(project.id)) container.agentRepo.deleteById(a.id);
    for (const t of container.taskRepo.byProject(project.id)) container.taskRepo.deleteById(t.id);
    for (const m of container.memoryRepo.byProject(project.id)) container.memoryRepo.deleteById(m.id);
    expect(container.agentRepo.byProject(project.id).length).toBe(0);

    // …and pull it back from git.
    const summary = await container.projectFiles.restore(project, {
      projectRepo: container.projectRepo,
      agentRepo: container.agentRepo,
      taskRepo: container.taskRepo,
      memoryRepo: container.memoryRepo,
    });
    expect(summary.agents).toBeGreaterThan(5);
    expect(summary.tasks).toBe(1);
    expect(summary.memory).toBe(1);
    expect(container.agentRepo.byType(project.id, "research")?.enabled).toBe(true);
    expect(container.memoryRepo.byProject(project.id).map((m) => m.key)).toContain("auth.strategy");
    expect(container.taskRepo.byProject(project.id)[0].description).toBe("d");
  });

  it("manifest carries the definition brief and counts", async () => {
    const project = await container.agentManager.createProject({ name: "Manifest", description: "d", configRepo: "acme/manifest" });
    const content = await container.github.getFile({ owner: "acme", name: "manifest" }, PROJECT_FILE, "main");
    expect(content?.content).toContain("# Manifest — CodeVia project state");
    expect(content?.content).toContain("## Units (");
    expect(content?.content).toContain("## Skills (");
    void renderProjectFile;
  });

  it("delete purges the repo folder so a new project on the same repo starts clean", async () => {
    // Create a project on a repo, let onboarding write CodeVia/* to the mock repo.
    const first = await container.agentManager.createProject({ name: "Delete Me", description: "stale state", configRepo: "acme/reuse" });
    await container.agentManager.syncProjectState(first.id);
    expect((await container.github.getFile({ owner: "acme", name: "reuse" }, PROJECT_FILE, "main"))?.content).toContain("Delete Me");

    // Delete it (DB + repository state).
    container.projectRepo.deleteById(first.id);
    await container.projectFiles.removeProject(first);

    // The CodeVia/* folder is gone from the repo — a later project on the same
    // repo must NOT resurrect the deleted project's name/description.
    const files = await container.github.listFiles({ owner: "acme", name: "reuse" }, "main", "CodeVia");
    expect(files.filter((f) => f.path.startsWith("CodeVia/")).length).toBe(0);

    // Recreate on the same repo: the new project's own definition must win.
    const second = await container.agentManager.createProject({ name: "Fresh Start", description: "clean", configRepo: "acme/reuse" });
    const stored = container.projectRepo.findById(second.id)?.data;
    expect(stored?.name).toBe("Fresh Start");
    expect(stored?.description).toBe("clean");
    expect((await container.github.getFile({ owner: "acme", name: "reuse" }, PROJECT_FILE, "main"))?.content).toContain("Fresh Start");
    expect((await container.github.getFile({ owner: "acme", name: "reuse" }, PROJECT_FILE, "main"))?.content).not.toContain("Delete Me");
  });
});

describe("project folder API", () => {
  let cleanup: (() => void) | undefined;
  let app: FastifyInstance | undefined;
  const ENV_KEYS = ["REQUIRE_AUTH", "OPENAI_API_KEY"] as const;
  let savedEnv: Record<string, string | undefined>;

  async function boot(): Promise<FastifyInstance> {
    const container = new Container();
    await container.ensureSeed();
    app = (await buildServer(container)).app;
    await app.ready();
    return app;
  }

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    getEnvFresh();
    cleanup = freshDb().cleanup;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    getEnvFresh();
    cleanup?.();
  });

  it("creates the folder on project creation, syncs memory, browses and pulls", async () => {
    const srv = await boot();
    const created = await srv.inject({ method: "POST", url: "/projects", payload: { name: "Folder", description: "d", configRepo: "acme/folder" } });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const files = await srv.inject({ method: "GET", url: `/projects/${id}/files?path=CodeVia` });
    expect(files.statusCode).toBe(200);
    const paths = (files.json() as Array<{ path: string }>).map((f) => f.path);
    expect(paths).toContain(PROJECT_FILE);
    expect(paths).toContain("CodeVia/agents/research.md");

    const mem = await srv.inject({ method: "POST", url: "/memory", payload: { projectId: id, scope: "project", type: "decision", key: "ui.theme", content: "Dark mode" } });
    expect(mem.statusCode).toBe(200);

    const memFile = await srv.inject({ method: "GET", url: `/projects/${id}/file?path=${MEMORY_FILE}` });
    expect(memFile.statusCode).toBe(200);
    expect((memFile.json() as { content: string }).content).toContain("ui.theme");

    const pull = await srv.inject({ method: "POST", url: `/projects/${id}/pull`, payload: {} });
    expect(pull.statusCode).toBe(200);
    const summary = pull.json() as { agents: number; tasks: number; memory: number };
    expect(summary.agents).toBeGreaterThan(5);
    expect(summary.memory).toBe(1);
  });

  it("mock repos survive reload from disk (dev persistence)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "mock-gh-"));
    const prev = process.env.MOCK_GITHUB_PATH;
    process.env.MOCK_GITHUB_PATH = join(dir, "snap.json");
    try {
      const before = new MockGitHubService({ seedDemoRepos: false, persist: true });
      before.seedRepo("acme", "snap", { files: [{ path: "a.txt", content: "hi" }] });
      await before.commit({ owner: "acme", name: "snap" }, "main", "second", [{ path: "b.txt", content: "yo" }]);
      const after = new MockGitHubService({ seedDemoRepos: false, persist: true });
      expect((await after.getFile({ owner: "acme", name: "snap" }, "a.txt"))?.content).toBe("hi");
      expect((await after.getFile({ owner: "acme", name: "snap" }, "b.txt"))?.content).toBe("yo");
      expect((await after.listCommits({ owner: "acme", name: "snap" })).length).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.MOCK_GITHUB_PATH;
      else process.env.MOCK_GITHUB_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mock branch isolation", () => {
  const ref = { owner: "acme", name: "iso" };
  it("keeps branch trees separate like real git", async () => {
    const gh = new MockGitHubService({ seedDemoRepos: false });
    gh.seedRepo("acme", "iso", { files: [{ path: "README.md", content: "# iso\n" }] });
    const main = (await gh.listBranches(ref)).find((b) => b.name === "main")!;
    await gh.createBranch(ref, "feature", main.sha);
    await gh.commit(ref, "feature", "add code", [{ path: "src/a.ts", content: "export const a = 1;\n" }]);
    // Branch sees its own file + the base files…
    expect((await gh.getFile(ref, "src/a.ts", "feature"))?.content).toContain("export const a");
    expect((await gh.listFiles(ref, "feature")).some((f) => f.path === "README.md")).toBe(true);
    // …main does not.
    expect(await gh.getFile(ref, "src/a.ts", "main")).toBeUndefined();
    expect((await gh.listFiles(ref, "main")).some((f) => f.path === "src/a.ts")).toBe(false);
  });
  it("merging a PR unions the head tree into the base", async () => {
    const gh = new MockGitHubService({ seedDemoRepos: false });
    gh.seedRepo("acme", "iso", { files: [{ path: "README.md", content: "# iso\n" }] });
    const main = (await gh.listBranches(ref)).find((b) => b.name === "main")!;
    await gh.createBranch(ref, "feature", main.sha);
    await gh.commit(ref, "feature", "add code", [{ path: "src/a.ts", content: "export const a = 1;\n" }]);
    const pr = await gh.createPullRequest(ref, "t", "b", "feature", "main");
    await gh.mergePullRequest(ref, pr.number);
    expect((await gh.getFile(ref, "src/a.ts", "main"))?.content).toContain("export const a");
  });
});
