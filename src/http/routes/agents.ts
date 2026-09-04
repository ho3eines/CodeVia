import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import type { Agent } from "../../domain/entities.js";

export function registerAgentRoutes(app: FastifyInstance, container: Container): void {
  app.get("/agents", { schema: { tags: ["agents"] } }, async () => {
    return container.agentRepo.findMany().map((r) => r.data);
  });

  app.post("/agents", { schema: { tags: ["agents"] } }, async (req) => {
    const body = req.body as Record<string, unknown>;
    const agent = container.agentRepo.create({
      projectId: String(body.projectId),
      type: (body.type as Agent["type"]) ?? "backend-developer",
      name: String(body.name ?? "Agent"),
      slug: String(body.slug ?? body.type ?? "agent"),
      role: String(body.role ?? ""),
      description: String(body.description ?? ""),
      configPath: body.configPath as string | undefined,
      systemPrompt: String(body.systemPrompt ?? ""),
      projectPrompt: body.projectPrompt as string | undefined,
      skills: (body.skills as string[]) ?? [],
      tools: (body.tools as string[]) ?? [],
      permissions: (body.permissions as string[]) ?? [],
      models: body.models as Agent["models"] ?? { primary: "", fallbacks: [], specialized: {} },
      maxIterations: Number(body.maxIterations ?? 5),
      timeoutMs: Number(body.timeoutMs ?? 120000),
      tokenBudget: Number(body.tokenBudget ?? 20000),
      memorySources: (body.memorySources as string[]) ?? [],
      enabled: body.enabled !== false,
    });
    return agent;
  });

  app.get("/agents/:id", { schema: { tags: ["agents"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.agentRepo.findById(id);
    if (!r) return { error: "agent not found" };
    return r.data;
  });

  app.patch("/agents/:id", { schema: { tags: ["agents"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const r = container.agentRepo.findById(id);
    if (!r) return { error: "agent not found" };
    const updated: Agent = { ...r.data, ...body, id, version: r.data.version + 1, updatedAt: new Date().toISOString() } as Agent;
    container.agentRepo.upsert(updated, { projectId: updated.projectId });
    return updated;
  });

  app.post("/agents/:id/enable", { schema: { tags: ["agents"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.agentRepo.findById(id);
    if (!r) return { error: "agent not found" };
    const a = { ...r.data, enabled: true, updatedAt: new Date().toISOString() };
    container.agentRepo.upsert(a, { projectId: a.projectId });
    return a;
  });

  app.post("/agents/:id/disable", { schema: { tags: ["agents"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.agentRepo.findById(id);
    if (!r) return { error: "agent not found" };
    const a = { ...r.data, enabled: false, updatedAt: new Date().toISOString() };
    container.agentRepo.upsert(a, { projectId: a.projectId });
    return a;
  });

  app.get("/agents/:id/history", { schema: { tags: ["agents"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.runRepo.findMany({ parentId: id }).map((r) => r.data);
  });

  app.delete("/agents/:id", { schema: { tags: ["agents"] } }, async (req) => {
    const { id } = req.params as { id: string };
    container.agentRepo.deleteById(id);
    return { ok: true };
  });
}
