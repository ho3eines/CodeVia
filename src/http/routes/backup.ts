import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Container } from "../../app/container.js";
import { ROLE_PERMISSIONS } from "../auth.js";
import { getStorageInfo } from "../../app/storage.js";
import {
  getBackupSettings,
  getEffectiveBackupSettings,
  saveBackupSettings,
  type SaveBackupSettingsInput,
} from "../../backup/settings.js";
import { nextCronTime, isValidCron } from "../../backup/cron.js";
import { getEnv } from "../../config/env.js";

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const allowed = ROLE_PERMISSIONS[req.user.role] ?? [];
  if (!allowed.includes("admin.write")) {
    reply.code(403);
    return false;
  }
  return true;
}

/**
 * Admin-only System Backup endpoints.
 *
 *  - GET  /admin/backup            current config + github/storage readiness
 *  - PUT  /admin/backup            save admin config (repo, branch, path, cron, retain)
 *  - POST /admin/backup/run        push a snapshot to the configured repo now
 *  - GET  /admin/backup/list       list committed snapshots
 *  - GET  /admin/backup/export     download the current full snapshot as JSON
 *  - POST /admin/backup/restore    restore from GitHub (latest or snapshot id) or a
 *                                  snapshotData object passed in the request body
 */
export function registerBackupRoutes(app: FastifyInstance, container: Container): void {
  app.get("/admin/backup", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const settings = getBackupSettings(container.kv);
    const effective = getEffectiveBackupSettings(container.kv);
    const validCron = isValidCron(effective.schedule);
    return {
      settings,
      effective,
      github: {
        kind: container.github.kind,
        connected: container.github.kind === "real",
        hint: container.github.kind === "real" ? undefined : "GitHub is in mock mode — set GITHUB_TOKEN and GITHUB_ENABLED=true to back up to a real repository.",
      },
      schedule: {
        cron: effective.schedule,
        valid: validCron,
        nextRunAt: validCron ? nextCronTime(effective.schedule)?.toISOString() : undefined,
      },
      storage: await getStorageInfo(),
      environment: getEnv().NODE_ENV,
    };
  });

  app.put("/admin/backup", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const b = (req.body ?? {}) as SaveBackupSettingsInput;
    try {
      const stored = saveBackupSettings(container.kv, b, req.user.id);
      await container.auditRepo.record({
        userId: req.user.id,
        action: "admin.backup.settings.update",
        result: "success",
        source: "web",
        correlationId: `admin-backup-${Date.now()}`,
        metadata: {
          enabled: stored.enabled ?? null,
          repo: stored.repo ?? null,
          branch: stored.branch ?? null,
          path: stored.path ?? null,
          schedule: stored.schedule ?? null,
          retain: stored.retain ?? null,
        },
      });
      return { ok: true, stored, effective: getEffectiveBackupSettings(container.kv) };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      reply.code(status);
      return { error: err instanceof Error ? err.message : "Invalid backup settings" };
    }
  });

  app.post("/admin/backup/run", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const result = await container.backupService.runNow();
    await container.auditRepo.record({
      userId: req.user.id,
      action: "admin.backup.run.manual",
      result: result.ok ? "success" : "failure",
      source: "web",
      correlationId: `admin-backup-${Date.now()}`,
      metadata: { repo: result.repo, branch: result.branch, commit: result.commit, error: result.error },
    });
    if (!result.ok && !result.warning) {
      reply.code(result.configured ? 500 : 400);
    }
    return result;
  });

  app.get("/admin/backup/list", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const q = req.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const settings = getEffectiveBackupSettings(container.kv);
    const backups = await container.backupService.listBackups({ repo: settings.repo, branch: settings.branch, path: settings.path }, limit);
    return { backups, configured: !!settings.repo, githubKind: container.github.kind };
  });

  app.get("/admin/backup/export", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const snapshot = await container.backupService.exportSnapshot();
    return snapshot;
  });

  app.post("/admin/backup/restore", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const b = (req.body ?? {}) as {
      snapshot?: string;
      snapshotData?: unknown;
      replace?: boolean;
      repo?: string;
      branch?: string;
      path?: string;
    };
    let result;
    if (b.snapshotData !== undefined) {
      result = container.backupService.restoreSnapshotObject(b.snapshotData, {
        replace: b.replace ?? true,
      });
    } else {
      result = await container.backupService.restoreFromGitHub({
        snapshot: b.snapshot,
        replace: b.replace ?? true,
        repo: b.repo,
        branch: b.branch,
        path: b.path,
      });
    }
    if (result.ok) {
      // Bring in-memory caches back in sync (built-in skills + default provider
      // adapters). This only adds missing defaults; restored custom data wins.
      await container.ensureSeed().catch(() => undefined);
      await container.auditRepo.record({
        userId: req.user.id,
        action: "admin.backup.restore",
        result: "success",
        source: "web",
        correlationId: `admin-restore-${Date.now()}`,
        metadata: {
          from: result.from,
          repo: result.repo,
          branch: result.branch,
          snapshot: result.snapshot,
          records: result.records,
          jobs: result.jobs,
          kv: result.kv,
          replace: result.replace,
        },
      });
    }
    if (!result.ok) reply.code(400);
    return result;
  });
}
