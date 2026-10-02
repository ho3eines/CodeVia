import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Db } from "../db/client.js";
import { getEnv } from "../config/env.js";
import type { BackupSnapshot } from "./snapshot.js";

/* ------------------------------------------------------------------ *
 * Local backup store.
 *
 * The GitHub repository is the primary backup target, but a backup that only
 * exists behind a network call is not a backup an operator can rely on at 3am:
 * the token may be revoked, the repo renamed, the network down. Every run
 * therefore also writes a complete copy next to the database — which on
 * Docker/Railway is the mounted volume, so it survives a redeploy — plus a
 * single self-contained `snapshot.json` that can be copied to another machine
 * by any means (scp, object storage, a USB stick) and restored there.
 * ------------------------------------------------------------------ */

export const LOCAL_LATEST_FILE = "latest.json";
export const LOCAL_SNAPSHOT_FILE = "snapshot.json";

/** A snapshot directory name is an ISO timestamp with `:`/`.` replaced. */
const SNAPSHOT_ID_RE = /^[A-Za-z0-9._-]+$/;

export interface LocalBackupEntry {
  id: string;
  path: string;
  createdAt: string;
  records: number;
  jobs: number;
  kv: number;
  /** True when the directory carries a secrets bundle (plaintext or encrypted). */
  secrets: boolean;
  secretsEncrypted: boolean;
  bytes: number;
  source: "local";
  latest?: boolean;
}

export interface LocalWriteResult {
  ok: boolean;
  dir?: string;
  files?: number;
  bytes?: number;
  snapshotFile?: string;
  error?: string;
}

function isSafeId(id: string): boolean {
  return SNAPSHOT_ID_RE.test(id) && id !== "." && id !== "..";
}

/** Where local copies live: BACKUP_LOCAL_DIR, else `<database dir>/backups`. */
export function resolveLocalBackupDir(db?: Db, configured?: string): string {
  const fromEnv = (getEnv().BACKUP_LOCAL_DIR ?? "").trim();
  const requested = (configured ?? fromEnv).trim();
  if (requested) return resolve(requested);
  const databasePath = db?.path ?? resolve(getEnv().DATABASE_PATH);
  return resolve(join(dirname(databasePath), "backups"));
}

/** Write every snapshot part + the single-file snapshot + the latest pointer. */
export async function writeLocalBackup(
  baseDir: string,
  snapshotId: string,
  files: Array<{ path: string; content: string }>,
  snapshot: BackupSnapshot,
): Promise<LocalWriteResult> {
  if (!isSafeId(snapshotId)) return { ok: false, error: `Invalid snapshot id "${snapshotId}"` };
  const dir = join(baseDir, snapshotId);
  try {
    await mkdir(dir, { recursive: true });
    let bytes = 0;
    for (const file of files) {
      // `files` paths are repo-relative (`<base>/<id>/name.json`); only the last
      // segment is meaningful locally, and using it keeps the copy flat.
      const name = file.path.split("/").pop() ?? file.path;
      if (!name || name.includes("..")) continue;
      // 0600: a snapshot can contain live API keys (secrets.json) and the whole
      // runtime database, so it must not be world-readable on a shared host.
      await writeFile(join(dir, name), file.content, { encoding: "utf8", mode: 0o600 });
      bytes += Buffer.byteLength(file.content, "utf8");
    }
    const snapshotContent = `${JSON.stringify(snapshot, null, 2)}\n`;
    await writeFile(join(dir, LOCAL_SNAPSHOT_FILE), snapshotContent, { encoding: "utf8", mode: 0o600 });
    bytes += Buffer.byteLength(snapshotContent, "utf8");

    const latest = {
      latest: snapshotId,
      latestAt: snapshot.createdAt,
      createdAt: new Date().toISOString(),
      path: dir,
      summary: snapshot.summary,
      counts: {
        records: snapshot.records.length,
        jobs: snapshot.jobs.length,
        kv: snapshot.kv.length,
      },
      secrets: !!snapshot.environment,
      environment: snapshot.environment
        ? {
            exportedAt: snapshot.environment.exportedAt,
            envKeys: Object.keys(snapshot.environment.env).length,
            secretKeys: snapshot.environment.secretKeys,
            dbSecrets: snapshot.environment.dbSecrets.length,
          }
        : undefined,
    };
    await writeFile(join(baseDir, LOCAL_LATEST_FILE), `${JSON.stringify(latest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return {
      ok: true,
      dir,
      files: files.length + 1,
      bytes,
      snapshotFile: join(dir, LOCAL_SNAPSHOT_FILE),
    };
  } catch (err) {
    return { ok: false, dir, error: err instanceof Error ? err.message : String(err) };
  }
}

/** List local snapshot directories, newest first. */
export async function listLocalBackups(baseDir: string, limit = 50): Promise<LocalBackupEntry[]> {
  let names: string[];
  try {
    names = await readdir(baseDir);
  } catch {
    return [];
  }
  const out: LocalBackupEntry[] = [];
  for (const name of names) {
    if (!isSafeId(name)) continue;
    const dir = join(baseDir, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      const manifest = await readJsonFile(join(dir, "manifest.json"));
      if (!manifest) continue;
      const summary = (manifest.summary ?? {}) as { records?: number; jobs?: number; kv?: number; bytes?: number };
      const files = await readdir(dir);
      const secrets = files.includes("secrets.json") || files.includes("environment.json");
      const secretsEncrypted = files.includes("secrets.enc.json") || files.includes("environment.enc.json");
      let bytes = 0;
      for (const file of files) {
        try {
          bytes += (await stat(join(dir, file))).size;
        } catch {
          /* a vanished file is not worth failing the listing */
        }
      }
      out.push({
        id: name,
        path: dir,
        createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : "",
        records: Number(summary.records ?? 0),
        jobs: Number(summary.jobs ?? 0),
        kv: Number(summary.kv ?? 0),
        secrets: secrets || secretsEncrypted,
        secretsEncrypted,
        bytes,
        source: "local",
      });
    } catch {
      /* skip unreadable directories */
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  const limited = out.slice(0, limit);
  if (limited.length) limited[0].latest = true;
  return limited;
}

/** Read the complete snapshot stored locally (single file, else assembled parts). */
export async function readLocalSnapshot(baseDir: string, snapshotId: string): Promise<unknown | undefined> {
  if (!isSafeId(snapshotId)) return undefined;
  const dir = join(baseDir, snapshotId);
  const single = await readJsonFile(join(dir, LOCAL_SNAPSHOT_FILE));
  if (single) return single;
  return undefined;
}

/** Every JSON file of a local snapshot directory, for `snapshotFromFiles`. */
export async function readLocalSnapshotFiles(
  baseDir: string,
  snapshotId: string,
): Promise<Array<{ path: string; content: string }>> {
  if (!isSafeId(snapshotId)) return [];
  const dir = join(baseDir, snapshotId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ path: string; content: string }> = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name === LOCAL_SNAPSHOT_FILE) continue;
    try {
      out.push({ path: name, content: await readFile(join(dir, name), "utf8") });
    } catch {
      /* ignore unreadable part */
    }
  }
  return out;
}

/** Delete snapshots beyond `retain` (newest kept). Returns removed ids. */
export async function pruneLocalBackups(baseDir: string, retain: number): Promise<string[]> {
  if (!Number.isFinite(retain) || retain < 1) return [];
  const entries = await listLocalBackups(baseDir, Number.MAX_SAFE_INTEGER);
  const stale = entries.slice(retain);
  const removed: string[] = [];
  for (const entry of stale) {
    try {
      await rm(entry.path, { recursive: true, force: true });
      removed.push(entry.id);
    } catch {
      /* a directory that refuses deletion is reported by the next listing */
    }
  }
  return removed;
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
