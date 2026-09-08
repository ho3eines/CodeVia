import type { FastifyInstance } from "fastify";
import type { Container } from "../app/container.js";
import { hydrateProject } from "../domain/project-options.js";
import { logger } from "../logger.js";
import { adoptProjectConnection } from "../auth/project-connection.js";
import { getUserGitHubToken } from "../auth/github-tokens.js";
import { canAccessProject, resolveRequestUser } from "./auth.js";

/** 404 that reveals neither the project's existence nor who owns it. */
function notFound(): never {
  throw Object.assign(new Error("project not found"), { statusCode: 404 });
}

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

/**
 * Per-account isolation for the definition sub-resources.
 *
 * The primary `/projects` routes already gate through `canAccessProject`, but
 * the workflows/agents/tasks/memory/skills/conversations/runs routes historically
 * never checked ownership — they only verified the project *existed*. That let
 * one account read/edit/run/delete another account's definitions by guessing an
 * id. This hook centralizes the same rule for every project-scoped request:
 * resolve the target project, reject foreign ones with a hidden 404, and bind
 * the acting (authenticated) owner's GitHub connection so state writes use that
 * account's own credential.
 */
export function registerProjectStateHook(app: FastifyInstance, c: Container): void {
  app.addHook("preHandler", async (req) => {
    const route = req.routeOptions.url ?? "";
    const resource = route.split("/")[1];
    if (!["projects", "agents", "skills", "memory", "workflows", "conversations", "tasks", "runs", "search"].includes(resource)) return;
    if (route === "/projects/options" || route === "/agents/types" || route === "/skills/categories") return;
    // Runs/retry and live executor routes must keep working during a GitHub
    // outage, so they are handled below (guarded + bound) but never force a
    // repository read.
    const isOfflineOk = (resource === "tasks" && req.method !== "GET") || route === "/runs/:id/retry";

    const params = (req.params ?? {}) as Record<string, string>;
    const query = (req.query ?? {}) as Record<string, unknown>;
    const body = (req.body ?? {}) as Record<string, unknown>;
    let projectId = resource === "projects" ? params.id : typeof query.projectId === "string" ? query.projectId : typeof body.projectId === "string" ? body.projectId : undefined;
    if (!projectId && params.id) {
      const repos = { agents: c.agentRepo, skills: c.skillRepo, memory: c.memoryRepo, workflows: c.workflowRepo, conversations: c.conversationRepo, tasks: c.taskRepo, runs: c.runRepo };
      const repo = repos[resource as keyof typeof repos];
      projectId = repo?.findById(params.id)?.data.projectId;
    }
    const { user, authenticated } = resolveRequestUser(req, c);
    // The acting (authenticated) owner's GitHub account, when one is present.
    const actingUserId = authenticated && getUserGitHubToken(c.kv, user.id) ? user.id : undefined;
    const bind = (p: { id: string }) => {
      const stored = c.projectRepo.findById(p.id)?.data;
      if (stored) adoptProjectConnection({ kv: c.kv, projectRepo: c.projectRepo, project: stored, userId: actingUserId });
    };

    if (projectId) {
      const p = c.projectRepo.findById(projectId)?.data;
      if (!p) notFound();
      // Ownership gate — mirrors canAccessProject (demo/shared projects stay
      // open in single-user mode; foreign owned projects are hidden).
      if (!canAccessProject(user, p)) notFound();
      bind(p);
      // Live executor / cancellation routes never block on a repository read.
      if (isOfflineOk) return;
      await c.agentManager.readProject(p.id);
      await bootstrapMissingState(c, projectId);
      return;
    }
    // /skills without projectId is intentionally the global TEMPLATE marketplace.
    if (resource === "skills") return;
    if (req.method === "GET") {
      for (const { data: p } of c.projectRepo.findMany()) {
        if (!p.ownerId || p.ownerId === user.id) {
          bind(p);
          await c.agentManager.readProject(p.id);
          await bootstrapMissingState(c, p.id);
        }
      }
    }
  });
}
