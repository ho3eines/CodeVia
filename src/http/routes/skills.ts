import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import type { Skill } from "../../domain/entities.js";
import { randomUUID } from "node:crypto";
import { localId, renderSkillFile, SKILL_DIR, skillSchema, statePath } from "../../github/state-codec.js";

export function registerSkillRoutes(app: FastifyInstance, container: Container): void {
  const save = async (skill: Skill): Promise<Skill> => {
    const s = skillSchema.parse(skill);
    if (s.projectId) {
      const p = container.projectRepo.findById(s.projectId)?.data;
      if (!p) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
      await container.projectFiles.writeFiles(p, [{ path: statePath(SKILL_DIR, s.slug), content: renderSkillFile(s), sourceSha: skill.repositoryRevision }], "[CodeVia] save skill definition");
    }
    if (s.projectId) return container.skillRepo.findById(s.id)?.data ?? s;
    container.skillRepo.upsert(s, { key: s.slug });
    return s;
  };
  app.get("/skills", { schema: { tags: ["skills"] } }, async (req) => {
    const q = req.query as { projectId?: string; q?: string; category?: string; enabled?: string };
    let skills = q.projectId ? container.skillRepo.byProject(q.projectId) : container.skillRepo.globalCatalog();
    if (q.category) skills = skills.filter((s) => s.category === q.category);
    if (q.enabled !== undefined) skills = skills.filter((s) => s.enabled === (q.enabled === "true"));
    if (q.q) skills = skills.filter((s) => `${s.name} ${s.description} ${s.slug}`.toLowerCase().includes(q.q!.toLowerCase()));
    return skills;
  });
  app.get("/skills/categories", { schema: { tags: ["skills"] } }, async () => [...new Set(container.skillRepo.globalCatalog().map((s) => s.category))]);
  app.post("/skills", { schema: { tags: ["skills"] } }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const projectId = typeof b.projectId === "string" ? b.projectId : undefined;
    const slug = String(b.slug ?? "skill");
    if (container.skillRepo.findBySlug(slug, projectId)) throw Object.assign(new Error(`Skill slug ${slug} already exists`), { statusCode: 409 });
    const now = new Date().toISOString();
    let draft = skillSchema.parse({ id: projectId ? localId(projectId, "skill", slug) : randomUUID(), projectId,
      slug, name: String(b.name ?? "Skill"), description: String(b.description ?? ""), category: String(b.category ?? "general"),
      instructions: String(b.instructions ?? ""), version: String(b.version ?? "1.0.0"), tools: (b.tools as string[]) ?? [], dependencies: (b.dependencies as string[]) ?? [], compatibleAgentTypes: (b.compatibleAgentTypes as string[]) ?? [], metadata: (b.metadata as Record<string, unknown>) ?? {}, enabled: b.enabled !== false, builtIn: false, createdAt: now, updatedAt: now,
    });
    if (projectId && b.instructions === undefined) {
      const p = container.projectRepo.findById(projectId)?.data;
      if (!p) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
      draft = await container.agentManager.authorDefinition(p, draft, "skill");
    }
    return save(draft);
  });
  app.get("/skills/:id", { schema: { tags: ["skills"] } }, async (req, reply) => {
    const skill = container.skillRepo.findById((req.params as { id: string }).id)?.data;
    return skill ?? reply.code(404).send({ error: "skill not found" });
  });
  app.patch("/skills/:id", { schema: { tags: ["skills"] } }, async (req, reply) => {
    const { id } = req.params as { id: string }; const b = req.body as Record<string, unknown>;
    const old = container.skillRepo.findById(id)?.data;
    if (!old) return reply.code(404).send({ error: "skill not found" });
    if (b.projectId !== undefined && b.projectId !== old.projectId) return reply.code(400).send({ error: "Skill namespace cannot be changed" });
    if (old.projectId && b.slug !== undefined && b.slug !== old.slug) return reply.code(400).send({ error: "Rename the skill and its references in CodeVia together, then refresh" });
    return save({ ...old, ...b, id, projectId: old.projectId, updatedAt: new Date().toISOString() } as Skill);
  });
  for (const action of ["enable", "disable"] as const) app.post(`/skills/:id/${action}`, { schema: { tags: ["skills"] } }, async (req, reply) => {
    const old = container.skillRepo.findById((req.params as { id: string }).id)?.data;
    if (!old) return reply.code(404).send({ error: "skill not found" });
    return save({ ...old, enabled: action === "enable", updatedAt: new Date().toISOString() });
  });
  app.delete("/skills/:id", { schema: { tags: ["skills"] } }, async (req) => {
    const { id } = req.params as { id: string }; const old = container.skillRepo.findById(id)?.data;
    if (old?.projectId) {
      const p = container.projectRepo.findById(old.projectId)?.data;
      if (p) await container.projectFiles.tombstone(p, statePath(SKILL_DIR, old.slug));
    }
    container.skillRepo.deleteById(id); return { ok: true };
  });
}
