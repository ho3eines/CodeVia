import type { FastifyInstance } from "fastify";
import type { Container } from "../app/container.js";
import { hydrateProject } from "../domain/project-options.js";
import { logger } from "../logger.js";

/**
 * A project whose repository state was never initialized (fresh mock repo,
 * restored database, migrated install) gets its missing definitions authored
 * once — mock/simulation connections only, so a real repository is never
 * written without an explicit onboarding action. Idempotent: projects that
 * already carry state (or agents) are left untouched.
 */
async function bootstrapMissingState(c: Container, projectId: string): Promise<void> {
  // Re-read after restore: a repository manifest marks the project initialized.
  const p = c.projectRepo.findById(projectId)?.data;
  if (!p || p.repositoryState || c.agentRepo.byProject(projectId).length > 0) return;
  try {
    if (c.githubForProject(hydrateProject(p)).kind !== "mock") return;
  } catch {
    return; // unreachable connection — leave initialization to explicit onboarding
  }
  try {
    await c.agentManager.refreshProject(projectId);
    logger.info("auto-initialized missing project state", { component: "project-state", projectId, repo: p.configRepo });
  } catch (err) {
    // The read already succeeded; a failed bootstrap must not break the page.
    logger.warn("auto-initialization of missing project state failed", { component: "project-state", projectId, repo: p.configRepo, err: String(err) });
  }
}

/** Repository-backed views never silently substitute stale DB definitions. */
export function registerProjectStateHook(app: FastifyInstance, c: Container): void {
  app.addHook("preHandler", async (req) => {
    const route = req.routeOptions.url ?? "";
    const resource = route.split("/")[1];
    if (!["projects", "agents", "skills", "memory", "workflows", "conversations", "tasks", "runs", "search"].includes(resource)) return;
    if (route === "/projects/options" || route === "/agents/types" || route === "/skills/categories") return;
    // Cancellation belongs to the live executor and must work even during a GitHub outage.
    if ((resource === "tasks" && req.method !== "GET") || route === "/runs/:id/retry") return;
    const params = (req.params ?? {}) as Record<string, string>;
    const query = (req.query ?? {}) as Record<string, unknown>;
    const body = (req.body ?? {}) as Record<string, unknown>;
    let projectId = resource === "projects" ? params.id : typeof query.projectId === "string" ? query.projectId : typeof body.projectId === "string" ? body.projectId : undefined;
    if (!projectId && params.id) {
      const repos = { agents: c.agentRepo, skills: c.skillRepo, memory: c.memoryRepo, workflows: c.workflowRepo, conversations: c.conversationRepo, tasks: c.taskRepo, runs: c.runRepo };
      const repo = repos[resource as keyof typeof repos];
      projectId = repo?.findById(params.id)?.data.projectId;
    }
    if (projectId) {
      const p = c.projectRepo.findById(projectId)?.data;
      if (p) {
        await c.agentManager.readProject(p.id);
        await bootstrapMissingState(c, projectId);
      }
      return;
    }
    // /skills without projectId is intentionally the global TEMPLATE marketplace.
    if (resource === "skills") return;
    if (req.method === "GET") {
      for (const { data: p } of c.projectRepo.findMany()) {
        if (!p.ownerId || p.ownerId === req.user?.id) {
          await c.agentManager.readProject(p.id);
          await bootstrapMissingState(c, p.id);
        }
      }
    }
  });
}
