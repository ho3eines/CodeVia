import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";

export function registerObservabilityRoutes(app: FastifyInstance, container: Container): void {
  // Notifications
  app.get("/notifications", { schema: { tags: ["observability"] } }, async () => {
    return container.notificationRepo.findMany().map((r) => r.data);
  });

  app.post("/notifications/:id/read", { schema: { tags: ["observability"] } }, async (req) => {
    const { id } = req.params as { id: string };
    container.notificationRepo.markRead(id);
    return { ok: true };
  });

  // Cost tracking
  app.get("/costs", { schema: { tags: ["observability"] } }, async (req) => {
    const q = req.query as { projectId?: string; agentId?: string };
    let costs = container.costRepo.findMany().map((r) => r.data);
    if (q.projectId) costs = costs.filter((c) => c.projectId === q.projectId);
    if (q.agentId) costs = costs.filter((c) => c.agentId === q.agentId);
    return costs;
  });

  app.get("/costs/summary", { schema: { tags: ["observability"] } }, async (req) => {
    const q = req.query as { projectId?: string };
    const all = container.costRepo.findMany().map((r) => r.data);
    const filtered = q.projectId ? all.filter((c) => c.projectId === q.projectId) : all;
    return {
      calls: filtered.length,
      tokens: filtered.reduce((s, c) => s + c.totalTokens, 0),
      costUsd: round2(filtered.reduce((s, c) => s + c.estimatedCostUsd, 0)),
      byModel: aggregate(filtered, (c) => c.modelId ?? "unknown"),
      byAgent: aggregate(filtered, (c) => c.agentId ?? "unknown"),
      byProject: aggregate(filtered, (c) => c.projectId ?? "unknown"),
    };
  });

  // Audit log
  app.get("/audit", { schema: { tags: ["observability"] } }, async () => {
    return container.auditRepo.findMany().map((r) => r.data);
  });

  // Agent observability dashboard
  app.get("/observability/agents", { schema: { tags: ["observability"] } }, async (req) => {
    const q = req.query as { agentId?: string; projectId?: string };
    let runs = container.runRepo.findMany().map((r) => r.data);
    if (q.agentId) runs = runs.filter((r) => r.agentId === q.agentId);
    if (q.projectId) runs = runs.filter((r) => r.projectId === q.projectId);
    const byAgent = new Map<string, typeof runs>();
    for (const r of runs) {
      const list = byAgent.get(r.agentId) ?? [];
      list.push(r);
      byAgent.set(r.agentId, list);
    }
    return [...byAgent.entries()].map(([agentId, list]) => ({
      agentId,
      totalRuns: list.length,
      success: list.filter((r) => r.status === "succeeded").length,
      failure: list.filter((r) => r.status === "failed").length,
      avgDuration: Math.round(list.reduce((s, r) => s + r.durationMs, 0) / list.length),
      tokens: list.reduce((s, r) => s + r.totalTokens, 0),
      costUsd: round2(list.reduce((s, r) => s + r.costUsd, 0)),
      errorRate: list.length ? round2((list.filter((r) => r.status === "failed").length / list.length) * 100) : 0,
      recent: list.slice(0, 5).map((r) => ({ runId: r.id, status: r.status, createdAt: r.createdAt })),
    }));
  });

  app.get("/logs", { schema: { tags: ["observability"] } }, async () => {
    return container.runRepo.findMany().map((r) => ({ runId: r.data.id, status: r.data.status, error: r.data.error, createdAt: r.data.createdAt }));
  });
}

function aggregate(records: Array<{ totalTokens: number; estimatedCostUsd: number }>, keyFn: (r: any) => string): Array<{ key: string; calls: number; tokens: number; costUsd: number }> {
  const map = new Map<string, { calls: number; tokens: number; costUsd: number }>();
  for (const r of records) {
    const key = keyFn(r);
    const cur = map.get(key) ?? { calls: 0, tokens: 0, costUsd: 0 };
    cur.calls += 1;
    cur.tokens += r.totalTokens;
    cur.costUsd += r.estimatedCostUsd;
    map.set(key, cur);
  }
  return [...map.entries()].map(([key, v]) => ({ key, ...v, costUsd: round2(v.costUsd) }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
