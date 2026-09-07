import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import type { Workflow } from "../../domain/entities.js";
import { parseWorkflowFile, renderWorkflowFile } from "../../github/state-codec.js";

export function registerWorkflowRoutes(app: FastifyInstance, container: Container): void {
  const persist = async (w: Workflow) => {
    parseWorkflowFile(renderWorkflowFile(w));
    const p = container.projectRepo.findById(w.projectId)?.data;
    if (!p) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
    await container.projectFiles.syncWorkflow(p, w);
    container.workflowRepo.upsert(w, { projectId: w.projectId });
    return w;
  };
  app.get("/workflows", { schema: { tags: ["workflows"] } }, async () => {
    return container.workflowRepo.findMany().map((r) => r.data);
  });

  app.post("/workflows", { schema: { tags: ["workflows"] } }, async (req) => {
    const b = req.body as Record<string, unknown>;
    const w = container.workflowRepo.create({
      projectId: String(b.projectId),
      name: String(b.name ?? "Workflow"),
      slug: String(b.slug ?? "workflow"),
      description: String(b.description ?? ""),
      nodes: (b.nodes as Workflow["nodes"]) ?? [],
      edges: (b.edges as Workflow["edges"]) ?? [],
      enabled: b.enabled !== false,
    });
    return persist(w);
  });

  app.get("/workflows/:id", { schema: { tags: ["workflows"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.workflowRepo.findById(id);
    if (!r) return { error: "workflow not found" };
    return r.data;
  });

  app.patch("/workflows/:id", { schema: { tags: ["workflows"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const r = container.workflowRepo.findById(id);
    if (!r) return { error: "workflow not found" };
    const w = { ...r.data, ...b, id, projectId: r.data.projectId, version: r.data.version + 1, updatedAt: new Date().toISOString() } as Workflow;
    container.workflowRepo.upsert(w, { projectId: w.projectId });
    return persist(w);
  });

  // Execute a workflow via a task.
  app.post("/workflows/:id/run", { schema: { tags: ["workflows"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const w = container.workflowRepo.findById(id);
    if (!w) return { error: "workflow not found" };
    const task = container.agentManager.createTask({
      projectId: w.data.projectId,
      title: String(b.title ?? `Run ${w.data.name}`),
      description: String(b.description ?? ""),
      workflowId: id,
      input: (b.input as Record<string, unknown>) ?? {},
    });
    const job = container.queue.enqueue("workflow.run", { taskId: task.id }, { correlationId: task.correlationId });
    return { task, jobId: job.id };
  });

  app.delete("/workflows/:id", { schema: { tags: ["workflows"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const w = container.workflowRepo.findById(id)?.data;
    const p = w && container.projectRepo.findById(w.projectId)?.data;
    if (p) await container.projectFiles.tombstone(p, container.projectFiles.pathFor(p, "workflow", id));
    container.workflowRepo.deleteById(id);
    return { ok: true };
  });
}
