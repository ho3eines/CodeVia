import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import type { Agent } from "../../domain/entities.js";
import { diffLines, diffSummary } from "../../prompts/versions.js";
import { resolveRequestUser } from "../auth.js";

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
    container.promptVersionRepo.snapshot(agent, { source: "web:create" });
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
    if (updated.systemPrompt !== r.data.systemPrompt || (updated.projectPrompt ?? "") !== (r.data.projectPrompt ?? "")) {
      // Make sure the pre-edit text exists as a version so the first edit is diffable.
      container.promptVersionRepo.snapshot(r.data, { source: "web:baseline" });
      const { user } = resolveRequestUser(req, container);
      container.promptVersionRepo.snapshot(updated, { source: "web", note: typeof body.note === "string" ? body.note : undefined });
      container.auditRepo.record({
        action: "agent.prompt.changed",
        projectId: updated.projectId,
        agentId: id,
        userId: user.id,
        result: "success",
        source: "web",
        correlationId: `prompt-${id}-${Date.now()}`,
        metadata: { version: container.promptVersionRepo.latest(id)?.version },
      });
    }
    return updated;
  });

  /* ---------------- Prompt versioning ---------------- */

  const ensureBaseline = (agent: Agent) => {
    if (container.promptVersionRepo.forAgent(agent.id).length === 0) {
      container.promptVersionRepo.snapshot(agent, { source: "baseline" });
    }
  };

  app.get("/agents/:id/prompt-versions", { schema: { tags: ["agents"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.agentRepo.findById(id);
    if (!r) {
      reply.code(404);
      return { error: "agent not found" };
    }
    ensureBaseline(r.data);
    return container.promptVersionRepo.forAgent(id).map((v) => ({
      ...v,
      current: v.systemPrompt === r.data.systemPrompt && (v.projectPrompt ?? "") === (r.data.projectPrompt ?? ""),
    }));
  });

  app.get("/agents/:id/prompt-versions/diff", { schema: { tags: ["agents"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { from?: string; to?: string };
    const r = container.agentRepo.findById(id);
    if (!r) {
      reply.code(404);
      return { error: "agent not found" };
    }
    ensureBaseline(r.data);
    const versions = container.promptVersionRepo.forAgent(id);
    const pick = (v: string | undefined, fallback: number) => versions.find((x) => x.version === Number(v ?? fallback));
    const from = pick(q.from, Math.max(1, versions.length - 1));
    const to = q.to === "current" || q.to === undefined
      ? { version: 0, systemPrompt: r.data.systemPrompt, projectPrompt: r.data.projectPrompt }
      : pick(q.to, versions.length);
    if (!from || !to) {
      reply.code(404);
      return { error: "version not found" };
    }
    const lines = diffLines(from.systemPrompt, to.systemPrompt);
    return { from: from.version, to: to.version || "current", summary: diffSummary(lines), lines };
  });

  app.post("/agents/:id/prompt-versions/:version/restore", { schema: { tags: ["agents"] } }, async (req, reply) => {
    const { id, version } = req.params as { id: string; version: string };
    const r = container.agentRepo.findById(id);
    if (!r) {
      reply.code(404);
      return { error: "agent not found" };
    }
    const target = container.promptVersionRepo.forAgent(id).find((v) => v.version === Number(version));
    if (!target) {
      reply.code(404);
      return { error: "version not found" };
    }
    ensureBaseline(r.data);
    const restored: Agent = {
      ...r.data,
      systemPrompt: target.systemPrompt,
      projectPrompt: target.projectPrompt,
      version: r.data.version + 1,
      updatedAt: new Date().toISOString(),
    };
    container.agentRepo.upsert(restored, { projectId: restored.projectId });
    const snap = container.promptVersionRepo.snapshot(restored, { source: "restore", derivedFrom: target.version, note: `Restored from v${target.version}` });
    container.auditRepo.record({
      action: "agent.prompt.restored",
      projectId: restored.projectId,
      agentId: id,
      result: "success",
      source: "web",
      correlationId: `prompt-${id}-${Date.now()}`,
      metadata: { from: target.version, version: snap.version },
    });
    return { agent: restored, version: snap };
  });

  app.post("/agents/:id/prompt-versions/:version/clone", { schema: { tags: ["agents"] } }, async (req, reply) => {
    const { id, version } = req.params as { id: string; version: string };
    const body = (req.body ?? {}) as { targetAgentId?: string };
    const source = container.promptVersionRepo.forAgent(id).find((v) => v.version === Number(version));
    const targetRec = container.agentRepo.findById(body.targetAgentId ?? id);
    if (!source || !targetRec) {
      reply.code(404);
      return { error: "version or target agent not found" };
    }
    ensureBaseline(targetRec.data);
    const target: Agent = {
      ...targetRec.data,
      systemPrompt: source.systemPrompt,
      projectPrompt: source.projectPrompt,
      version: targetRec.data.version + 1,
      updatedAt: new Date().toISOString(),
    };
    container.agentRepo.upsert(target, { projectId: target.projectId });
    const snap = container.promptVersionRepo.snapshot(target, { source: "clone", derivedFrom: source.version, note: `Cloned from ${id} v${source.version}` });
    return { agent: target, version: snap };
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
