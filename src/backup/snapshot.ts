import { createHash } from "node:crypto";
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

/** Keep GitHub Contents API files comfortably below its 1 MiB small-file boundary. */
const BACKUP_PART_MAX_BYTES = 700 * 1024;
const TABLE_NAMES = ["records", "jobs", "kv"] as const;
type SnapshotTableName = (typeof TABLE_NAMES)[number];

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

interface SnapshotManifestPart {
  path: string;
  count?: number;
  sha256?: string;
}

interface SnapshotManifest {
  version?: unknown;
  type?: unknown;
  createdAt?: unknown;
  databasePath?: unknown;
  platform?: unknown;
  summary?: unknown;
  counts?: unknown;
  files?: Partial<Record<SnapshotTableName, Array<string | SnapshotManifestPart>>>;
}

function invalidBackup(message: string): never {
  throw Object.assign(new Error(`Invalid backup: ${message}`), { statusCode: 400 });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Reject values JSON.stringify would silently omit or coerce. */
function assertJsonValue(value: unknown, field: string, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 512) invalidBackup(`${field} exceeds the maximum JSON nesting depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidBackup(`${field} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") invalidBackup(`${field} is not JSON-compatible`);
  if (ancestors.has(value)) invalidBackup(`${field} contains a circular reference`);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) invalidBackup(`${field} is not a plain JSON array`);
    ancestors.add(value);
    try {
      for (let i = 0; i < value.length; i++) {
        const childField = `${field}[${i}]`;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          invalidBackup(`${childField} is missing or not a plain JSON value`);
        }
        assertJsonValue(descriptor.value, childField, ancestors, depth + 1);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          invalidBackup(`${field} has a non-JSON array property`);
        }
      }
    } finally {
      ancestors.delete(value);
    }
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidBackup(`${field} is not a plain JSON object`);
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalidBackup(`${field} has a symbol property`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        invalidBackup(`${field}[${JSON.stringify(key)}] is not a plain JSON property`);
      }
      assertJsonValue(descriptor.value, `${field}[${JSON.stringify(key)}]`, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

function text(value: unknown, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

function optionalText(value: unknown): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

function isoOrNow(value: unknown): string {
  const candidate = optionalText(value);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : new Date().toISOString();
}

function parseColumn(raw: string | null | undefined, field: string): unknown {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`Cannot create a complete backup: ${field} is not valid JSON`, { cause: err });
  }
}

function jsonText(value: unknown, field: string): string {
  assertJsonValue(value, field);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) invalidBackup(`${field} is missing or cannot be serialized`);
  return serialized;
}

function sha256(content: string): string {
  // Git checkouts on Windows may turn physical JSON line endings into CRLF;
  // that is semantically identical and must not invalidate a copied snapshot.
  return createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** Take a complete, transaction-consistent point-in-time snapshot from SQLite. */
export async function createSnapshot(db: Db): Promise<BackupSnapshot> {
  // A read transaction makes records/jobs/kv describe the same DB state even
  // when workers or API requests write while a large backup is being created.
  const { recordsRows, jobsRows, kvRows } = db.tx(() => ({
    recordsRows: db.all<SnapshotRecordRow>("SELECT * FROM records ORDER BY created_at ASC"),
    jobsRows: db.all<SnapshotJobRow>("SELECT * FROM jobs ORDER BY created_at ASC"),
    kvRows: db.all<SnapshotKvRow>("SELECT * FROM kv ORDER BY key ASC"),
  }));

  const records: SnapshotRecord[] = recordsRows.map((r) => ({
    id: r.id,
    type: r.type,
    projectId: r.project_id ?? undefined,
    parentId: r.parent_id ?? undefined,
    key: r.key ?? undefined,
    data: parseColumn(r.data, `record ${r.id}.data`),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const jobs: SnapshotJob[] = jobsRows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    payload: parseColumn(r.payload, `job ${r.id}.payload`),
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
    value: parseColumn(r.value, `kv ${r.key}`),
    updatedAt: r.updated_at,
  }));

  const payload = { records, jobs, kv };
  for (const record of records) assertJsonValue(record.data, `record ${record.id}.data`);
  for (const job of jobs) assertJsonValue(job.payload, `job ${job.id}.payload`);
  for (const item of kv) assertJsonValue(item.value, `kv ${item.key}.value`);
  const serializedPayload = JSON.stringify(payload);
  if (serializedPayload === undefined) invalidBackup("the database snapshot cannot be serialized as JSON");
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
      bytes: Buffer.byteLength(serializedPayload, "utf8"),
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

/**
 * Validate a normalized snapshot. Counts in the manifest are checked as well:
 * a syntactically valid but truncated JSON array must never silently restore as
 * a "successful" partial backup.
 */
export function assertBackupSnapshot(snapshot: unknown): asserts snapshot is BackupSnapshot {
  if (!isObject(snapshot)) invalidBackup("expected an object");
  const s = snapshot;
  if (s.type !== BACKUP_SNAPSHOT_TYPE) {
    invalidBackup(`wrong type "${s.type ?? "?"}"`);
  }
  if (!Number.isInteger(s.version) || Number(s.version) < 1 || Number(s.version) > BACKUP_SNAPSHOT_VERSION) {
    invalidBackup("unsupported version");
  }
  if (!Array.isArray(s.records) || !Array.isArray(s.jobs) || !Array.isArray(s.kv)) {
    invalidBackup("missing records/jobs/kv arrays");
  }

  const recordIds = new Set<string>();
  for (let i = 0; i < s.records.length; i++) {
    const record: unknown = s.records[i];
    if (!isObject(record)) invalidBackup(`records[${i}] must be an object`);
    if (typeof record.id !== "string" || !record.id.trim()) invalidBackup(`records[${i}].id is missing`);
    if (typeof record.type !== "string" || !record.type.trim()) invalidBackup(`records[${i}].type is missing`);
    if (!hasOwn(record, "data")) invalidBackup(`records[${i}].data is missing`);
    assertJsonValue(record.data, `records[${i}].data`);
    if (recordIds.has(record.id)) invalidBackup(`duplicate record id "${record.id}"`);
    recordIds.add(record.id);
  }

  const jobIds = new Set<string>();
  for (let i = 0; i < s.jobs.length; i++) {
    const job: unknown = s.jobs[i];
    if (!isObject(job)) invalidBackup(`jobs[${i}] must be an object`);
    if (typeof job.id !== "string" || !job.id.trim()) invalidBackup(`jobs[${i}].id is missing`);
    if (typeof job.type !== "string" || !job.type.trim()) invalidBackup(`jobs[${i}].type is missing`);
    if (typeof job.status !== "string" || !job.status.trim()) invalidBackup(`jobs[${i}].status is missing`);
    if (!hasOwn(job, "payload")) invalidBackup(`jobs[${i}].payload is missing`);
    assertJsonValue(job.payload, `jobs[${i}].payload`);
    if (jobIds.has(job.id)) invalidBackup(`duplicate job id "${job.id}"`);
    jobIds.add(job.id);
  }

  const kvKeys = new Set<string>();
  for (let i = 0; i < s.kv.length; i++) {
    const item: unknown = s.kv[i];
    if (!isObject(item)) invalidBackup(`kv[${i}] must be an object`);
    if (typeof item.key !== "string" || !item.key.trim()) invalidBackup(`kv[${i}].key is missing`);
    if (!hasOwn(item, "value")) invalidBackup(`kv[${i}].value is missing`);
    assertJsonValue(item.value, `kv[${i}].value`);
    if (kvKeys.has(item.key)) invalidBackup(`duplicate kv key "${item.key}"`);
    kvKeys.add(item.key);
  }

  if (isObject(s.summary)) {
    for (const [key, count] of [
      ["records", s.records.length],
      ["jobs", s.jobs.length],
      ["kv", s.kv.length],
    ] as const) {
      const expected = s.summary[key];
      if (expected !== undefined && Number(expected) !== count) {
        invalidBackup(`manifest expects ${String(expected)} ${key}, but the backup contains ${count}`);
      }
    }
  }
}

/**
 * Normalize the public snapshot format and common raw-SQLite exports. The
 * normal app export contains parsed JSON values; raw table dumps contain
 * snake_case columns and JSON-encoded TEXT values. Keeping that distinction
 * prevents string-valued KV entries from being double-encoded or corrupted.
 */
export function normalizeBackupSnapshot(input: unknown): BackupSnapshot {
  if (!isObject(input)) invalidBackup("expected an object");

  let source = input;
  for (const key of ["snapshotData", "snapshot", "backup"]) {
    const nested = source[key];
    if (isObject(nested) && (Array.isArray(nested.records) || isObject(nested.tables))) {
      source = nested;
      break;
    }
  }
  const tableSource = isObject(source.tables) ? source.tables : source;
  const rawRecords = tableSource.records;
  const rawJobs = tableSource.jobs;
  const rawKv = tableSource.kv;
  if (!Array.isArray(rawRecords) || !Array.isArray(rawJobs) || !Array.isArray(rawKv)) {
    invalidBackup("missing records/jobs/kv arrays; this may be a settings-only export, not a full system backup");
  }
  if (source.type !== undefined && source.type !== BACKUP_SNAPSHOT_TYPE) {
    invalidBackup(`wrong type "${String(source.type)}"`);
  }

  const rawSqlRows =
    source.format === "sqlite" ||
    source.format === "codevia-sqlite-backup" ||
    rawRecords.some((row) => isObject(row) && (hasOwn(row, "project_id") || hasOwn(row, "created_at"))) ||
    rawJobs.some((row) => isObject(row) && (hasOwn(row, "max_attempts") || hasOwn(row, "created_at"))) ||
    rawKv.some((row) => isObject(row) && hasOwn(row, "updated_at"));

  const createdAt = isoOrNow(source.createdAt ?? source.created_at);
  const records: SnapshotRecord[] = rawRecords.map((raw: unknown, i: number) => {
    if (!isObject(raw)) invalidBackup(`records[${i}] must be an object`);
    const dataValue = hasOwn(raw, "data") ? raw.data : raw.record;
    if (dataValue === undefined && !hasOwn(raw, "data")) invalidBackup(`records[${i}].data is missing`);
    return {
      id: text(raw.id),
      type: text(raw.type),
      projectId: optionalText(raw.projectId ?? raw.project_id),
      parentId: optionalText(raw.parentId ?? raw.parent_id),
      key: optionalText(raw.key),
      data: rawSqlRows && typeof dataValue === "string" ? parseColumn(dataValue, `records[${i}].data`) : dataValue,
      createdAt: isoOrNow(raw.createdAt ?? raw.created_at ?? createdAt),
      updatedAt: isoOrNow(raw.updatedAt ?? raw.updated_at ?? raw.createdAt ?? raw.created_at ?? createdAt),
    };
  });
  const jobs: SnapshotJob[] = rawJobs.map((raw: unknown, i: number) => {
    if (!isObject(raw)) invalidBackup(`jobs[${i}] must be an object`);
    const payloadValue = hasOwn(raw, "payload") ? raw.payload : raw.data;
    if (payloadValue === undefined && !hasOwn(raw, "payload")) invalidBackup(`jobs[${i}].payload is missing`);
    const attempts = Number(raw.attempts ?? 0);
    const maxAttempts = Number(raw.maxAttempts ?? raw.max_attempts ?? 3);
    return {
      id: text(raw.id),
      type: text(raw.type),
      status: text(raw.status),
      payload:
        rawSqlRows && typeof payloadValue === "string" ? parseColumn(payloadValue, `jobs[${i}].payload`) : payloadValue,
      attempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
      maxAttempts: Number.isInteger(maxAttempts) && maxAttempts >= 0 ? maxAttempts : 3,
      correlationId: optionalText(raw.correlationId ?? raw.correlation_id),
      scheduledAt: optionalText(raw.scheduledAt ?? raw.scheduled_at),
      startedAt: optionalText(raw.startedAt ?? raw.started_at),
      finishedAt: optionalText(raw.finishedAt ?? raw.finished_at),
      error: optionalText(raw.error),
      createdAt: isoOrNow(raw.createdAt ?? raw.created_at ?? createdAt),
      updatedAt: isoOrNow(raw.updatedAt ?? raw.updated_at ?? raw.createdAt ?? raw.created_at ?? createdAt),
    };
  });
  const kv: SnapshotKvItem[] = rawKv.map((raw: unknown, i: number) => {
    if (!isObject(raw)) invalidBackup(`kv[${i}] must be an object`);
    if (!hasOwn(raw, "value")) invalidBackup(`kv[${i}].value is missing`);
    return {
      key: text(raw.key),
      value: rawSqlRows && typeof raw.value === "string" ? parseColumn(raw.value, `kv[${i}].value`) : raw.value,
      updatedAt: isoOrNow(raw.updatedAt ?? raw.updated_at ?? createdAt),
    };
  });

  const summaryRaw = isObject(source.summary) ? source.summary : {};
  const payload = { records, jobs, kv };
  const version = source.version === undefined ? BACKUP_SNAPSHOT_VERSION : Number(source.version);
  const snapshot: BackupSnapshot = {
    version,
    type: BACKUP_SNAPSHOT_TYPE,
    createdAt,
    databasePath: text(source.databasePath ?? source.database_path),
    platform:
      source.platform === "railway" || source.platform === "docker" || source.platform === "host"
        ? source.platform
        : "host",
    summary: {
      records: summaryRaw.records === undefined ? records.length : Number(summaryRaw.records),
      jobs: summaryRaw.jobs === undefined ? jobs.length : Number(summaryRaw.jobs),
      kv: summaryRaw.kv === undefined ? kv.length : Number(summaryRaw.kv),
      bytes: Number.isFinite(Number(summaryRaw.bytes))
        ? Number(summaryRaw.bytes)
        : Buffer.byteLength(JSON.stringify(payload), "utf8"),
    },
    ...payload,
  };
  assertBackupSnapshot(snapshot);
  return snapshot;
}

/**
 * Restore the snapshot into the runtime DB. `replace` (default true) clears the
 * whole runtime store first, which is the correct behaviour for disaster
 * recovery / fresh deploy. Use `false` to merge (upsert all rows) instead.
 */
export function restoreSnapshot(db: Db, snapshot: BackupSnapshot, replace = true): RestoreSnapshotResult {
  assertBackupSnapshot(snapshot);

  db.tx(() => {
    if (replace) {
      db.run("DELETE FROM records");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM kv");
    }
    for (const r of snapshot.records) {
      db.run(
        `INSERT OR REPLACE INTO records (id, type, project_id, parent_id, key, data, created_at, updated_at)
         VALUES (:id, :type, :project_id, :parent_id, :key, :data, :created_at, :updated_at)`,
        {
          id: r.id,
          type: r.type,
          project_id: r.projectId ?? null,
          parent_id: r.parentId ?? null,
          key: r.key ?? null,
          data: jsonText(r.data, `record ${r.id}.data`),
          created_at: r.createdAt ?? new Date().toISOString(),
          updated_at: r.updatedAt ?? new Date().toISOString(),
        },
      );
    }
    for (const j of snapshot.jobs) {
      db.run(
        `INSERT OR REPLACE INTO jobs (id, type, status, payload, attempts, max_attempts, correlation_id, scheduled_at, started_at, finished_at, error, created_at, updated_at)
         VALUES (:id, :type, :status, :payload, :attempts, :max_attempts, :correlation_id, :scheduled_at, :started_at, :finished_at, :error, :created_at, :updated_at)`,
        {
          id: j.id,
          type: j.type,
          status: j.status,
          payload: jsonText(j.payload, `job ${j.id}.payload`),
          attempts: j.attempts,
          max_attempts: j.maxAttempts,
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
    for (const k of snapshot.kv) {
      db.run(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (:key, :value, :updated_at)`, {
        key: k.key,
        value: jsonText(k.value, `kv ${k.key}.value`),
        updated_at: k.updatedAt ?? new Date().toISOString(),
      });
    }
  });

  return {
    records: snapshot.records.length,
    jobs: snapshot.jobs.length,
    kv: snapshot.kv.length,
    replace,
  };
}

/** Build the file payload committed to GitHub (manifest + bounded JSON parts). */
export function snapshotFilePaths(base: string, snapshot: BackupSnapshot): Array<{ path: string; content: string }> {
  assertBackupSnapshot(snapshot);
  const dir = base.replace(/\/+$/, "");
  const tableItems: Record<SnapshotTableName, unknown[]> = {
    records: snapshot.records,
    jobs: snapshot.jobs,
    kv: snapshot.kv,
  };
  const output: Array<{ path: string; content: string }> = [];
  const fileManifest: Record<SnapshotTableName, SnapshotManifestPart[]> = {
    records: [],
    jobs: [],
    kv: [],
  };

  for (const table of TABLE_NAMES) {
    const chunks = splitIntoJsonParts(tableItems[table]);
    chunks.forEach((items, index) => {
      const suffix = chunks.length === 1 ? "" : `-${String(index + 1).padStart(4, "0")}`;
      const name = `${table}${suffix}.json`;
      const content = `${JSON.stringify(items)}\n`;
      output.push({ path: `${dir}/${name}`, content });
      fileManifest[table].push({ path: name, count: items.length, sha256: sha256(content) });
    });
  }

  const manifest = {
    version: snapshot.version,
    type: snapshot.type,
    createdAt: snapshot.createdAt,
    databasePath: snapshot.databasePath,
    platform: snapshot.platform,
    summary: snapshot.summary,
    counts: {
      records: snapshot.records.length,
      byType: groupCounts(snapshot.records),
      jobs: snapshot.jobs.length,
      kv: snapshot.kv.length,
    },
    // Per-part hashes/counts make a damaged or hand-copied partial backup fail
    // before any existing data is deleted.
    files: fileManifest,
  };
  output.unshift({ path: `${dir}/manifest.json`, content: `${JSON.stringify(manifest, null, 2)}\n` });
  output.push({
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
      `Copy every JSON file in this directory together when restoring from files.`,
    ].join("\n"),
  });
  return output;
}

function splitIntoJsonParts(items: unknown[]): unknown[][] {
  if (!items.length) return [[]];
  const parts: unknown[][] = [];
  let current: unknown[] = [];
  let currentBytes = 2; // JSON brackets
  for (const item of items) {
    const encoded = JSON.stringify(item);
    if (encoded === undefined) invalidBackup("a snapshot row cannot be serialized");
    const itemBytes = Buffer.byteLength(encoded, "utf8");
    const addition = itemBytes + (current.length ? 1 : 0); // comma separator
    if (current.length && currentBytes + addition > BACKUP_PART_MAX_BYTES) {
      parts.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(item);
    currentBytes += itemBytes + (current.length > 1 ? 1 : 0);
  }
  parts.push(current);
  return parts;
}

export function groupCounts(records: SnapshotRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) out[r.type] = (out[r.type] ?? 0) + 1;
  return out;
}

/**
 * Names of all required table-part JSON files in a manifest. Older snapshots
 * predate part lists and used one records.json/jobs.json/kv.json each.
 */
export function snapshotPartPathsFromManifest(manifestContent: string): string[] {
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(manifestContent) as SnapshotManifest;
  } catch {
    invalidBackup("manifest.json is not valid JSON");
  }
  return TABLE_NAMES.flatMap((table) => partDescriptors(manifest!, table).map((part) => part.path));
}

/** Rebuild and validate a complete snapshot from a GitHub directory or selected JSON files. */
export function snapshotFromFiles(files: { path: string; content: string }[]): BackupSnapshot {
  const manifestFile = findFile(files, "manifest.json");
  let manifest: SnapshotManifest = {};
  if (manifestFile) {
    try {
      manifest = JSON.parse(manifestFile.content) as SnapshotManifest;
    } catch {
      invalidBackup("manifest.json is not valid JSON");
    }
  }

  const records = readTableParts(files, manifest, "records");
  const jobs = readTableParts(files, manifest, "jobs");
  const kv = readTableParts(files, manifest, "kv");
  const summary = isObject(manifest.summary) ? manifest.summary : {};
  const snapshot: BackupSnapshot = {
    version: manifest.version === undefined ? BACKUP_SNAPSHOT_VERSION : Number(manifest.version),
    type: text(manifest.type, BACKUP_SNAPSHOT_TYPE),
    createdAt: isoOrNow(manifest.createdAt),
    databasePath: text(manifest.databasePath),
    platform:
      manifest.platform === "railway" || manifest.platform === "docker" || manifest.platform === "host"
        ? manifest.platform
        : "host",
    summary: {
      records: records.length,
      jobs: jobs.length,
      kv: kv.length,
      bytes: Number.isFinite(Number(summary.bytes)) ? Number(summary.bytes) : 0,
    },
    records: records as SnapshotRecord[],
    jobs: jobs as SnapshotJob[],
    kv: kv as SnapshotKvItem[],
  };
  assertManifestCount(manifest.summary, "records", records.length);
  assertManifestCount(manifest.summary, "jobs", jobs.length);
  assertManifestCount(manifest.summary, "kv", kv.length);
  return normalizeBackupSnapshot(snapshot);
}

function readTableParts(
  files: { path: string; content: string }[],
  manifest: SnapshotManifest,
  table: SnapshotTableName,
): unknown[] {
  const descriptors = partDescriptors(manifest, table);
  const all: unknown[] = [];
  for (const descriptor of descriptors) {
    const file = findFile(files, descriptor.path);
    if (!file) invalidBackup(`backup is incomplete: missing ${descriptor.path}`);
    if (descriptor.sha256 && sha256(file.content) !== descriptor.sha256) {
      invalidBackup(`${descriptor.path} failed its SHA-256 integrity check`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content) as unknown;
    } catch {
      invalidBackup(`${descriptor.path} is not valid JSON`);
    }
    if (!Array.isArray(parsed)) invalidBackup(`${descriptor.path} must contain a JSON array`);
    if (descriptor.count !== undefined && Number(descriptor.count) !== parsed.length) {
      invalidBackup(`${descriptor.path} declares ${descriptor.count} rows but contains ${parsed.length}`);
    }
    all.push(...parsed);
  }
  return all;
}

function partDescriptors(manifest: SnapshotManifest, table: SnapshotTableName): SnapshotManifestPart[] {
  const declared = manifest.files?.[table];
  if (declared === undefined) return [{ path: `${table}.json` }];
  if (!Array.isArray(declared) || declared.length === 0) invalidBackup(`manifest.files.${table} is empty or invalid`);
  return declared.map((part, i) => {
    const path = typeof part === "string" ? part : part?.path;
    if (typeof path !== "string" || !path.trim()) invalidBackup(`manifest.files.${table}[${i}].path is missing`);
    const normalized = path.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.split("/").some((segment) => segment === ".." || segment === ".")) {
      invalidBackup(`manifest.files.${table}[${i}].path is unsafe`);
    }
    if (typeof part === "string") return { path: normalized };
    return {
      path: normalized,
      count: part.count === undefined ? undefined : Number(part.count),
      sha256: typeof part.sha256 === "string" ? part.sha256 : undefined,
    };
  });
}

function assertManifestCount(raw: unknown, table: SnapshotTableName, actual: number): void {
  if (!isObject(raw)) return;
  const expected = raw[table];
  if (expected !== undefined && Number(expected) !== actual) {
    invalidBackup(`manifest expects ${String(expected)} ${table}, but the backup contains ${actual}`);
  }
}

function findFile(
  files: { path: string; content: string }[],
  requested: string,
): { path: string; content: string } | undefined {
  const normalized = requested.replace(/\\/g, "/").replace(/^\/+/, "");
  const exact = files.find((file) => file.path.replace(/\\/g, "/").replace(/^\/+/, "") === normalized);
  if (exact) return exact;
  const suffixMatches = files.filter((file) => {
    const path = file.path.replace(/\\/g, "/").replace(/^\/+/, "");
    return path.endsWith(`/${normalized}`) || path.split("/").pop() === normalized;
  });
  if (suffixMatches.length > 1)
    invalidBackup(`multiple selected files match ${requested}; select files from one snapshot only`);
  return suffixMatches[0];
}
