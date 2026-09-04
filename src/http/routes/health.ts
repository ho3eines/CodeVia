import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";

export function registerHealthRoutes(app: FastifyInstance, container: Container): void {
  app.get("/health", { schema: { tags: ["health"] } }, async () => {
    return {
      status: "ok",
      service: "codevia-platform",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/ready", { schema: { tags: ["health"] } }, async () => {
    const dbOk = await container.db.raw().prepare("SELECT 1 AS ok").get();
    return { status: "ready", database: Boolean(dbOk) };
  });

  app.get("/live", { schema: { tags: ["health"] } }, async () => {
    return { status: "alive", pid: process.pid };
  });
}
