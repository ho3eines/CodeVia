import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";

export function registerSearchRoutes(app: FastifyInstance, container: Container): void {
  app.get("/search", { schema: { tags: ["search"] } }, async (req) => {
    const q = String((req.query as { q?: string }).q ?? "").toLowerCase();
    const results: Array<{ type: string; id: string; title: string; snippet: string }> = [];

    for (const r of container.projectRepo.findMany()) {
      if (`${r.data.name} ${r.data.description} ${r.data.slug}`.toLowerCase().includes(q)) {
        results.push({ type: "project", id: r.data.id, title: r.data.name, snippet: r.data.description.slice(0, 120) });
      }
    }
    for (const r of container.agentRepo.findMany()) {
      if (`${r.data.name} ${r.data.role} ${r.data.description}`.toLowerCase().includes(q)) {
        results.push({ type: "agent", id: r.data.id, title: r.data.name, snippet: r.data.description.slice(0, 120) });
      }
    }
    for (const r of container.taskRepo.findMany()) {
      if (`${r.data.title} ${r.data.description}`.toLowerCase().includes(q)) {
        results.push({ type: "task", id: r.data.id, title: r.data.title, snippet: r.data.description.slice(0, 120) });
      }
    }
    for (const r of container.skillRepo.findMany()) {
      if (`${r.data.name} ${r.data.description}`.toLowerCase().includes(q)) {
        results.push({ type: "skill", id: r.data.id, title: r.data.name, snippet: r.data.description.slice(0, 120) });
      }
    }
    for (const r of container.memoryRepo.findMany()) {
      if (`${r.data.key} ${r.data.content}`.toLowerCase().includes(q)) {
        results.push({ type: "memory", id: r.data.id, title: r.data.key, snippet: r.data.content.slice(0, 120) });
      }
    }
    return { query: q, results };
  });
}
