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
import { readLocalSnapshotFiles } from "../../backup/local.js";
import { describeEnvironmentBundle } from "../../backup/secrets.js";
import { resolveLocalBackupDir } from "../../backup/local.js";
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
 *  - GET  /admin/backup                   current config + github/storage/secrets readiness
 *  - PUT  /admin/backup                   save admin config (repo, branch, path, cron, retain,
 *                                          includeEnv, includeSecrets, localCopy, localDir)
 *  - POST /admin/backup/run               take a snapshot now (GitHub + local copy)
 *  - GET  /admin/backup/list              list snapshots (GitHub and local)
 *  - GET  /admin/backup/export            the current full snapshot as JSON (inline)
 *  - GET  /admin/backup/download          the same, as an attachment — the "download my
 *                                         whole installation, API keys included" button
 *  - GET  /admin/backup/local/:id/download  download one stored local snapshot
 *  - POST /admin/backup/restore           restore from GitHub, from a local snapshot, or from
 *                                         a snapshotData / snapshotFiles body
 */
export function registerBackupRoutes(app: FastifyInstance, container: Container): void {
  app.get("/admin/backup", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const settings = getBackupSettings(container.kv);
    const effective = getEffectiveBackupSettings(container.kv);
    const validCron = isValidCron(effective.schedule);
    const env = getEnv();
    const passphraseSet = !!env.BACKUP_PASSPHRASE;
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
      environment: env.NODE_ENV,
      // What a snapshot will carry, and how it is protected. The UI shows this
      // next to the download button so nobody is surprised by a file that can
      // rebuild every integration — including its API keys.
      secrets: {
        includeEnv: effective.includeEnv,
        includeSecrets: effective.includeSecrets,
        storedEncrypted: passphraseSet,
        passphraseConfigured: passphraseSet,
        hint: effective.includeSecrets
          ? passphraseSet
            ? "Copies stored in the repository/volume are encrypted with BACKUP_PASSPHRASE; the file you download is plaintext."
            : "Backups contain live API keys and tokens in plaintext. Keep the backup repository private, or set BACKUP_PASSPHRASE to encrypt the stored copies."
          : "Credentials are NOT captured: a restore on a server with a different AUTH_SECRET brings the data back but not the API keys.",
      },
      local: {
        enabled: effective.localCopy,
        dir: resolveLocalBackupDir(container.db, effective.localDir),
        retain: effective.retain,
      },
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
          includeEnv: stored.includeEnv ?? null,
          includeSecrets: stored.includeSecrets ?? null,
          localCopy: stored.localCopy ?? null,
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
    const q = req.query as { limit?: string; source?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const settings = getEffectiveBackupSettings(container.kv);
    // `source=github|local` narrows the list; the default shows every snapshot
    // this installation could be restored from, newest first.
    const backups =
      q.source === "github"
        ? await container.backupService.listBackups(
            { repo: settings.repo, branch: settings.branch, path: settings.path },
            limit,
          )
        : q.source === "local"
          ? await container.backupService.listLocal(limit)
          : await container.backupService.listAll(limit);
    return {
      backups,
      configured: !!settings.repo,
      githubKind: container.github.kind,
      local: { enabled: settings.localCopy, dir: resolveLocalBackupDir(container.db, settings.localDir) },
    };
  });

  app.get("/admin/backup/export", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const snapshot = await container.backupService.exportSnapshot();
    return snapshot;
  });

  /**
   * The "download my whole installation" endpoint: one self-contained JSON file
   * with every runtime row AND the environment/credentials, so a new server can
   * be brought up by uploading it again. Plaintext by design — the admin asked
   * for the file; treat it like a key.
   */
  app.get("/admin/backup/download", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const snapshot = await container.backupService.exportSnapshot();
    const stamp = snapshot.createdAt.replace(/[:.]/g, "-");
    const summary = describeEnvironmentBundle(snapshot.environment);
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="codevia-full-backup-${stamp}.json"`);
    // Never cached or written to a shared log/CDN: this body holds credentials.
    reply.header("Cache-Control", "no-store");
    reply.header("X-CodeVia-Backup-Records", String(snapshot.records.length));
    reply.header("X-CodeVia-Backup-Credentials", String(summary?.dbSecrets ?? 0));
    await container.auditRepo.record({
      userId: req.user.id,
      action: "admin.backup.download",
      result: "success",
      source: "web",
      correlationId: `admin-backup-download-${Date.now()}`,
      metadata: {
        records: snapshot.records.length,
        jobs: snapshot.jobs.length,
        kv: snapshot.kv.length,
        credentials: summary?.dbSecrets ?? 0,
        environmentKeys: summary?.envKeys ?? 0,
      },
    });
    return reply.send(JSON.stringify(snapshot, null, 2));
  });

  /** Download one snapshot that was stored on this machine's volume. */
  app.get("/admin/backup/local/:id/download", { schema: { tags: ["admin"] } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: "Forbidden" };
    const id = (req.params as { id?: string }).id ?? "";
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
      reply.code(400);
      return { error: "Invalid backup snapshot id" };
    }
    const settings = getEffectiveBackupSettings(container.kv);
    const files = await readLocalSnapshotFiles(resolveLocalBackupDir(container.db, settings.localDir), id);
    if (!files.length) {
      reply.code(404);
      return { error: `No local snapshot "${id}"` };
    }
    // Rebuild the single-file snapshot from the stored parts (integrity-checked).
    // A passphrase-protected bundle needs the same passphrase used at creation.
    const passphrase = (req.query as { passphrase?: string }).passphrase;
    let snapshot;
    try {
      snapshot = snapshotFromFiles(files, { passphrase });
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "Snapshot could not be read" };
    }
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="codevia-backup-${id}.json"`);
    reply.header("Cache-Control", "no-store");
    return reply.send(JSON.stringify(snapshot, null, 2));
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
        /** "local" restores a snapshot stored on this machine's volume. */
        source?: string;
        /** Unlocks a bundle stored encrypted (BACKUP_PASSPHRASE). */
        passphrase?: string;
        /** Let backup values replace variables this server already has. */
        overwriteEnv?: boolean;
      };
      let result: BackupRestoreResult;
      if (b.source === "local") {
        result = await container.backupService.restoreFromLocal({
          snapshot: b.snapshot,
          replace: b.replace ?? true,
          passphrase: b.passphrase,
        });
      } else if (Array.isArray(b.snapshotFiles)) {
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
          result = container.backupService.restoreSnapshotObject(
            snapshotFromFiles(files, { passphrase: b.passphrase }),
            {
              replace: b.replace ?? true,
              passphrase: b.passphrase,
              overwriteEnv: b.overwriteEnv,
            },
          );
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
          passphrase: b.passphrase,
          overwriteEnv: b.overwriteEnv,
        });
      } else if (Array.isArray(body.records) && Array.isArray(body.jobs) && Array.isArray(body.kv)) {
        // Also accept a raw full snapshot as the request body for API clients
        // that upload the downloaded JSON file without wrapping it.
        result = container.backupService.restoreSnapshotObject(body, {
          replace: b.replace ?? true,
          passphrase: b.passphrase,
          overwriteEnv: b.overwriteEnv,
        });
      } else {
        result = await container.backupService.restoreFromGitHub({
          snapshot: b.snapshot,
          replace: b.replace ?? true,
          repo: b.repo,
          branch: b.branch,
          path: b.path,
          passphrase: b.passphrase,
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
        if (result.environment?.envApplied.length) {
          warnings.push(
            `Restored ${result.environment.envApplied.length} environment value(s)` +
              ` and re-encrypted ${result.environment.providers + result.environment.telegramAccounts + result.environment.githubTokens} credential(s)` +
              (result.environment.envFile?.ok ? ` · wrote ${result.environment.envFile.path}` : "") +
              ". The server is usable immediately; no restart needed.",
          );
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
            // How much of the installation came back with it — never the values.
            environment: result.environment
              ? {
                  envApplied: result.environment.envApplied.length,
                  envKept: result.environment.envKept.length,
                  providers: result.environment.providers,
                  telegramAccounts: result.environment.telegramAccounts,
                  githubTokens: result.environment.githubTokens,
                  envFile: result.environment.envFile?.path,
                }
              : undefined,
          },
        });
      }
      if (!result.ok) reply.code(400);
      return result;
    },
  );
}
