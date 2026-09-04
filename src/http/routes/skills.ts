import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import type { Skill } from "../../domain/entities.js";

export function registerSkillRoutes(app: FastifyInstance, container: Container): void {
  // Skill marketplace: list/search/filter
  app.get("/skills", { schema: { tags: ["skills"] } }, async (req) => {
    const q = (req.query as { q?: string; category?: string; enabled?: string }) ?? {};
    let skills = container.skillRepo.findMany().map((r) => r.data);
    if (q.category) skills = skills.filter((s) => s.category === q.category);
    if (q.enabled !== undefined) skills = skills.filter((s) => s.enabled === (q.enabled === "true"));
    if (q.q) skills = skills.filter((s) => `${s.name} ${s.description} ${s.slug}`.toLowerCase().includes(q.q!.toLowerCase()));
    return skills;
  });

  app.get("/skills/categories", { schema: { tags: ["skills"] } }, async () => {
    const skills = container.skillRepo.findMany().map((r) => r.data);
    return [...new Set(skills.map((s) => s.category))];
  });

  app.post("/skills", { schema: { tags: ["skills"] } }, async (req) => {
    const b = req.body as Record<string, unknown>;
    const skill = container.skillRepo.create({
      slug: String(b.slug ?? "skill"),
      name: String(b.name ?? "Skill"),
      description: String(b.description ?? ""),
      category: String(b.category ?? "general"),
      instructions: String(b.instructions ?? ""),
      version: String(b.version ?? "1.0.0"),
      tools: (b.tools as string[]) ?? [],
      dependencies: (b.dependencies as string[]) ?? [],
      compatibleAgentTypes: (b.compatibleAgentTypes as string[]) ?? [],
      metadata: (b.metadata as Record<string, unknown>) ?? {},
      enabled: b.enabled !== false,
      builtIn: false,
    });
    return skill;
  });

  app.get("/skills/:id", { schema: { tags: ["skills"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.skillRepo.findById(id);
    if (!r) return { error: "skill not found" };
    return r.data;
  });

  app.patch("/skills/:id", { schema: { tags: ["skills"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const r = container.skillRepo.findById(id);
    if (!r) return { error: "skill not found" };
    const s = { ...r.data, ...b, id, updatedAt: new Date().toISOString() } as Skill;
    container.skillRepo.upsert(s, { key: s.slug });
    return s;
  });

  app.post("/skills/:id/enable", { schema: { tags: ["skills"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.skillRepo.findById(id);
    if (!r) return { error: "skill not found" };
    const s = { ...r.data, enabled: true, updatedAt: new Date().toISOString() };
    container.skillRepo.upsert(s, { key: s.slug });
    return s;
  });

  app.post("/skills/:id/disable", { schema: { tags: ["skills"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const r = container.skillRepo.findById(id);
    if (!r) return { error: "skill not found" };
    const s = { ...r.data, enabled: false, updatedAt: new Date().toISOString() };
    container.skillRepo.upsert(s, { key: s.slug });
    return s;
  });

  app.delete("/skills/:id", { schema: { tags: ["skills"] } }, async (req) => {
    const { id } = req.params as { id: string };
    container.skillRepo.deleteById(id);
    return { ok: true };
  });
}
