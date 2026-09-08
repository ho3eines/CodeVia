import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";
import { MockGitHubService } from "../github/mock-service.js";
import type { Project } from "../domain/entities.js";

/* ------------------------------------------------------------------ *
 * Self-healing mock repositories.
 *
 * A project may reference a repository the simulation never created
 * (restored database, migrated install, lost mock snapshot, hand-typed
 * name). Nothing on the platform may 502 with "Mock repo not found":
 * the repository is auto-provisioned — with the project's own branch —
 * and genuinely missing CodeVia/ state is initialized once.
 * ------------------------------------------------------------------ */

let fx: ReturnType<typeof freshDb>;
let c: Container;
let gh: MockGitHubService;
let app: FastifyInstance | undefined;

async function server(): Promise<FastifyInstance> {
  app ??= (await buildServer(c)).app;
  await app.ready();
  return app;
}

/** A project document inserted the way restored/migrated data arrives: no onboarding, no mock repo. */
function restoredProject(over: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  const repo = over.configRepo ?? "ho3eines/Projects";
  const branch = over.branch ?? "main";
  return {
    id: "proj-restored", slug: "agent", name: "Agent", description: "restored project",
    configRepo: repo, branch,
    repositories: over.repositories ?? [{ repo, branch, role: "primary", isConfigRepo: true }],
    capabilities: { platforms: [], languages: [], frameworks: [], databases: [], deploymentTargets: [], features: [], integrations: [], agentTypes: [] },
    settings: { environment: "development", notifications: [], rules: [], skills: [], workflows: [], budget: { maxTokensPerRun: 20000, maxCallsPerRun: 20, maxCostUsdPerRun: 5, maxDurationMs: 600000 }, permissions: {}, metadata: {} },
    active: true, createdAt: now, updatedAt: now,
    ...over,
  } as Project;
}

beforeEach(async () => {
  fx = freshDb();
  c = new Container();
  await c.ensureSeed();
  gh = c.github as MockGitHubService;
});
afterEach(async () => {
  c.githubAutomation.stop();
  await app?.close();
  app = undefined;
  await new Promise<void>((r) => setImmediate(r));
  fx.cleanup();
});

describe("MockGitHubService auto-provisioning", () => {
  it("creates a referenced repository on first access instead of throwing", async () => {
    const mock = new MockGitHubService({ seedDemoRepos: false });
    const ref = { owner: "ho3eines", name: "Projects" };
    // Before: every one of these threw "Mock repo not found".
    await expect(mock.listBranches(ref)).resolves.toHaveLength(1);
    await expect(mock.listFiles(ref, "main")).resolves.toEqual([]);
    await expect(mock.getFile(ref, "README.md", "main")).resolves.toBeUndefined();
    await expect(mock.listCommits(ref)).resolves.toBeInstanceOf(Array);
    const issue = await mock.createIssue(ref, "Broken login", "steps…");
    expect(issue.number).toBe(1);
    // The repository is real from now on: it is listed and can carry commits.
    const listed = await mock.listRepositories({ query: "ho3eines/Projects" });
    expect(listed.map((r) => r.fullName)).toContain("ho3eines/Projects");
    await expect(mock.commit(ref, "main", "first commit", [{ path: "README.md", content: "# hi\n" }])).resolves.toHaveProperty("sha");
  });

  it("never wipes an existing repository (auto-provision is create-only)", async () => {
    const mock = new MockGitHubService({ seedDemoRepos: false });
    mock.seedRepo("acme", "kept", { files: [{ path: "README.md", content: "# original\n" }] });
    await mock.listBranches({ owner: "acme", name: "kept" }); // triggers the access path
    expect(await mock.getFile({ owner: "acme", name: "kept" }, "README.md", "main")).toMatchObject({ content: "# original\n" });
  });
});

describe("restored project whose mock repository is missing", () => {
  it("serves every project page and initializes the missing state once", async () => {
    c.projectRepo.upsert(restoredProject(), { key: "agent" });
    const srv = await server();

    // Before the fix every one of these answered 502 "Mock repo not found".
    for (const path of ["/projects", "/projects/proj-restored", "/projects/proj-restored/agents", "/projects/proj-restored/tasks", "/projects/proj-restored/overview", "/projects/proj-restored/branches", "/projects/proj-restored/files"]) {
      const res = await srv.inject({ method: "GET", url: path });
      expect(res.statusCode, path).toBe(200);
    }

    // The missing state was built: agents exist, CodeVia/ committed, branch present.
    const agents = c.agentRepo.byProject("proj-restored");
    expect(agents.length).toBeGreaterThan(0);
    const stored = c.projectRepo.findById("proj-restored")!.data;
    expect(stored.repositoryState?.generation).toBe("simulation");
    expect((await gh.listFiles({ owner: "ho3eines", name: "Projects" }, "main")).map((f) => f.path)).toContain("CodeVia/project.md");

    // Project options work: issues, dry-run and AI tasks on the fresh repository.
    const issue = await srv.inject({ method: "POST", url: "/projects/proj-restored/issues", payload: { title: "Test issue" } });
    expect(issue.statusCode).toBe(201);
    const dry = await srv.inject({ method: "POST", url: "/projects/proj-restored/dry-run", payload: { title: "Fix login", description: "login throws 500" } });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().simulation).toBe(true);

    // Initialization happens exactly once — later views only re-read state.
    const commit = vi.spyOn(gh, "commit");
    const again = await srv.inject({ method: "GET", url: "/projects/proj-restored" });
    expect(again.statusCode).toBe(200);
    expect(commit.mock.calls.map((call) => call[2]).some((message) => message.includes("initialize missing project state"))).toBe(false);
  });

  it("uses the project's own (non-default) branch and provisions extra linked repositories", async () => {
    c.projectRepo.upsert(restoredProject({
      configRepo: "ho3eines/agent", branch: "develop",
      repositories: [
        { repo: "ho3eines/agent", branch: "develop", role: "primary", isConfigRepo: true },
        { repo: "ho3eines/other", branch: "main", role: "other" },
      ],
    }), { key: "agent" });
    const srv = await server();

    expect((await srv.inject({ method: "GET", url: "/projects/proj-restored" })).statusCode).toBe(200);
    const branches = (await srv.inject({ method: "GET", url: "/projects/proj-restored/branches" })).json();
    expect(branches.map((b: { name: string }) => b.name)).toContain("develop");
    // State was committed on the project branch, not on a replacement.
    expect((await gh.listFiles({ owner: "ho3eines", name: "agent" }, "develop")).map((f) => f.path)).toContain("CodeVia/project.md");
    // Additional linked repositories are usable too (issues/PRs pickers).
    const other = (await srv.inject({ method: "GET", url: "/projects/proj-restored/branches?repo=ho3eines/other" })).json();
    expect(other.map((b: { name: string }) => b.name)).toContain("main");
  });

  it("leaves an already-initialized project untouched", async () => {
    // Normal creation flow (state committed during onboarding).
    const p = await c.agentManager.createProject({ name: "Canonical", configRepo: "acme/canonical", description: "ok" });
    const srv = await server();
    const commit = vi.spyOn(gh, "commit");
    const res = await srv.inject({ method: "GET", url: `/projects/${p.id}` });
    expect(res.statusCode).toBe(200);
    expect(commit).not.toHaveBeenCalled();
    expect(c.agentRepo.byProject(p.id).length).toBeGreaterThan(0);
  });

  it("deleteFiles removes exactly the requested paths and advances the branch", async () => {
    const ref = { owner: "ho3eines", name: "purge" };
    gh.seedRepo("ho3eines", "purge", {
      files: [{ path: "README.md", content: "# purge\n" }],
    });
    await gh.commit(ref, "main", "add state", [
      { path: "CodeVia/project.md", content: "# stale\n" },
      { path: "CodeVia/agents/research.md", content: "# agent\n" },
    ]);

    const before = (await gh.listFiles(ref, "main")).map((f) => f.path);
    expect(before).toContain("CodeVia/project.md");

    const commit = await gh.deleteFiles!(ref, "main", "[CodeVia] remove project state", ["CodeVia/project.md", "CodeVia/agents/research.md"]);
    expect(commit).toHaveProperty("sha");

    const after = (await gh.listFiles(ref, "main")).map((f) => f.path);
    expect(after).not.toContain("CodeVia/project.md");
    expect(after).not.toContain("CodeVia/agents/research.md");
    // Untouched files survive, and the branch HEAD advanced.
    expect(after).toContain("README.md");
    expect((await gh.listBranches(ref)).find((b) => b.name === "main")?.sha).toBe(commit.sha);
  });

  it("removeProject purges CodeVia/* so a new project on the same repo starts clean", async () => {
    const first = await c.agentManager.createProject({ name: "Stale One", description: "old", configRepo: "ho3eines/recycle" });
    await c.agentManager.syncProjectState(first.id);
    expect((await gh.listFiles({ owner: "ho3eines", name: "recycle" }, "main")).map((f) => f.path)).toContain("CodeVia/project.md");

    c.projectRepo.deleteById(first.id);
    await c.projectFiles.removeProject(first);

    expect((await gh.listFiles({ owner: "ho3eines", name: "recycle" }, "main")).map((f) => f.path).filter((f) => f.startsWith("CodeVia/"))).toHaveLength(0);

    // The same repo can host a brand-new project with its own identity.
    const second = await c.agentManager.createProject({ name: "Fresh Reborn", description: "new", configRepo: "ho3eines/recycle" });
    const stored = c.projectRepo.findById(second.id)?.data;
    expect(stored?.name).toBe("Fresh Reborn");
    expect(stored?.description).toBe("new");
  });

  it("DELETE /projects/:id cascades to all project-scoped records", async () => {
    const p = await c.agentManager.createProject({ name: "Cascade", description: "d", configRepo: "ho3eines/cascade" });
    c.agentManager.createTask({ projectId: p.id, title: "T", description: "d" });
    c.memoryRepo.upsert({ id: "mem-x", projectId: p.id, scope: "project", type: "decision", key: "k", content: "v", tags: [], refs: [], source: "web", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { projectId: p.id, key: "k" });
    expect(c.agentRepo.byProject(p.id).length).toBeGreaterThan(0);

    const srv = await server();
    const res = await srv.inject({ method: "DELETE", url: `/projects/${p.id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);

    // No orphaned records anywhere: the project itself and every scoped entity are gone.
    expect(c.projectRepo.findById(p.id)).toBeUndefined();
    expect(c.agentRepo.byProject(p.id)).toHaveLength(0);
    expect(c.taskRepo.byProject(p.id)).toHaveLength(0);
    expect(c.memoryRepo.byProject(p.id)).toHaveLength(0);
    expect(c.workflowRepo.byProject(p.id)).toHaveLength(0);
    expect(c.runRepo.byProject(p.id)).toHaveLength(0);
    expect(c.conversationRepo.findMany({ projectId: p.id })).toHaveLength(0);
    expect(c.skillRepo.findMany({ projectId: p.id })).toHaveLength(0);
  });
});
