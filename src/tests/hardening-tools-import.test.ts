import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { logger } from "../logger.js";
import { buildPullRequestBody } from "../tools/core-tools.js";
import type { ToolContext } from "../tools/types.js";
import { freshDb } from "./test-helpers.js";

let cleanup: (() => void) | undefined;
let container: Container;
let app: FastifyInstance | undefined;

async function boot(): Promise<FastifyInstance> {
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
  return app;
}

afterEach(async () => {
  container?.githubAutomation.stop();
  if (app) {
    await app.close();
    app = undefined;
  }
  cleanup?.();
});

const ctxFor = (over: Partial<ToolContext>, agentPerms: string[]): ToolContext => {
  const project = container.projectRepo.findMany()[0]?.data;
  const agent = container.agentRepo.findMany()[0]?.data;
  return {
    project: project!,
    agent: { ...agent!, permissions: agentPerms as never },
    github: container.github,
    logger,
    correlationId: "test-corr",
    ...over,
  };
};

describe("tool registry — permission matrix, approval gate, timeout", () => {
  beforeEach(async () => {
    await boot();
    const project = await container.agentManager.createProject({ name: "Tools", description: "x", configRepo: "acme/tools" });
    expect(project.id).toBeTruthy();
  });

  it("denies a tool the agent is not permitted to use", async () => {
    const res = await container.toolRegistry.execute("write_file", ctxFor({}, ["github.read"]), { path: "x.md", content: "hi" });
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/Permission denied/);
    expect(res.data?.denied).toBe(true);
  });

  it("treats github.write and repository.write as interchangeable", async () => {
    const res = await container.toolRegistry.execute("create_branch", ctxFor({}, ["repository.write"]), { name: "feat/x" });
    expect(res.ok).toBe(true);
    expect(res.data?.branch).toBe("feat/x");
  });

  it("routes dangerous tools through the approval channel and honours rejection", async () => {
    let asked = 0;
    const res = await container.toolRegistry.execute(
      "merge_pull_request",
      ctxFor({ requestApproval: async () => (asked++, false) }, ["github.write"]),
      { number: 1 },
    );
    expect(asked).toBe(1);
    expect(res.ok).toBe(false);
    expect(res.requiresApproval).toBe(true);
  });

  it("skips the second prompt when the step was already approved (ctx.approved)", async () => {
    let asked = 0;
    const res = await container.toolRegistry.execute(
      "merge_pull_request",
      ctxFor({ approved: true, requestApproval: async () => (asked++, true) }, ["github.write"]),
      { number: 999 },
    );
    expect(asked).toBe(0);
    // PR 999 does not exist in the mock repo → tool reports not merged but did run.
    expect(res.output).toMatch(/not merged|merged/);
  });

  it("search tool reads project memory and repository paths", async () => {
    const project = container.projectRepo.findMany()[0]!.data;
    const memory = container.memoryResolver.resolve({ force: "local", localRoot: `./data/test-memory-${Date.now()}` });
    await memory.append({ type: "decision", key: "use-postgres", content: "We picked PostgreSQL for the ledger", tags: [], refs: [], scope: "project" });
    const res = await container.toolRegistry.execute("search", ctxFor({ memory, project }, ["memory.read", "github.read"]), { query: "postgres" });
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/\[memory:decision\] use-postgres/);
  });

  it("PR body generator produces the required sections", () => {
    const body = buildPullRequestBody({ agentName: "Backend Developer", taskTitle: "Add login", changes: ["auth.ts"], tests: ["12 passed"] });
    for (const h of ["## Summary", "## Changes", "## Tests", "## Risks", "## Breaking Changes"]) expect(body).toContain(h);
    expect(body).toContain("- auth.ts");
  });
});

describe("project import — preview, create, merge", () => {
  beforeEach(async () => {
    await boot();
  });

  it("dry-run reports the plan without writing, create remaps ids, merge respects conflict policy", async () => {
    const src = await container.agentManager.createProject({ name: "Source", slug: "source", description: "x", configRepo: "acme/source" });
    const wf = container.workflowRepo.create({
      projectId: src.id,
      name: "Ship",
      slug: "ship",
      description: "",
      nodes: [{ id: "a", type: "agent", name: "Build", config: { agentType: "backend-developer" }, retries: 0 }],
      edges: [],
      enabled: true,
    });
    expect(wf.id).toBeTruthy();
    const exported = (await app!.inject({ method: "GET", url: `/projects/${src.id}/export` })).json();
    expect(exported.agents.length).toBeGreaterThan(0);
    expect(exported.workflows.length).toBe(1);

    const before = container.projectRepo.findMany().length;
    const preview = (await app!.inject({ method: "POST", url: "/settings/import", payload: { ...exported, dryRun: true } })).json();
    expect(preview.dryRun).toBe(true);
    expect(preview.plan.workflows.create).toBe(1);
    expect(preview.conflicts.some((c: { kind: string }) => c.kind === "project")).toBe(true); // slug taken → rename
    expect(container.projectRepo.findMany().length).toBe(before);

    const created = (await app!.inject({ method: "POST", url: "/settings/import", payload: exported })).json();
    expect(created.ok).toBe(true);
    expect(created.projectId).not.toBe(src.id);
    const newWfs = container.workflowRepo.byProject(created.projectId);
    expect(newWfs.length).toBe(1);
    expect(newWfs[0].id).not.toBe(wf.id);
    expect(container.agentRepo.byProject(created.projectId).length).toBeGreaterThan(0);

    // Merge back into the source project: everything conflicts → skipped by default.
    const merged = (await app!.inject({ method: "POST", url: "/settings/import", payload: { ...exported, mode: "merge", targetProjectId: src.id } })).json();
    expect(merged.imported.workflows).toBe(0);
    expect(merged.imported.skipped).toBeGreaterThan(0);
    const over = (await app!.inject({ method: "POST", url: "/settings/import", payload: { ...exported, mode: "merge", targetProjectId: src.id, conflict: "overwrite" } })).json();
    expect(over.imported.workflows).toBe(1);
    expect(container.workflowRepo.byProject(src.id).length).toBe(1);
    expect(container.workflowRepo.byProject(src.id)[0].version).toBe(2);
  });
});

describe("task cancellation + hardening", () => {
  beforeEach(async () => {
    await boot();
  });

  it("cancelled queued task is skipped by the worker and final tasks are not re-cancelled", async () => {
    const project = await container.agentManager.createProject({ name: "Cancel", description: "x", configRepo: "acme/cancel" });
    const task = container.agentManager.createTask({ projectId: project.id, title: "Long job", description: "" });
    const job = container.queue.enqueue("agent.run", { taskId: task.id });
    const res = (await app!.inject({ method: "POST", url: `/tasks/${task.id}/cancel` })).json();
    expect(res.status).toBe("cancelled");
    await container.worker.process(job.id);
    expect(container.taskRepo.findById(task.id)?.data.status).toBe("cancelled");
    expect(container.runRepo.findMany({ projectId: project.id }).length).toBe(0);
    const again = (await app!.inject({ method: "POST", url: `/tasks/${task.id}/cancel` })).json();
    expect(again.alreadyFinal).toBe(true);
  });

  it("adds security headers and rate-limit headers to API responses", async () => {
    const res = await app!.inject({ method: "GET", url: "/projects" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["cache-control"]).toBe("no-store");
    const health = await app!.inject({ method: "GET", url: "/health" });
    expect(health.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  it("worker github.op executes real GitHub operations", async () => {
    const project = await container.agentManager.createProject({ name: "Ops", description: "x", configRepo: "acme/ops" });
    const job = container.queue.enqueue("github.op", { op: "create_branch", projectId: project.id, name: "agent/ops-1" });
    await container.worker.process(job.id);
    const branches = await container.github.listBranches({ owner: "acme", name: "ops" });
    expect(branches.some((b) => b.name === "agent/ops-1")).toBe(true);
    const bad = container.queue.enqueue("github.op", { op: "merge_pr", projectId: project.id, number: 1 });
    await container.worker.process(bad.id).catch(() => undefined);
    const row = container.queue.getById(bad.id);
    expect(row?.status).not.toBe("succeeded");
  });
});
