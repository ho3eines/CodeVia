import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import type { MemoryEntry, MemoryType, MemoryScope } from "../../domain/entities.js";
import { randomUUID } from "node:crypto";

export function registerMemoryRoutes(app: FastifyInstance, container: Container): void {
  app.get("/memory", { schema: { tags: ["memory"] } }, async (req) => {
    const q = req.query as { projectId?: string; type?: string; scope?: string };
    let entries = container.memoryRepo.findMany();
    if (q.projectId) entries = container.memoryRepo.findMany({ projectId: q.projectId });
    let data = entries.map((r) => r.data);
    if (q.type) data = data.filter((d) => d.type === q.type);
    if (q.scope) data = data.filter((d) => d.scope === q.scope);
    return data;
  });

  app.post("/memory", { schema: { tags: ["memory"] } }, async (req) => {
    const b = req.body as Record<string, unknown>;
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      projectId: b.projectId as string | undefined,
      scope: (b.scope as MemoryScope) ?? "project",
      type: (b.type as MemoryType) ?? "knowledge",
      key: String(b.key ?? "entry"),
      content: String(b.content ?? ""),
      tags: (b.tags as string[]) ?? [],
      refs: (b.refs as string[]) ?? [],
      source: "web",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    container.memoryRepo.upsert(entry, { projectId: entry.projectId, key: entry.key });
    // Also persist to the GitHub-backed store when available (source of truth).
    return entry;
  });

  app.get("/memory/:id", { schema: { tags: ["memory"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.memoryRepo.findById(id)?.data ?? { error: "memory entry not found" };
  });

  app.patch("/memory/:id", { schema: { tags: ["memory"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = container.memoryRepo.findById(id);
    if (!rec) {
      reply.code(404);
      return { error: "memory entry not found" };
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<MemoryEntry> = {};
    if (typeof b.key === "string" && b.key.trim()) patch.key = b.key.trim();
    if (typeof b.content === "string") patch.content = b.content;
    if (Array.isArray(b.tags)) patch.tags = b.tags.map((t) => String(t));
    if (Array.isArray(b.refs)) patch.refs = b.refs.map((t) => String(t));
    if (typeof b.type === "string" && ["architecture", "business", "technical", "decision", "bug", "knowledge", "lesson", "conversation"].includes(b.type)) {
      patch.type = b.type as MemoryType;
    }
    if (typeof b.scope === "string" && ["global", "project", "agent", "task", "conversation"].includes(b.scope)) {
      patch.scope = b.scope as MemoryScope;
    }
    const updated: MemoryEntry = {
      ...rec.data,
      ...patch,
      id,
      version: rec.data.version + 1,
      updatedAt: new Date().toISOString(),
    };
    container.memoryRepo.upsert(updated, { projectId: updated.projectId, key: updated.key });
    return updated;
  });

  app.delete("/memory/:id", { schema: { tags: ["memory"] } }, async (req) => {
    const { id } = req.params as { id: string };
    container.memoryRepo.deleteById(id);
    return { ok: true };
  });
}
