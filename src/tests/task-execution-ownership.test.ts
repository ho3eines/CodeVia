import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { AGENT_TYPES } from "../agents/generator.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { ApprovalService } from "../approvals/service.js";
import { Db } from "../db/client.js";
import { JobQueue } from "../db/queue.js";
import type { Run } from "../domain/entities.js";
import { executionTask } from "../agents/execution.js";
import type { Project, Task } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

let fx: ReturnType<typeof freshDb>;
let c: Container;
let app: FastifyInstance;
let project: Project;
beforeEach(async () => {
  fx = freshDb();
  c = new Container();
  await c.ensureSeed();
  project = await c.agentManager.createProject({ name: "Task ownership", description: "A web app", configRepo: "acme/ownership" });
  app = (await buildServer(c)).app;
  await app.ready();
});
afterEach(async () => { vi.restoreAllMocks(); c.githubAutomation.stop(); await app.close(); await new Promise<void>((resolve) => setImmediate(resolve)); fx.cleanup(); });

function parentAndChild(status: Task["status"] = "failed") {
  const created = c.agentManager.createTask({ projectId: project.id, title: "Add login", description: "Build API and UI", input: { executionMode: "autonomous" } });
  const parent: Task = { ...created, status };
  const child: Task = { ...parent, id: "child-implementation", parentTaskId: parent.id, title: "Implement frontend", agentType: "frontend-developer", status: "failed", input: { autonomous: true } };
  c.taskRepo.upsert(parent, { projectId: project.id });
  c.taskRepo.upsert(child, { projectId: project.id, parentId: parent.id });
  return { parent, child };
}

describe("task ownership and retries", () => {
  it("queues the owning autonomous task when a child run is retried", async () => {
    const { parent, child } = parentAndChild();
    const response = await app.inject({ method: "POST", url: `/tasks/${child.id}/run` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ taskId: parent.id, requestedTaskId: child.id });
    expect(c.queue.getById(response.json().jobId)?.payload.taskId).toBe(parent.id);
    expect(c.taskRepo.findById(parent.id)?.data.status).toBe("queued");
    expect(c.taskRepo.findById(child.id)?.data.status).toBe("failed");
    const again = await app.inject({ method: "POST", url: `/tasks/${child.id}/run` });
    expect(again.statusCode).toBe(409);
  });

  it("cannot restart a child while its owning task is already running", async () => {
    const { parent, child } = parentAndChild("running");
    const enqueue = vi.spyOn(c.queue, "enqueue");
    const response = await app.inject({ method: "POST", url: `/tasks/${child.id}/run` });
    expect(response.statusCode).toBe(409);
    expect(response.json().taskId).toBe(parent.id);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not silently remove workflow routing on an unrelated task edit", async () => {
    const workflow = c.workflowRepo.byProject(project.id)[0];
    const task = c.agentManager.createTask({ projectId: project.id, title: "Run workflow", workflowId: workflow.id });
    const response = await app.inject({ method: "PATCH", url: `/tasks/${task.id}`, payload: { title: "Updated title" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().workflowId).toBe(workflow.id);
    const clear = await app.inject({ method: "PATCH", url: `/tasks/${task.id}`, payload: { workflowId: null } });
    expect(clear.json().workflowId).toBeUndefined();
  });

  it("finds the execution owner through nested children and rejects invalid ancestry", () => {
    const { parent, child } = parentAndChild();
    const nested = { ...child, id: "nested", parentTaskId: child.id };
    c.taskRepo.upsert(nested, { projectId: project.id, parentId: child.id });
    expect(executionTask(c.taskRepo, nested.id).id).toBe(parent.id);
    c.taskRepo.upsert({ ...parent, parentTaskId: nested.id }, { projectId: project.id });
    expect(() => executionTask(c.taskRepo, nested.id)).toThrow(/cycle/);
  });

  it("refuses orphaned or cross-project retries instead of running without context", async () => {
    const { parent, child } = parentAndChild();
    c.taskRepo.upsert({ ...parent, projectId: "another-project" }, { projectId: "another-project" });
    expect((await app.inject({ method: "POST", url: `/tasks/${child.id}/run` })).statusCode).toBe(409);
    c.taskRepo.deleteById(parent.id);
    expect((await app.inject({ method: "POST", url: `/tasks/${child.id}/run` })).statusCode).toBe(409);
  });

  it("cancelling a parent immediately releases child approvals without resurrecting the child", async () => {
    const { parent, child } = parentAndChild("running");
    c.taskRepo.upsert({ ...child, status: "running" }, { projectId: project.id, parentId: parent.id });
    c.approvals.setPolicy({ autoApprove: false, timeoutMs: 60000 });
    const waiting = c.approvals.request("Write child files", { projectId: project.id, taskId: child.id });
    const response = await app.inject({ method: "POST", url: `/tasks/${parent.id}/cancel` });
    expect(response.statusCode).toBe(200);
    expect(c.approvals.pendingCount(project.id)).toBe(0);
    expect(await waiting).toBe(false);
    expect(c.taskRepo.findById(parent.id)?.data.status).toBe("cancelled");
    expect(c.taskRepo.findById(child.id)?.data.status).toBe("cancelled");
    expect(c.approvals.pendingCount(project.id)).toBe(0);
  });

  it("does not lose a decision arriving synchronously through the notification hook", async () => {
    let service: ApprovalService;
    service = new ApprovalService({ repo: c.approvalRepo, kv: c.kv, taskRepo: c.taskRepo, auditRepo: c.auditRepo, notificationRepo: c.notificationRepo, notify: async (request) => { service.decide(request.id, "approve", { source: "system" }); } });
    service.setPolicy({ autoApprove: false, timeoutMs: 10000 });
    expect(await service.request("Approve immediately")).toBe(true);
  });

  it("cannot overwrite cancellation while a previous local execution is unwinding", async () => {
    const task = c.agentManager.createTask({ projectId: project.id, title: "Hold", agentType: "backend-developer" });
    let release!: () => void;
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(c.agentRunner, "run").mockImplementation(async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: "succeeded", steps: [], id: "held" } as unknown as Run;
    });
    const pending = c.agentManager.runTask(task.id);
    await reached;
    await app.inject({ method: "POST", url: `/tasks/${task.id}/cancel` });
    expect((await app.inject({ method: "POST", url: `/tasks/${task.id}/run` })).statusCode).toBe(409);
    expect(c.taskRepo.findById(task.id)?.data.status).toBe("cancelled");
    release();
    expect((await pending).status).toBe("cancelled");
    expect((await app.inject({ method: "POST", url: `/tasks/${task.id}/run` })).statusCode).toBe(200);
  });

  it("also blocks retries while a separate worker still owns the running job", async () => {
    const { parent } = parentAndChild("cancelled");
    c.queue.enqueue("agent.run", { taskId: parent.id });
    c.queue.claim(1);
    expect((await app.inject({ method: "POST", url: `/tasks/${parent.id}/run` })).statusCode).toBe(409);
    expect(c.taskRepo.findById(parent.id)?.data.status).toBe("cancelled");
  });

  it("recovers an execution job orphaned by a process restart", () => {
    const { parent } = parentAndChild("running");
    const job = c.queue.enqueue("agent.run", { taskId: parent.id });
    c.queue.claim(1);

    const recovered = c.queue.recoverInterruptedExecutions();
    expect(recovered.retrying.map((j) => j.id)).toEqual([job.id]);
    expect(recovered.dead).toEqual([]);
    expect(c.queue.getById(job.id)).toMatchObject({ status: "pending", attempts: 1 });
    expect(c.queue.claim(1).map((j) => j.id)).toEqual([job.id]);
  });

  it("dead-letters an interrupted execution that exhausted its retry budget", () => {
    const { parent } = parentAndChild("running");
    const job = c.queue.enqueue("agent.run", { taskId: parent.id }, { maxAttempts: 1 });
    c.queue.claim(1);

    const recovered = c.queue.recoverInterruptedExecutions();
    expect(recovered.retrying).toEqual([]);
    expect(recovered.dead.map((j) => j.id)).toEqual([job.id]);
    expect(c.queue.getById(job.id)).toMatchObject({ status: "dead", attempts: 1 });
  });

  it("does not report another worker's row after losing a job-claim race", () => {
    c.queue.enqueue("notify", { test: true });
    const otherDb = new Db(fx.path);
    const other = new JobQueue(otherDb);
    let competing: ReturnType<JobQueue["claim"]> | undefined;
    const original = fx.db.run.bind(fx.db);
    // Simulates a second worker winning in a SELECT/UPDATE gap. With the
    // atomic UPDATE RETURNING implementation there is no such gap/hook.
    const spy = vi.spyOn(fx.db, "run").mockImplementation((sql, params) => {
      if (sql.includes("UPDATE jobs SET status = 'running'") && !competing) competing = other.claim(1);
      original(sql, params);
    });
    try {
      const mine = c.queue.claim(1);
      competing ??= other.claim(1);
      expect(mine.length + competing.length).toBe(1);
      expect(mine.some((job) => competing!.some((j) => j.id === job.id))).toBe(false);
    } finally { spy.mockRestore(); otherDb.close(); }
  });

  it("routes both Run Agent UI entry points to single-agent execution", () => {
    const js = readFileSync("public/app.js", "utf8");
    const catalog = JSON.parse(js.match(/const WF_AGENT_TYPES = (\[[^;]+\]);/)![1]) as string[];
    expect(new Set(catalog)).toEqual(new Set(AGENT_TYPES));
    for (const selector of ["#pa-desc", "#prat-desc"]) {
      const at = js.indexOf(`description: $("${selector}")`);
      expect(at).toBeGreaterThan(-1);
      expect(js.slice(at, at + 170)).toContain('executionMode: "agent"');
    }
  });
});
