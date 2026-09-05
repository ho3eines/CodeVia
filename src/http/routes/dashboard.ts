import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";

export function registerDashboardRoutes(app: FastifyInstance, container: Container): void {
  app.get("/dashboard", { schema: { tags: ["dashboard"] } }, async () => {
    const projects = container.projectRepo.findMany();
    const agents = container.agentRepo.findMany();
    const runs = container.runRepo.findMany();
    const tasks = container.taskRepo.findMany();
    const costs = container.costRepo.findMany();
    const queueStats = container.queue.stats();

    const runningRuns = runs.filter((r) => r.data.status === "running");
    const pendingApprovals = container.approvals.list({ status: "pending" });

    return {
      totalProjects: projects.length,
      activeAgents: agents.filter((a) => a.data.enabled).length,
      runningTasks: tasks.filter((t) => t.data.status === "running").length,
      failedTasks: tasks.filter((t) => t.data.status === "failed").length,
      pendingApprovals: pendingApprovals.length,
      totalRuns: runs.length,
      queue: queueStats,
      modelUsage: {
        calls: costs.length,
        tokens: costs.reduce((s, c) => s + c.data.totalTokens, 0),
        costUsd: round2(costs.reduce((s, c) => s + c.data.estimatedCostUsd, 0)),
      },
      recentActivity: runs
        .slice(0, 10)
        .map((r) => ({
          runId: r.data.id,
          agentType: r.data.agentType,
          status: r.data.status,
          projectId: r.data.projectId,
          durationMs: r.data.durationMs,
          createdAt: r.data.createdAt,
        })),
    };
  });

  app.get("/dashboard/project/:projectId", { schema: { tags: ["dashboard"] } }, async (req) => {
    const p = (req.params as { projectId: string }).projectId;
    const project = container.projectRepo.findById(p)?.data;
    if (!project) return { error: "project not found" };
    const runs = container.runRepo.byProject(p);
    const agents = container.agentRepo.byProject(p);
    const tasks = container.taskRepo.byProject(p);
    const memory = container.memoryRepo.byProject(p);
    const costs = container.costRepo.totals({ projectId: p });
    return {
      project,
      status: project.active ? "active" : "inactive",
      repository: project.configRepo,
      activeAgents: agents.filter((a) => a.enabled).length,
      openTasks: tasks.filter((t) => t.status !== "succeeded").length,
      runCount: runs.length,
      cost: costs,
      memoryCount: memory.length,
      recentRuns: runs
        .slice(0, 8)
        .map((r) => ({ runId: r.id, agentType: r.agentType, status: r.status, durationMs: r.durationMs, createdAt: r.createdAt })),
      recentErrors: runs.filter((r) => r.status === "failed" || !!(r.error)).slice(0, 5).map((r) => ({ runId: r.id, error: r.error })),
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
