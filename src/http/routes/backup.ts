import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Container } from "../../app/container.js";
import { ROLE_PERMISSIONS, resolveRequestUser } from "../auth.js";
import { getStorageInfo } from "../../app/storage.js";
import {
  getBackupSettings,
  getEffectiveBackupSettings,
  saveBackupSettings,
  type SaveBackupSettingsInput,
} from "../../backup/settings.js";
import { nextCronTime, isValidCron } from "../../backup/cron.js";
import { getEnv } from "../../config/env.js";
import { snapshotFromFiles } from "../../backup/snapshot.js";
import type { BackupRestoreResult } from "../../backup/service.js";

/** Large, but bounded: JSON snapshots can contain years of runs/conversations. */
const RESTORE_BODY_LIMIT = 128 * 1024 * 1024;

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
        // Backups run on a schedule with no signed-in user, so they need the
        // server credential — a per-user OAuth login cannot stand in for it.
        hint:
          container.github.kind === "real"
            ? undefined
            : "Backups run unattended and need a server credential: set GITHUB_TOKEN and GITHUB_ENABLED=true. Logging in with GitHub connects your projects, but does not back them up.",
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
      // The account configuring the backup lends its GitHub token to the
      // unattended job (backups run on a schedule, with no request to borrow a
      // credential from). GITHUB_TOKEN stays as the fallback.
      const { user, authenticated } = resolveRequestUser(req, container);
      const stored = saveBackupSettings(
        container.kv,
        { ...b, ...(b.githubUserId === undefined && authenticated ? { githubUserId: user.id } : {}) },
        req.user.id,
      );
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
    const backups = await container.backupService.listBackups(
      { repo: settings.repo, branch: settings.branch, path: settings.path },
      limit,
    );
    return { backups, configured: !!settings.repo, githubKind: container.github.kind };
  });

  app.get("/admin/backup/export", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const snapshot = await container.backupService.exportSnapshot();
    return snapshot;
  });

  app.post(
    "/admin/backup/restore",
    { schema: { tags: ["admin"] }, bodyLimit: RESTORE_BODY_LIMIT },
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return { error: "Forbidden" };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const b = body as {
        snapshot?: string;
        snapshotData?: unknown;
        snapshotFiles?: unknown;
        replace?: boolean;
        repo?: string;
        branch?: string;
        path?: string;
      };
      let result: BackupRestoreResult;
      if (Array.isArray(b.snapshotFiles)) {
        const files = b.snapshotFiles.map((rawFile, index) => {
          const file = rawFile && typeof rawFile === "object" ? (rawFile as Record<string, unknown>) : {};
          return {
            path:
              typeof file.path === "string"
                ? file.path
                : typeof file.name === "string"
                  ? file.name
                  : `upload-${index}.json`,
            content: typeof file.content === "string" ? file.content : "",
          };
        });
        try {
          result = container.backupService.restoreSnapshotObject(snapshotFromFiles(files), {
            replace: b.replace ?? true,
          });
        } catch (err) {
          result = {
            ok: false,
            from: "snapshot",
            records: 0,
            jobs: 0,
            kv: 0,
            replace: b.replace ?? true,
            error: err instanceof Error ? err.message : "Invalid backup files",
          };
        }
      } else if (b.snapshotData !== undefined) {
        let snapshotData: unknown = b.snapshotData;
        if (typeof snapshotData === "string") {
          try {
            snapshotData = JSON.parse(snapshotData) as unknown;
          } catch {
            reply.code(400);
            return { ok: false, error: "Uploaded snapshotData is not valid JSON" };
          }
        }
        result = container.backupService.restoreSnapshotObject(snapshotData, {
          replace: b.replace ?? true,
        });
      } else if (Array.isArray(body.records) && Array.isArray(body.jobs) && Array.isArray(body.kv)) {
        // Also accept a raw full snapshot as the request body for API clients
        // that upload the downloaded JSON file without wrapping it.
        result = container.backupService.restoreSnapshotObject(body, {
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
        // Restore replaces durable rows, so rebuild process-level caches and
        // start/stop per-user Telegram pollers to match the restored accounts.
        const warnings: string[] = [];
        try {
          // No execution is alive for queue rows captured as `running` in the
          // backup; recover idempotent agent/workflow jobs immediately instead
          // of waiting for their old lease to expire.
          container.queue.recoverInterruptedExecutions();
          container.loadBalancer.reset();
          await container.ensureSeed();
        } catch (err) {
          warnings.push(`Provider/model cache refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
          await container.telegramRuntime.syncAccountPollers();
        } catch (err) {
          warnings.push(`Telegram account runtime refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (warnings.length) result.warning = warnings.join("; ");
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
            warning: result.warning,
          },
        });
      }
      if (!result.ok) reply.code(400);
      return result;
    },
  );
}
