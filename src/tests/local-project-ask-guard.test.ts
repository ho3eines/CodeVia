import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Project, Run, Task } from "../domain/entities.js";
import { AutonomousOrchestrator, type PhaseExecutor } from "../agents/orchestrator.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { getEnvFresh } from "../config/env.js";
import { freshDb } from "./test-helpers.js";

/**
 * Folder projects created with `gitInit: false` (`sourceType: "local"`, no
 * `configRepo`) are analysis-only. Before this guard they accepted an
 * implementation request and then crashed deep inside the implementation
 * planner (`project.configRepo.split`), leaving a failed task with an opaque
 * internal error. The API must refuse the request up front — while Simulation
 * (read-only dry run) keeps working.
 */
let fx: ReturnType<typeof freshDb>;
let c: Container;
let app: FastifyInstance;
let folderProject: Project;

beforeEach(async () => {
  getEnvFresh();
  fx = freshDb();
  c = new Container();
  await c.ensureSeed();
  app = (await buildServer(c)).app;
  await app.ready();
  const linked = await c.agentManager.createProject({
    name: "Folder Only",
    description: "Scanned local folder with no linked repository",
    configRepo: "acme/folder-only",
  });
  folderProject = {
    ...linked,
    sourceType: "local",
    localPath: "/srv/projects/folder-only",
    configRepo: "",
    repositories: [],
  };
  c.projectRepo.upsert(folderProject, { key: folderProject.slug });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  c.githubAutomation.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fx.cleanup();
});

const ask = (extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: `/projects/${folderProject.id}/ask`,
    payload: { prompt: "Implement the login page", ...extra },
  });

describe("projects without a linked repository", () => {
  it("rejects an autonomous implementation request with an actionable 409", async () => {
    const res = await ask();
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toMatch(/no linked repository/i);
    expect(body.repositoryRequired).toBe(true);
    // Nothing was queued for execution.
    expect(c.taskRepo.findMany({ parentId: undefined }).length).toBe(0);
  });

  it("rejects a write-mode single agent the same way", async () => {
    const res = await ask({ executionMode: "agent", agentType: "backend-developer" });
    expect(res.statusCode).toBe(409);
    expect(res.json().repositoryRequired).toBe(true);
  });

  it("still allows Simulation, which only returns a plan and writes nothing", async () => {
    const res = await ask({ executionMode: "simulation" });
    expect(res.statusCode).toBe(200);
    expect(res.json().simulation).toBe(true);
  });

  it("keeps the orchestrator defensive: no repo means a clear, non-retryable error", async () => {
    // The task-file mirror is best-effort and must not crash for a repo-less project.
    const created = c.agentManager.createTask({ projectId: folderProject.id, title: "Noop", description: "x" });
    expect(await c.agentManager.syncTaskFile(folderProject.id, created)).toBe(false);
    const executor: PhaseExecutor = async (task: Task) => ({ id: `run-${task.id}` }) as Run;
    const orchestrator = new AutonomousOrchestrator({
      projectRepo: c.projectRepo,
      taskRepo: c.taskRepo,
      agentRepo: c.agentRepo,
      agentRunner: c.agentRunner,
      agentRouter: c.agentRouter,
      skillsRegistry: c.skillsRegistry,
      github: c.github,
      modelRepo: c.modelRepo,
      providerRepo: c.providerRepo,
      executor,
    });
    const task = c.agentManager.createTask({
      projectId: folderProject.id,
      title: "Implement login",
      description: "Write the login page",
      input: { executionMode: "autonomous" },
    });
    await expect(orchestrator.run(task.id)).rejects.toThrow(/no linked repository/i);
    // No child research/implementation task was planned or started.
    expect(c.taskRepo.findMany({ parentId: task.id }).length).toBe(0);
  });
});
