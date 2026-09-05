import type { FastifyInstance } from "fastify";
import { live } from "../../realtime/live.js";
import type { Container } from "../../app/container.js";

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
      agentType: b.agentType as never,
      workflowId: b.workflowId as string | undefined,
      input: b.input as Record<string, unknown> | undefined,
    });
    return task;
  });

  app.get("/tasks/:id", { schema: { tags: ["tasks"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.taskRepo.findById(id)?.data ?? { error: "task not found" };
  });

  app.post("/tasks/:id/run", { schema: { tags: ["tasks"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const task = container.taskRepo.findById(id);
    if (!task) return { error: "task not found" };
    const job = container.queue.enqueue("agent.run", { taskId: id }, { correlationId: task.data.correlationId });
    return { taskId: id, jobId: job.id };
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
    live.emit({ type: "task.updated", taskId: id, data: { status: "cancelled" } });
    return updated;
  });

  app.get("/runs", { schema: { tags: ["runs"] } }, async (req) => {
    const q = req.query as { projectId?: string; status?: string };
    let runs = container.runRepo.findMany().map((r) => r.data);
    if (q.projectId) runs = runs.filter((r) => r.projectId === q.projectId);
    if (q.status) runs = runs.filter((r) => r.status === q.status);
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
      error: r.data.error,
    };
  });
}
