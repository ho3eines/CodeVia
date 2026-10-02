import { z } from "zod";
import type { KvStore } from "../db/kv.js";
import { getEnv } from "../config/env.js";
import { parseRepoFullName } from "../github/types.js";
import { isValidCron } from "./cron.js";

/* ------------------------------------------------------------------ *
 * Admin-only System Backup settings.
 *
 * The admin configures where a **full** snapshot of the installation goes: a
 * dedicated GitHub repository + branch, and (by default) a copy on disk next to
 * the database. The snapshot contains everything stored in the runtime DB
 * (projects, agents, models, providers, skills, workflows, tasks/runs,
 * conversations, memory, users, Telegram accounts, audit/cost/notifications, kv
 * settings) PLUS the environment and credentials that produced it — API keys,
 * GitHub/Telegram tokens, per-user GitHub OAuth tokens and AUTH_SECRET — so one
 * file can bring the same installation up on a different server. Scheduling uses
 * a five-field cron so the operator can pick the exact minute/hour/day-of-month.
 *
 * Because a backup can hold live credentials, `includeSecrets` is an explicit,
 * visible switch (default on — that is what makes a cross-server restore work),
 * and `BACKUP_PASSPHRASE` encrypts the copies that are stored rather than
 * downloaded. See docs/SYSTEM_BACKUP.md.
 * ------------------------------------------------------------------ */

export const BACKUP_SETTINGS_KEY = "admin.settings.backup";

export const DEFAULT_BACKUP_PATH = ".codevia/backups";
export const DEFAULT_BACKUP_SCHEDULE = "0 * * * *"; // every hour at :00

const BackupSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  /** `owner/name` or full GitHub URL. Empty = not configured. */
  repo: z.string().trim().max(256).optional(),
  branch: z.string().trim().max(128).optional(),
  /** Repo-relative base path for snapshots (safe, no leading slash / `..`). */
  path: z.string().trim().max(256).optional(),
  /** Five-field cron: minute hour day-of-month month day-of-week. */
  schedule: z.string().trim().max(64).optional(),
  /**
   * Capture the platform environment (every variable in `.env.example` plus
   * provider `secretRef` names) into the backup, so a new server comes up with
   * the same configuration instead of an empty one.
   */
  includeEnv: z.boolean().optional(),
  /**
   * Capture credentials in plaintext: API keys, GitHub/Telegram tokens, per-user
   * GitHub OAuth tokens and AUTH_SECRET. This is what makes a restore work on a
   * server with a *different* AUTH_SECRET. Turn it off to store database rows
   * only (secrets then stay in their encrypted, AUTH_SECRET-bound form).
   */
  includeSecrets: z.boolean().optional(),
  /** Also write every snapshot to disk next to the database (the mounted volume). */
  localCopy: z.boolean().optional(),
  /** Override for BACKUP_LOCAL_DIR (default `<database dir>/backups`). */
  localDir: z.string().trim().max(512).optional(),
  /**
   * The connected account whose GitHub token should push/restore the backup.
   * Backups run unattended, so there is no request to borrow a token from: the
   * admin who configured the repository lends their OAuth token (encrypted at
   * rest) instead of requiring a server-wide GITHUB_TOKEN. Falls back to the
   * server token when this account has no stored credential.
   */
  githubUserId: z.string().trim().max(128).optional(),
  /** Number of backup directories to keep referenced (actual repo history is git-managed). */
  retain: z.number().int().min(1).max(500).optional(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
  // Last run status (written by BackupService, not by the settings form).
  lastRunAt: z.string().optional(),
  lastRunStatus: z.enum(["success", "failed", "running"]).optional(),
  lastRunError: z.string().optional(),
  lastRunCommit: z.string().optional(),
  lastRunFiles: z.number().int().optional(),
  lastRunBytes: z.number().int().optional(),
  lastRunCounts: z.record(z.string(), z.number().int()).optional(),
});

export type BackupSettings = z.infer<typeof BackupSettingsSchema>;

export type SaveBackupSettingsInput = Partial<{
  enabled: boolean;
  repo: string;
  branch: string;
  path: string;
  schedule: string;
  retain: number;
  githubUserId: string;
  includeEnv: boolean;
  includeSecrets: boolean;
  localCopy: boolean;
  localDir: string;
}>;

const BRANCH_RE = /^[A-Za-z0-9._-]+$/;

function clean(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** Read the stored admin config (no validation on write, only raw read). */
export function getBackupSettings(kv: KvStore): BackupSettings {
  const raw = kv.get<unknown>(BACKUP_SETTINGS_KEY);
  if (!raw || typeof raw !== "object") return {};
  const parsed = BackupSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * Validate + persist admin backup config. Throws a 400-compatible error for
 * bad repository names, branch names, paths or cron expressions.
 */
export function saveBackupSettings(kv: KvStore, input: SaveBackupSettingsInput, updatedBy?: string): BackupSettings {
  const repo = clean(input.repo);
  if (input.repo !== undefined && (!repo || !parseRepoFullName(repo))) {
    throw Object.assign(new Error("Repository must be in owner/name form (or a valid GitHub URL)"), {
      statusCode: 400,
    });
  }
  const branch = clean(input.branch);
  if (input.branch !== undefined) {
    if (!branch || !BRANCH_RE.test(branch)) {
      throw Object.assign(new Error("Branch contains invalid characters"), { statusCode: 400 });
    }
  }
  const path = clean(input.path);
  if (input.path !== undefined) {
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
    ) {
      throw Object.assign(new Error("Backup path must be a safe repo-relative path (e.g. .codevia/backups)"), {
        statusCode: 400,
      });
    }
  }
  const schedule = clean(input.schedule);
  if (input.schedule !== undefined) {
    if (!schedule || !isValidCron(schedule)) {
      throw Object.assign(
        new Error(
          'Schedule must be a five-field cron expression: "minute hour day-of-month month day-of-week" (e.g. "0 * * * *" for hourly)',
        ),
        { statusCode: 400 },
      );
    }
  }
  const retain = input.retain === undefined ? undefined : Math.trunc(input.retain);
  if (retain !== undefined && (Number.isNaN(retain) || retain < 1 || retain > 500)) {
    throw Object.assign(new Error("retain must be between 1 and 500"), { statusCode: 400 });
  }
  const localDir = clean(input.localDir);
  if (input.localDir !== undefined && localDir && localDir.includes("\0")) {
    throw Object.assign(new Error("Local backup directory is not a valid path"), { statusCode: 400 });
  }

  const prev = getBackupSettings(kv);
  const next: BackupSettings = {
    ...prev,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    ...(retain !== undefined ? { retain } : {}),
    ...(input.githubUserId !== undefined ? { githubUserId: clean(input.githubUserId) } : {}),
    ...(input.includeEnv !== undefined ? { includeEnv: input.includeEnv } : {}),
    ...(input.includeSecrets !== undefined ? { includeSecrets: input.includeSecrets } : {}),
    ...(input.localCopy !== undefined ? { localCopy: input.localCopy } : {}),
    ...(input.localDir !== undefined ? { localDir } : {}),
    updatedAt: new Date().toISOString(),
    ...(updatedBy ? { updatedBy } : {}),
  };
  if (input.repo !== undefined && repo === undefined) delete next.repo;
  if (input.branch !== undefined && branch === undefined) delete next.branch;
  if (input.path !== undefined && path === undefined) delete next.path;
  if (input.schedule !== undefined && schedule === undefined) delete next.schedule;
  if (input.localDir !== undefined && localDir === undefined) delete next.localDir;

  const parsed = BackupSettingsSchema.parse(next);
  kv.set(BACKUP_SETTINGS_KEY, parsed);
  return parsed;
}

/** Rewrite only the last-run bookkeeping fields (not form-editable config). */
export function updateBackupStatus(
  kv: KvStore,
  patch: Partial<
    Pick<
      BackupSettings,
      | "lastRunAt"
      | "lastRunStatus"
      | "lastRunError"
      | "lastRunCommit"
      | "lastRunFiles"
      | "lastRunBytes"
      | "lastRunCounts"
    >
  >,
): BackupSettings {
  const prev = getBackupSettings(kv);
  const next: BackupSettings = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  kv.set(BACKUP_SETTINGS_KEY, next);
  return next;
}

/** Effective settings with defaults filled in, for service + UI display. */
export function getEffectiveBackupSettings(
  kv: KvStore,
): Required<
  Pick<
    BackupSettings,
    "enabled" | "branch" | "path" | "schedule" | "retain" | "includeEnv" | "includeSecrets" | "localCopy"
  >
> &
  BackupSettings {
  const s = getBackupSettings(kv);
  const env = getEnv();
  return {
    enabled: s.enabled ?? false,
    branch: s.branch ?? "main",
    path: s.path ?? DEFAULT_BACKUP_PATH,
    schedule: s.schedule ?? DEFAULT_BACKUP_SCHEDULE,
    retain: s.retain ?? 30,
    // The admin panel wins; the environment provides the installation default.
    includeEnv: s.includeEnv ?? env.BACKUP_INCLUDE_ENV,
    includeSecrets: s.includeSecrets ?? env.BACKUP_INCLUDE_SECRETS,
    localCopy: s.localCopy ?? env.BACKUP_LOCAL_COPY,
    ...s,
  };
}
