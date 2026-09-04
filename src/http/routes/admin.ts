import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import { getEnv } from "../../config/env.js";
import { ROLE_PERMISSIONS } from "../auth.js";

export function registerAdminRoutes(app: FastifyInstance, container: Container): void {
  // System health dashboard
  app.get("/admin/health", { schema: { tags: ["admin"] } }, async () => {
    const dbOk = await container.db.raw().prepare("SELECT 1 AS ok").get();
    const queueStats = container.queue.stats();
    const providerHealth = container.providerRegistry.all().map((p) => ({ id: p.id, kind: p.type }));
    return {
      api: { status: "healthy", pid: process.pid, uptime: process.uptime() },
      database: { status: dbOk ? "healthy" : "down", path: getEnv().DATABASE_PATH },
      queue: { status: "healthy", ...queueStats },
      github: { status: container.github.kind === "real" ? "connected" : "mock", kind: container.github.kind },
      telegram: { status: (await container.telegram.health()) ? "connected" : "mock" },
      providers: providerHealth,
    };
  });

  app.get("/admin/roles", { schema: { tags: ["admin"] } }, async () => {
    return ROLE_PERMISSIONS;
  });

  app.get("/admin/usage", { schema: { tags: ["admin"] } }, async () => {
    const costs = container.costRepo.findMany().map((r) => r.data);
    const runs = container.runRepo.findMany().map((r) => r.data);
    return {
      projects: container.projectRepo.count(),
      agents: container.agentRepo.count(),
      skills: container.skillRepo.count(),
      models: container.modelRepo.count(),
      tasks: container.taskRepo.count(),
      runs: runs.length,
      costs: {
        calls: costs.length,
        tokens: costs.reduce((s, c) => s + c.totalTokens, 0),
        costUsd: Math.round(costs.reduce((s, c) => s + c.estimatedCostUsd, 0) * 100) / 100,
      },
    };
  });

  app.get("/admin/provider-health", { schema: { tags: ["admin"] } }, async () => {
    return container.providerRegistry.all().map((p) => ({ id: p.id, type: p.type }));
  });

}
