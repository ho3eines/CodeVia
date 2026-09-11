import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import { accessibleProjectIds } from "../project-access.js";
import { ROLE_PERMISSIONS, resolveRequestUser } from "../auth.js";

export function registerObservabilityRoutes(app: FastifyInstance, container: Container): void {
  // Notifications. Project notifications belong to the project's account;
  // platform-wide ones (no projectId — backups, system health) stay visible to
  // everyone, which is what the notification bell expects.
  app.get("/notifications", { schema: { tags: ["observability"] } }, async (req) => {
    const owned = accessibleProjectIds(req, container);
    return container.notificationRepo
      .findMany()
      .map((r) => r.data)
      .filter((n) => !n.projectId || owned.has(n.projectId));
  });

  app.post("/notifications/:id/read", { schema: { tags: ["observability"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const owned = accessibleProjectIds(req, container);
    const notification = container.notificationRepo.findById(id)?.data;
    // Marking another account's notification read is not an information-free
    // no-op: it confirms the id exists. Answer 404 like the list does.
    if (!notification || (notification.projectId && !owned.has(notification.projectId))) {
      reply.code(404);
      return { error: "notification not found" };
    }
    container.notificationRepo.markRead(id);
    return { ok: true };
  });

  // Cost tracking
  app.get("/costs", { schema: { tags: ["observability"] } }, async (req) => {
    const q = req.query as { projectId?: string; agentId?: string };
    // Spend is per-account: only costs of projects this account may access.
    const owned = accessibleProjectIds(req, container);
    let costs = container.costRepo.findMany().map((r) => r.data).filter((c) => !c.projectId || owned.has(c.projectId));
    if (q.projectId) costs = costs.filter((c) => c.projectId === q.projectId);
    if (q.agentId) costs = costs.filter((c) => c.agentId === q.agentId);
    return costs;
  });

  app.get("/costs/summary", { schema: { tags: ["observability"] } }, async (req) => {
    const q = req.query as { projectId?: string };
    const owned = accessibleProjectIds(req, container);
    const all = container.costRepo.findMany().map((r) => r.data).filter((c) => !c.projectId || owned.has(c.projectId));
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

  /**
   * Audit log. An entry is visible when it belongs to a project this account
   * may access, or when it records this account's own action (logins, project
   * creation). Platform-level entries with neither are admin-only — they leak
   * other accounts' identities otherwise.
   */
  app.get("/audit", { schema: { tags: ["observability"] } }, async (req) => {
    const { user } = resolveRequestUser(req, container);
    const owned = accessibleProjectIds(req, container);
    const isAdmin = (ROLE_PERMISSIONS[user.role] ?? []).includes("admin.read");
    return container.auditRepo
      .findMany()
      .map((r) => r.data)
      .filter((e) => e.projectId ? owned.has(e.projectId) : isAdmin || e.userId === user.id);
  });

  // Agent observability dashboard
  app.get("/observability/agents", { schema: { tags: ["observability"] } }, async (req) => {
    const q = req.query as { agentId?: string; projectId?: string };
    const owned = accessibleProjectIds(req, container);
    let runs = container.runRepo.findMany().map((r) => r.data).filter((r) => owned.has(r.projectId));
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
