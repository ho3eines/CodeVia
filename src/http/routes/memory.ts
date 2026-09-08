import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import type { MemoryEntry } from "../../domain/entities.js";
import { randomUUID } from "node:crypto";
import { localId, memorySchema } from "../../github/state-codec.js";
import { accessibleProjectIds } from "../project-access.js";

export function registerMemoryRoutes(app: FastifyInstance, container: Container): void {
  app.get("/memory", { schema: { tags: ["memory"] } }, async (req) => {
    const q = req.query as { projectId?: string; type?: string; scope?: string };
    const owned = accessibleProjectIds(req, container);
    // Global (ownerless) memory is shared; project-attached memory is per-account.
    let data = (q.projectId ? container.memoryRepo.byProject(q.projectId).filter((d) => owned.has(q.projectId!)) : container.memoryRepo.findMany().map((r) => r.data).filter((d) => !d.projectId || owned.has(d.projectId)));
    if (q.type) data = data.filter((d) => d.type === q.type);
    if (q.scope) data = data.filter((d) => d.scope === q.scope);
    return data;
  });
  app.post("/memory", { schema: { tags: ["memory"] } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>, now = new Date().toISOString();
    const projectId = typeof b.projectId === "string" ? b.projectId : undefined;
    const type = String(b.type ?? "knowledge"), key = String(b.key ?? "entry");
    const entry = memorySchema.parse({ id: projectId ? localId(projectId, "memory", `${type}\0${key}`) : randomUUID(), projectId, type, key, scope: b.scope ?? "project", content: b.content ?? "", tags: b.tags ?? [], refs: b.refs ?? [], source: "web", version: 1, createdAt: now, updatedAt: now });
    if (projectId) {
      const p = container.projectRepo.findById(projectId)?.data;
      if (!p) return reply.code(404).send({ error: "project not found" });
      await container.projectFiles.updateMemory(p, (entries) => {
        if (entries.some((e) => e.id === entry.id)) throw Object.assign(new Error("Memory key/type already exists; update it explicitly"), { statusCode: 409 });
        return [...entries, entry];
      });
    } else container.memoryRepo.upsert(entry, { key });
    return entry;
  });
  app.get("/memory/:id", { schema: { tags: ["memory"] } }, async (req, reply) => container.memoryRepo.findById((req.params as { id: string }).id)?.data ?? reply.code(404).send({ error: "memory entry not found" }));
  app.patch("/memory/:id", { schema: { tags: ["memory"] } }, async (req, reply) => {
    const { id } = req.params as { id: string }; const rec = container.memoryRepo.findById(id)?.data;
    if (!rec) return reply.code(404).send({ error: "memory entry not found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch = Object.fromEntries(["key", "content", "tags", "refs", "type", "scope"].filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
    let updated: MemoryEntry;
    const edit = (current: MemoryEntry) => {
      const next = memorySchema.parse({ ...current, ...patch, version: current.version + 1, updatedAt: new Date().toISOString() });
      if (next.projectId) next.id = localId(next.projectId, "memory", `${next.type}\0${next.key}`);
      return next;
    };
    if (rec.projectId) {
      const p = container.projectRepo.findById(rec.projectId)!.data;
      await container.projectFiles.updateMemory(p, (entries) => {
        const current = entries.find((e) => e.id === id);
        if (!current) throw Object.assign(new Error("Memory entry was removed in the repository"), { statusCode: 409 });
        updated = edit(current);
        if (entries.some((e) => e.id !== id && e.id === updated.id)) throw Object.assign(new Error("Memory key/type already exists"), { statusCode: 409 });
        return [...entries.filter((e) => e.id !== id), updated];
      });
    } else { updated = edit(rec); container.memoryRepo.upsert(updated, { key: updated.key }); }
    return updated!;
  });
  app.delete("/memory/:id", { schema: { tags: ["memory"] } }, async (req) => {
    const { id } = req.params as { id: string }; const entry = container.memoryRepo.findById(id)?.data;
    if (entry?.projectId) {
      const p = container.projectRepo.findById(entry.projectId)!.data;
      await container.projectFiles.updateMemory(p, (entries) => entries.filter((e) => e.id !== id));
    } else container.memoryRepo.deleteById(id);
    return { ok: true };
  });
}
