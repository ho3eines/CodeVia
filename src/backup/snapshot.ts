import type { Db } from "../db/client.js";
import { getEnv } from "../config/env.js";
import { getStorageInfo } from "../app/storage.js";

/* ------------------------------------------------------------------ *
 * Full runtime snapshot.
 *
 * The SQLite DB at DATABASE_PATH is the only real persisted state on Railway
 * (container storage is ephemeral). This captures the complete contents of
 * `records`, `jobs` and `kv` so the platform can be fully rebuilt after a
 * deploy / corruption / disaster.
 *
 * Secret material is stored in the same encrypted form the runtime keeps
 * (provider secretValueEnc, Telegram tokenEnc, per-user GitHub token records).
 * The snapshot never decrypts those values.
 * ------------------------------------------------------------------ */

export const BACKUP_SNAPSHOT_VERSION = 1;
export const BACKUP_SNAPSHOT_TYPE = "codevia-runtime-backup";

interface SnapshotRecordRow {
  id: string;
  type: string;
  project_id: string | null;
  parent_id: string | null;
  key: string | null;
  data: string;
  created_at: string;
  updated_at: string;
}

interface SnapshotJobRow {
  id: string;
  type: string;
  status: string;
  payload: string;
  attempts: number;
  max_attempts: number;
  correlation_id: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface SnapshotKvRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface SnapshotRecord {
  id: string;
  type: string;
  projectId?: string;
  parentId?: string;
  key?: string;
  data: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotJob {
  id: string;
  type: string;
  status: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  correlationId?: string;
  scheduledAt?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotKvItem {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface BackupSnapshot {
  version: number;
  type: string;
  createdAt: string;
  databasePath: string;
  platform: "railway" | "docker" | "host";
  summary: {
    records: number;
    jobs: number;
    kv: number;
    bytes: number;
  };
  records: SnapshotRecord[];
  jobs: SnapshotJob[];
  kv: SnapshotKvItem[];
}

function safeParse<T = unknown>(raw: string | null | undefined): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Take a complete point-in-time snapshot from the open SQLite DB. */
export async function createSnapshot(db: Db): Promise<BackupSnapshot> {
  const recordsRows = db.all<SnapshotRecordRow>("SELECT * FROM records ORDER BY created_at ASC");
  const jobsRows = db.all<SnapshotJobRow>("SELECT * FROM jobs ORDER BY created_at ASC");
  const kvRows = db.all<SnapshotKvRow>("SELECT * FROM kv ORDER BY key ASC");

  const records: SnapshotRecord[] = recordsRows.map((r) => ({
    id: r.id,
    type: r.type,
    projectId: r.project_id ?? undefined,
    parentId: r.parent_id ?? undefined,
    key: r.key ?? undefined,
    data: safeParse(r.data),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const jobs: SnapshotJob[] = jobsRows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    payload: safeParse(r.payload),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    correlationId: r.correlation_id ?? undefined,
    scheduledAt: r.scheduled_at ?? undefined,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const kv: SnapshotKvItem[] = kvRows.map((r) => ({
    key: r.key,
    value: safeParse(r.value),
    updatedAt: r.updated_at,
  }));

  const inventory: Record<string, number> = {};
  for (const r of records) inventory[r.type] = (inventory[r.type] ?? 0) + 1;

  const payload = { records, jobs, kv };
  return {
    version: BACKUP_SNAPSHOT_VERSION,
    type: BACKUP_SNAPSHOT_TYPE,
    createdAt: new Date().toISOString(),
    databasePath: getEnv().DATABASE_PATH,
    platform: (await getStorageInfo()).platform,
    summary: {
      records: records.length,
      jobs: jobs.length,
      kv: kv.length,
      bytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    },
    ...payload,
  };
}

export interface RestoreSnapshotResult {
  records: number;
  jobs: number;
  kv: number;
  replace: boolean;
}

/** Validate a snapshot object. */
export function assertBackupSnapshot(snapshot: unknown): asserts snapshot is BackupSnapshot {
  if (!snapshot || typeof snapshot !== "object") {
    throw Object.assign(new Error("Invalid backup: expected an object"), { statusCode: 400 });
  }
  const s = snapshot as BackupSnapshot;
  if (s.type !== BACKUP_SNAPSHOT_TYPE) {
    throw Object.assign(new Error(`Invalid backup: wrong type "${s.type ?? "?"}"`), { statusCode: 400 });
  }
  if (typeof s.version !== "number" || s.version < 1) {
    throw Object.assign(new Error("Invalid backup: unsupported version"), { statusCode: 400 });
  }
  if (!Array.isArray(s.records) || !Array.isArray(s.jobs) || !Array.isArray(s.kv)) {
    throw Object.assign(new Error("Invalid backup: missing records/jobs/kv arrays"), { statusCode: 400 });
  }
}

/**
 * Restore the snapshot into the runtime DB. `replace` (default true) clears the
 * whole runtime store first, which is the correct behaviour for disaster
 * recovery / fresh deploy. Use `false` to merge (upsert all rows) instead.
 */
export function restoreSnapshot(db: Db, snapshot: BackupSnapshot, replace = true): RestoreSnapshotResult {
  assertBackupSnapshot(snapshot);
  const records = snapshot.records ?? [];
  const jobs = snapshot.jobs ?? [];
  const kv = snapshot.kv ?? [];

  db.tx(() => {
    if (replace) {
      db.run("DELETE FROM records");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM kv");
    }
    for (const r of records) {
      db.run(
        `INSERT OR REPLACE INTO records (id, type, project_id, parent_id, key, data, created_at, updated_at)
         VALUES (:id, :type, :project_id, :parent_id, :key, :data, :created_at, :updated_at)`,
        {
          id: r.id,
          type: r.type,
          project_id: r.projectId ?? null,
          parent_id: r.parentId ?? null,
          key: r.key ?? null,
          data: typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? {}),
          created_at: r.createdAt ?? new Date().toISOString(),
          updated_at: r.updatedAt ?? new Date().toISOString(),
        },
      );
    }
    for (const j of jobs) {
      db.run(
        `INSERT OR REPLACE INTO jobs (id, type, status, payload, attempts, max_attempts, correlation_id, scheduled_at, started_at, finished_at, error, created_at, updated_at)
         VALUES (:id, :type, :status, :payload, :attempts, :max_attempts, :correlation_id, :scheduled_at, :started_at, :finished_at, :error, :created_at, :updated_at)`,
        {
          id: j.id,
          type: j.type,
          status: j.status,
          payload: typeof j.payload === "string" ? j.payload : JSON.stringify(j.payload ?? {}),
          attempts: Number(j.attempts) || 0,
          max_attempts: Number(j.maxAttempts) || 3,
          correlation_id: j.correlationId ?? null,
          scheduled_at: j.scheduledAt ?? null,
          started_at: j.startedAt ?? null,
          finished_at: j.finishedAt ?? null,
          error: j.error ?? null,
          created_at: j.createdAt ?? new Date().toISOString(),
          updated_at: j.updatedAt ?? new Date().toISOString(),
        },
      );
    }
    for (const k of kv) {
      db.run(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (:key, :value, :updated_at)`, {
        key: k.key,
        value: typeof k.value === "string" ? k.value : JSON.stringify(k.value ?? null),
        updated_at: k.updatedAt ?? new Date().toISOString(),
      });
    }
  });

  return { records: records.length, jobs: jobs.length, kv: kv.length, replace };
}

/** Predicate helpers for the files written to GitHub. */
export function snapshotFilePaths(base: string, snapshot: BackupSnapshot): Array<{ path: string; content: string }> {
  const dir = base.replace(/\/+$/, "");
  const manifest = {
    version: snapshot.version,
    type: snapshot.type,
    createdAt: snapshot.createdAt,
    databasePath: snapshot.databasePath,
    platform: snapshot.platform,
    summary: snapshot.summary,
    counts: {
      byType: groupCounts(snapshot.records),
      jobs: snapshot.jobs.length,
      kv: snapshot.kv.length,
    },
  };
  return [
    { path: `${dir}/manifest.json`, content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: `${dir}/records.json`, content: `${JSON.stringify(snapshot.records, null, 2)}\n` },
    { path: `${dir}/jobs.json`, content: `${JSON.stringify(snapshot.jobs, null, 2)}\n` },
    { path: `${dir}/kv.json`, content: `${JSON.stringify(snapshot.kv, null, 2)}\n` },
    {
      path: `${dir}/README.md`,
      content: [
        `# CodeVia runtime backup`,
        ``,
        `- **Created at:** ${snapshot.createdAt}`,
        `- **Platform:** ${snapshot.platform}`,
        `- **Database path:** ${snapshot.databasePath}`,
        `- **Records:** ${snapshot.records.length}`,
        `- **Jobs:** ${snapshot.jobs.length}`,
        `- **KV entries:** ${snapshot.kv.length}`,
        ``,
        `This snapshot is generated by the admin-configured system backup.`,
        `It contains every row of the runtime database in JSON form.`,
        `Encrypted secret material stays encrypted (never plaintext).`,
      ].join("\n"),
    },
  ];
}

export function groupCounts(records: SnapshotRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) out[r.type] = (out[r.type] ?? 0) + 1;
  return out;
}

/** Rebuild a snapshot object from files fetched from GitHub. */
export function snapshotFromFiles(files: { path: string; content: string }[]): BackupSnapshot {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const manifest = readJson(byPath, "manifest.json");
  const records = readJson(byPath, "records.json");
  const jobs = readJson(byPath, "jobs.json");
  const kv = readJson(byPath, "kv.json");
  if (!manifest || !records || !jobs || !kv) {
    throw new Error("Backup is incomplete: missing manifest.json / records.json / jobs.json / kv.json");
  }
  const manifestObj = manifest as Record<string, unknown>;
  const platform = manifestObj.platform === "railway" || manifestObj.platform === "docker" || manifestObj.platform === "host" ? manifestObj.platform : "host";
  const snapshot: BackupSnapshot = {
    version: Number(manifestObj.version) || 1,
    type: String(manifestObj.type ?? ""),
    createdAt: String(manifestObj.createdAt ?? ""),
    databasePath: String(manifestObj.databasePath ?? ""),
    platform,
    summary: {
      records: Array.isArray(records) ? records.length : 0,
      jobs: Array.isArray(jobs) ? jobs.length : 0,
      kv: Array.isArray(kv) ? kv.length : 0,
      bytes: 0,
    },
    records: Array.isArray(records) ? records : [],
    jobs: Array.isArray(jobs) ? jobs : [],
    kv: Array.isArray(kv) ? kv : [],
  };
  assertBackupSnapshot(snapshot);
  return snapshot;
}

function readJson(files: Map<string, { path: string; content: string }>, fileName: string): unknown {
  const exact = files.get(fileName);
  if (exact) {
    try {
      return JSON.parse(exact.content);
    } catch {
      return undefined;
    }
  }
  // Fall back to matching the basename regardless of directory.
  for (const f of files.values()) {
    if (f.path.split("/").pop() === fileName) {
      try {
        return JSON.parse(f.content);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
