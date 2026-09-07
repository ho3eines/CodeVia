import type { FastifyInstance } from "fastify";
import { live } from "../../realtime/live.js";
import { executionTask } from "../../agents/execution.js";
import type { Container } from "../../app/container.js";
import { matter } from "../../github/project-files.js";

export function registerTaskRoutes(app: FastifyInstance, container: Container): void {
  app.get("/tasks", { schema: { tags: ["tasks"] } }, async (req) => {
    const q = req.query as { projectId?: string; status?: string };
    let tasks = container.taskRepo.findMany();
    if (q.projectId) tasks = container.taskRepo.findMany({ projectId: q.projectId });
    if (q.status) tasks = tasks.filter((t) => t.data.status === q.status);
    return tasks.map((r) => r.data);
  });

  app.post("/tasks", { schema: { tags: ["tasks"] } }, async (req) => {
    const b = req.body as Record<string, unknown>;
    const task = container.agentManager.createTask({
      projectId: String(b.projectId),
      title: String(b.title ?? "Task"),
      description: b.description as string | undefined,
      priority: (b.priority as "low" | "medium" | "high" | "critical" | undefined) ?? "medium",
      agentType: b.agentType as never,
      workflowId: b.workflowId as string | undefined,
      input: b.input as Record<string, unknown> | undefined,
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
    live.emit({ type: "task.updated", taskId: id, data: { status: updated.status } });
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
    if (["running", "queued", "waiting_for_approval"].includes(task.status) || container.agentManager.isTaskRunning(task.id) || container.queue.hasRunningTask(task.id)) return reply.code(409).send({ error: "Owning task is already in flight", taskId: task.id });
    container.taskRepo.upsert({ ...task, status: "queued", error: undefined, updatedAt: new Date().toISOString() }, { projectId: task.projectId, parentId: task.parentTaskId });
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
      return { ...t.data, alreadyFinal: true };
    }
    // Queued → dropped before the worker picks it up; running → the runner
    // observes the status between steps and stops cooperatively.
    const updated = { ...t.data, status: "cancelled" as const, updatedAt: new Date().toISOString() };
    container.taskRepo.upsert(updated, { projectId: updated.projectId, parentId: updated.parentTaskId });
    container.approvals.cancelForTask(id);
    await container.agentManager.syncTaskFile(updated.projectId, updated);
    live.emit({ type: "task.updated", taskId: id, data: { status: "cancelled" } });
    return updated;
  });

  app.get("/runs", { schema: { tags: ["runs"] } }, async (req) => {
    const q = req.query as { projectId?: string; status?: string; agentId?: string; agentType?: string; taskId?: string };
    let runs = container.runRepo.findMany().map((r) => r.data);
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
