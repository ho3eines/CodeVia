import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Container } from "../../app/container.js";
import { getEnv } from "../../config/env.js";
import { ROLE_PERMISSIONS } from "../auth.js";
import type { UserRole } from "../../types.js";
import {
  getEffectiveGitHubLoginSettings,
  getGitHubAdminSettings,
  saveGitHubAdminSettings,
} from "../../auth/admin-settings.js";
import { getStorageInfo } from "../../app/storage.js";

/** Only owner/admin roles may read or change admin settings. */
function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const allowed = ROLE_PERMISSIONS[req.user.role] ?? [];
  if (!allowed.includes("admin.write")) {
    reply.code(403);
    return false;
  }
  return true;
}

const ASSIGNABLE_ROLES: UserRole[] = ["owner", "admin", "developer", "reviewer", "viewer"];

export function registerAdminRoutes(app: FastifyInstance, container: Container): void {
  // System health dashboard
  app.get("/admin/health", { schema: { tags: ["admin"] } }, async () => {
    const dbOk = await container.db.raw().prepare("SELECT 1 AS ok").get();
    const queueStats = container.queue.stats();
    const providerHealth = container.providerRegistry.all().map((p) => ({ id: p.id, kind: p.type }));
    return {
      api: { status: "healthy", pid: process.pid, uptime: process.uptime() },
      database: { status: dbOk ? "healthy" : "down", path: getEnv().DATABASE_PATH },
      // Persistence diagnostics: warns when the DB is on ephemeral container
      // storage (settings/users wiped on every Railway deploy).
      storage: await getStorageInfo(),
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

  // ---- Admin → GitHub Login settings (non-secret values; secrets stay env-only) ----
  app.get("/admin/settings", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const github = getEffectiveGitHubLoginSettings(container.kv);
    const users = container.userRepo.findMany().map((r) => r.data);
    return {
      github: {
        ...github,
        stored: getGitHubAdminSettings(container.kv),
        envOverrides: {
          clientId: !!getEnv().GITHUB_CLIENT_ID,
          callbackUrl: !!getEnv().GITHUB_OAUTH_CALLBACK_URL,
        },
      },
      users: {
        total: users.length,
        owners: users.filter((u) => u.role === "owner").length,
      },
    };
  });

  app.put("/admin/settings/github", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const b = (req.body ?? {}) as {
      clientId?: string;
      callbackUrl?: string;
      scope?: string;
      requireAuth?: boolean;
    };
    try {
      const stored = saveGitHubAdminSettings(container.kv, b, req.user.id);
      await container.auditRepo.record({
        userId: req.user.id,
        action: "admin.settings.github.update",
        result: "success",
        source: "web",
        correlationId: `admin-${Date.now()}`,
        metadata: {
          clientId: stored.clientId ?? null,
          callbackUrl: stored.callbackUrl ?? null,
          scope: stored.scope ?? null,
          requireAuth: stored.requireAuth ?? null,
        },
      });
      return { ok: true, stored, effective: getEffectiveGitHubLoginSettings(container.kv) };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      reply.code(status);
      return { error: err instanceof Error ? err.message : "Invalid settings" };
    }
  });

  // ---- Admin → user management ----
  app.get("/admin/users", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    return container.userRepo
      .findMany()
      .map((r) => r.data)
      .map((u) => ({
        id: u.id,
        externalId: u.externalId,
        name: u.name,
        email: u.email,
        role: u.role,
        avatarUrl: u.avatarUrl ?? null,
        createdAt: u.createdAt,
      }));
  });

  app.patch("/admin/users/:id/role", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const { id } = req.params as { id: string };
    const { role } = (req.body ?? {}) as { role?: string };
    if (!role || !(ASSIGNABLE_ROLES as string[]).includes(role)) {
      reply.code(400);
      return { error: `Invalid role (one of: ${ASSIGNABLE_ROLES.join(", ")})` };
    }
    const rec = container.userRepo.findById(id);
    if (!rec) {
      reply.code(404);
      return { error: "User not found" };
    }
    if (rec.data.role === "owner" && role !== "owner") {
      const owners = container.userRepo.findMany().map((r) => r.data).filter((u) => u.role === "owner");
      if (owners.length <= 1) {
        reply.code(400);
        return { error: "Cannot demote the last owner" };
      }
    }
    const updated = { ...rec.data, role: role as UserRole, updatedAt: new Date().toISOString() };
    container.userRepo.upsert(updated, { key: rec.data.externalId });
    await container.auditRepo.record({
      userId: req.user.id,
      action: "admin.user.role.update",
      result: "success",
      source: "web",
      correlationId: `admin-${Date.now()}`,
      metadata: { targetUserId: id, from: rec.data.role, to: role },
    });
    return { ok: true, user: updated };
  });
}
