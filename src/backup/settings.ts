import { z } from "zod";
import type { KvStore } from "../db/kv.js";
import { parseRepoFullName } from "../github/types.js";
import { isValidCron } from "./cron.js";

/* ------------------------------------------------------------------ *
 * Admin-only System Backup settings.
 *
 * The admin configures a dedicated GitHub repository + branch the platform
 * pushes a full snapshot of everything stored in the runtime DB (projects,
 * agents, models, providers, skills, workflows, tasks/runs, conversations,
 * memory, users, Telegram accounts, audit/cost/notifications, kv settings)
 * into. Scheduling uses a five-field cron so the operator can pick the exact
 * minute/hour/day-of-month. All values are non-secret config stored in kv;
 * the actual snapshots are JSON files in the configured repo. Encrypted
 * secret material inside records is included only in its already-encrypted
 * form (never plaintext).
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
    throw Object.assign(new Error("Repository must be in owner/name form (or a valid GitHub URL)"), { statusCode: 400 });
  }
  const branch = clean(input.branch);
  if (input.branch !== undefined) {
    if (!branch || !BRANCH_RE.test(branch)) {
      throw Object.assign(new Error("Branch contains invalid characters"), { statusCode: 400 });
    }
  }
  const path = clean(input.path);
  if (input.path !== undefined) {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
      throw Object.assign(new Error("Backup path must be a safe repo-relative path (e.g. .codevia/backups)"), { statusCode: 400 });
    }
  }
  const schedule = clean(input.schedule);
  if (input.schedule !== undefined) {
    if (!schedule || !isValidCron(schedule)) {
      throw Object.assign(
        new Error('Schedule must be a five-field cron expression: "minute hour day-of-month month day-of-week" (e.g. "0 * * * *" for hourly)'),
        { statusCode: 400 },
      );
    }
  }
  const retain = input.retain === undefined ? undefined : Math.trunc(input.retain);
  if (retain !== undefined && (Number.isNaN(retain) || retain < 1 || retain > 500)) {
    throw Object.assign(new Error("retain must be between 1 and 500"), { statusCode: 400 });
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
    updatedAt: new Date().toISOString(),
    ...(updatedBy ? { updatedBy } : {}),
  };
  if (input.repo !== undefined && repo === undefined) delete next.repo;
  if (input.branch !== undefined && branch === undefined) delete next.branch;
  if (input.path !== undefined && path === undefined) delete next.path;
  if (input.schedule !== undefined && schedule === undefined) delete next.schedule;

  const parsed = BackupSettingsSchema.parse(next);
  kv.set(BACKUP_SETTINGS_KEY, parsed);
  return parsed;
}

/** Rewrite only the last-run bookkeeping fields (not form-editable config). */
export function updateBackupStatus(
  kv: KvStore,
  patch: Partial<Pick<BackupSettings, "lastRunAt" | "lastRunStatus" | "lastRunError" | "lastRunCommit" | "lastRunFiles" | "lastRunBytes" | "lastRunCounts">>,
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
export function getEffectiveBackupSettings(kv: KvStore): Required<Pick<BackupSettings, "enabled" | "branch" | "path" | "schedule" | "retain">> & BackupSettings {
  const s = getBackupSettings(kv);
  return {
    enabled: s.enabled ?? false,
    branch: s.branch ?? "main",
    path: s.path ?? DEFAULT_BACKUP_PATH,
    schedule: s.schedule ?? DEFAULT_BACKUP_SCHEDULE,
    retain: s.retain ?? 30,
    ...s,
  };
}
