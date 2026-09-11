import type { FastifyInstance } from "fastify";
import { live } from "../../realtime/live.js";
import { executionTask } from "../../agents/execution.js";
import type { Container } from "../../app/container.js";
import { matter } from "../../github/project-files.js";
import { accessibleProjectIds } from "../project-access.js";
import { resolveRequestUser } from "../auth.js";

export function registerTaskRoutes(app: FastifyInstance, container: Container): void {
  app.get("/tasks", { schema: { tags: ["tasks"] } }, async (req) => {
    const q = req.query as { projectId?: string; status?: string };
    const owned = accessibleProjectIds(req, container);
    let tasks = container.taskRepo.findMany().filter((t) => owned.has(t.data.projectId));
    if (q.projectId) tasks = tasks.filter((t) => t.data.projectId === q.projectId && owned.has(t.data.projectId));
    if (q.status) tasks = tasks.filter((t) => t.data.status === q.status);
    return tasks.map((r) => r.data);
  });

  app.post("/tasks", { schema: { tags: ["tasks"] } }, async (req) => {
    const b = req.body as Record<string, unknown>;
    const { user: reqUser, authenticated: reqAuth } = resolveRequestUser(req, container);
    const input = (b.input as Record<string, unknown> | undefined) ?? {};
    if (reqAuth) input.requestUserId = reqUser.id;
    const task = container.agentManager.createTask({
      projectId: String(b.projectId),
      title: String(b.title ?? "Task"),
      description: b.description as string | undefined,
      priority: (b.priority as "low" | "medium" | "high" | "critical" | undefined) ?? "medium",
      agentType: b.agentType as never,
      workflowId: b.workflowId as string | undefined,
      input,
    });
    const p = container.projectRepo.findById(task.projectId)?.data;
    if (p) await container.projectFiles.syncTask(p, task);
    return task;
  });

  app.get("/tasks/:id", { schema: { tags: ["tasks"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.taskRepo.findById(id)?.data ?? { error: "task not found" };
  });

  app.patch("/tasks/:id", { schema: { tags: ["tasks"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = container.taskRepo.findById(id);
    if (!rec) {
      reply.code(404);
      return { error: "task not found" };
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<typeof rec.data> = {};
    if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim();
    if (typeof b.description === "string") patch.description = b.description;
    if (["low", "medium", "high", "critical"].includes(String(b.priority))) {
      patch.priority = b.priority as "low" | "medium" | "high" | "critical";
    }
    if (typeof b.agentType === "string") patch.agentType = b.agentType as never;
    if (Object.hasOwn(b, "workflowId") && (typeof b.workflowId === "string" || b.workflowId === null)) {
      patch.workflowId = (b.workflowId as string | undefined) || undefined;
    }
    const updated = { ...rec.data, ...patch, id, updatedAt: new Date().toISOString() };
    container.taskRepo.upsert(updated, { projectId: updated.projectId, parentId: updated.parentTaskId });
    const p = container.projectRepo.findById(updated.projectId)?.data;
    if (p) await container.projectFiles.syncTask(p, updated);
    live.emit({ type: "task.updated", taskId: id, projectId: updated.projectId, data: { status: updated.status } });
    return updated;
  });

  app.delete("/tasks/:id", { schema: { tags: ["tasks"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!container.taskRepo.findById(id)) {
      reply.code(404);
      return { error: "task not found" };
    }
    container.approvals.cancelForTask(id);
    const task = container.taskRepo.findById(id)!.data;
    const p = container.projectRepo.findById(task.projectId)?.data;
    if (p) await container.projectFiles.writeFiles(p, [{ path: container.projectFiles.pathFor(p, "task", id), content: matter({ schemaVersion: 2, deleted: true }, "Task intentionally removed. Do not restore or enqueue it.") }], "[CodeVia] remove task", false);
    container.taskRepo.deleteById(id);
    return { ok: true };
  });

  app.post("/tasks/:id/run", { schema: { tags: ["tasks"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!container.taskRepo.findById(id)) return reply.code(404).send({ error: "task not found" });
    let task;
    try { task = executionTask(container.taskRepo, id); } catch (err) { return reply.code(409).send({ error: String(err) }); }
    // A "running" task is genuinely executing (or was interrupted mid-run) and
    // must not be double-started. "waiting_for_approval" is held for a human.
    // Anything else — including a task stranded as "queued" by a dead-lettered
    // job or a hard-killed worker — has no live work behind it and can be
    // re-run instead of being permanently stuck at a false "already in flight".
    const active = container.agentManager.isTaskRunning(task.id) || container.queue.hasLiveJob(task.id) || task.status === "running";
    if (active) return reply.code(409).send({ error: "Owning task is already in flight", taskId: task.id });
    if (task.status === "waiting_for_approval") {
      return reply.code(409).send({ error: "Task is waiting for approval; approve, reject, or cancel it before running again", taskId: task.id });
    }
    // Store the signed-in user's id so the worker can use their GitHub OAuth
    // token when resolving the project's GitHub connection (GITHUB_TOKEN is
    // login-only and cannot write to the user's repositories).
    const { user: reqUser, authenticated: reqAuth } = resolveRequestUser(req, container);
    const inputWithUser = reqAuth ? { ...(task.input as Record<string, unknown> | undefined ?? {}), requestUserId: reqUser.id } : task.input;
    container.taskRepo.upsert({ ...task, status: "queued", error: undefined, input: inputWithUser as typeof task.input, updatedAt: new Date().toISOString() }, { projectId: task.projectId, parentId: task.parentTaskId });
    const p = container.projectRepo.findById(task.projectId)?.data;
    if (p) await container.projectFiles.syncTask(p, container.taskRepo.findById(task.id)!.data);
    const job = container.queue.enqueue("agent.run", { taskId: task.id }, { correlationId: task.correlationId });
    return { taskId: task.id, requestedTaskId: id, jobId: job.id };
  });

  app.post("/tasks/:id/cancel", { schema: { tags: ["tasks"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const t = container.taskRepo.findById(id);
    if (!t) return { error: "task not found" };
    if (["succeeded", "failed", "cancelled"].includes(t.data.status)) {
      // (R07) A final task may still owe its Git write from an earlier outage:
      // retry the pending sync instead of permanently pretending Git is in sync.
      const retried = await container.agentManager.retryTaskSync(t.data.projectId, id);
      return { ...t.data, alreadyFinal: true, ...(retried === undefined ? {} : { repositorySynced: retried }) };
    }
    // Queued → dropped before the worker picks it up; running → the runner
    // observes the status between steps and stops cooperatively.
    const updated = { ...t.data, status: "cancelled" as const, updatedAt: new Date().toISOString() };
    container.taskRepo.upsert(updated, { projectId: updated.projectId, parentId: updated.parentTaskId });
    container.approvals.cancelForTask(id);
    const repositorySynced = await container.agentManager.syncTaskFile(updated.projectId, updated);
    live.emit({ type: "task.updated", taskId: id, projectId: updated.projectId, data: { status: "cancelled" } });
    // (R07) Cancellation works locally even during a Git outage, but the
    // response must say so explicitly instead of claiming the repo is current.
    return { ...updated, repositorySynced };
  });

  app.get("/runs", { schema: { tags: ["runs"] } }, async (req) => {
    const q = req.query as { projectId?: string; status?: string; agentId?: string; agentType?: string; taskId?: string };
    const owned = accessibleProjectIds(req, container);
    let runs = container.runRepo.findMany().map((r) => r.data).filter((r) => owned.has(r.projectId));
    if (q.projectId) runs = runs.filter((r) => r.projectId === q.projectId);
    if (q.status) runs = runs.filter((r) => r.status === q.status);
    if (q.agentId) runs = runs.filter((r) => r.agentId === q.agentId);
    if (q.agentType) runs = runs.filter((r) => r.agentType === q.agentType);
    if (q.taskId) runs = runs.filter((r) => r.taskId === q.taskId);
    return runs;
  });

  app.get("/runs/:id", { schema: { tags: ["runs"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.runRepo.findById(id)?.data ?? { error: "run not found" };
  });

  // AI Run Console — observable steps (never exposes chain-of-thought).
  app.get("/runs/:id/console", { schema: { tags: ["runs"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.runRepo.findById(id);
    if (!r) return { error: "run not found" };
    return {
      runId: r.data.id,
      taskId: r.data.taskId,
      projectId: r.data.projectId,
      agent: r.data.agentType,
      status: r.data.status,
      modelId: r.data.modelId,
      tokens: { input: r.data.inputTokens, output: r.data.outputTokens, total: r.data.totalTokens },
      costUsd: r.data.costUsd,
      durationMs: r.data.durationMs,
      steps: r.data.steps,
      skills: r.data.skills ?? [],
      error: r.data.error,
      summary: r.data.summary,
      verification: r.data.verification,
    };
  });
}
