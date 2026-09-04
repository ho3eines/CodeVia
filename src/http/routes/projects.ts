import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import { randomUUID } from "node:crypto";

export function registerProjectRoutes(app: FastifyInstance, container: Container): void {
  // List projects
  app.get("/projects", { schema: { tags: ["projects"] } }, async () => {
    return container.projectRepo.findMany().map((r) => ({ ...r.data, id: r.data.id }));
  });

  // Create project + auto-onboard (Agent Generator / Skills / Workflow / Rules)
  app.post("/projects", { schema: { tags: ["projects"] } }, async (req) => {
    const body = req.body as Record<string, unknown>;
    const project = await container.agentManager.createProject({
      name: String(body.name ?? "Untitled"),
      slug: body.slug as string | undefined,
      description: String(body.description ?? ""),
      configRepo: String(body.configRepo ?? "owner/repo"),
      branch: body.branch as string | undefined,
      primaryLanguage: body.primaryLanguage as string | undefined,
      framework: body.framework as string | undefined,
      database: body.database as string | undefined,
      defaultModelId: body.defaultModelId as string | undefined,
      tech: (body.tech as string[]) ?? [],
    });
    return project;
  });

  app.get("/projects/:id", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.projectRepo.findById(id);
    if (!r) return { error: "project not found" };
    return r.data;
  });

  app.patch("/projects/:id", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const r = container.projectRepo.findById(id);
    if (!r) return { error: "project not found" };
    const updated = { ...r.data, ...body, id, updatedAt: new Date().toISOString() } as typeof r.data;
    container.projectRepo.upsert(updated, { key: updated.slug });
    return updated;
  });

  app.post("/projects/:id/activate", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.projectRepo.findById(id);
    if (!r) return { error: "project not found" };
    const p = { ...r.data, active: true, updatedAt: new Date().toISOString() };
    container.projectRepo.upsert(p, { key: p.slug });
    return p;
  });

  app.post("/projects/:id/deactivate", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.projectRepo.findById(id);
    if (!r) return { error: "project not found" };
    const p = { ...r.data, active: false, updatedAt: new Date().toISOString() };
    container.projectRepo.upsert(p, { key: p.slug });
    return p;
  });

  app.delete("/projects/:id", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    container.projectRepo.deleteById(id);
    return { ok: true };
  });

  // Sub-resources
  app.get("/projects/:id/agents", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.agentRepo.byProject(id);
  });

  app.get("/projects/:id/skills", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.projectRepo.findById(id);
    if (!r) return [];
    return r.data.settings.skills;
  });

  app.get("/projects/:id/memory", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.memoryRepo.byProject(id);
  });

  app.get("/projects/:id/workflows", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.workflowRepo.byProject(id);
  });

  app.get("/projects/:id/tasks", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.taskRepo.byProject(id);
  });

  app.get("/projects/:id/runs", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.runRepo.byProject(id);
  });

  app.get("/projects/:id/tests", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.runRepo.byProject(id).filter((r) => r.agentType === "qa-test");
  });

  app.get("/projects/:id/issues", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.projectRepo.findById(id);
    if (!r) return [];
    try {
      const [owner, ...rest] = r.data.configRepo.split("/");
      return container.github.listIssues({ owner, name: rest.join("/") });
    } catch {
      return [];
    }
  });

  app.get("/projects/:id/pull-requests", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.projectRepo.findById(id);
    if (!r) return [];
    try {
      const [owner, ...rest] = r.data.configRepo.split("/");
      return container.github.listPullRequests({ owner, name: rest.join("/") });
    } catch {
      return [];
    }
  });

  // Natural-language AI action on a project (routed through Agent Manager)
  app.post("/projects/:id/ask", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const project = container.projectRepo.findById(id);
    if (!project) return { error: "project not found" };
    const title = String(body.title ?? "AI request");
    const description = String(body.description ?? body.prompt ?? title);
    const task = container.agentManager.createTask({
      projectId: id,
      title,
      description,
      agentType: body.agentType as never,
      workflowId: body.workflowId as string | undefined,
      input: body.input as Record<string, unknown> | undefined,
    });
    const job = container.queue.enqueue("agent.run", { taskId: task.id }, { correlationId: task.correlationId });
    return { task, jobId: job.id };
  });

  // Re-run onboarding
  app.post("/projects/:id/onboard", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    return container.agentManager.onboardProject(id, (body.tech as string[]) ?? []);
  });

  app.get("/projects/:id/repositories", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.projectRepo.findById(id);
    if (!r) return [];
    return [
      { path: ".ai-engineering", role: "config", repo: r.data.configRepo, branch: r.data.branch },
    ];
  });

  // Attach a repository to a project.
  app.post("/projects/:id/repositories", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const r = container.projectRepo.findById(id);
    if (!r) return { error: "project not found" };
    const updated = { ...r.data, configRepo: String(body.repo ?? r.data.configRepo), branch: String(body.branch ?? r.data.branch), updatedAt: new Date().toISOString() };
    container.projectRepo.upsert(updated, { key: updated.slug });
    return updated;
  });

  void randomUUID;
}
