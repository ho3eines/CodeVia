import { accessSync, constants, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/* ------------------------------------------------------------------ *
 * Storage pre-flight.
 *
 * The runtime store is SQLite at DATABASE_PATH. On Railway/Docker the volume
 * mounted at that path is created by the platform AFTER the image is built and
 * is root-owned, so an unprivileged container cannot create codevia.db there.
 * The failure surfaces from node:sqlite as `unable to open database file` —
 * a message that names no file, no errno and no fix, which is exactly why
 * deploys crash-loop with only "fatal startup error" in the log viewer.
 *
 * This module turns that into an actionable error before any DB work happens.
 * ------------------------------------------------------------------ */

export interface StoragePreflight {
  /** Absolute DATABASE_PATH. */
  dbPath: string;
  /** Directory SQLite must be able to write into (dbPath + -wal/-shm). */
  dir: string;
  /** True when the process can create files in `dir` (creating it if needed). */
  writable: boolean;
  uid: number;
  gid: number;
  /** Owner of the checked directory (undefined when nothing on the path exists). */
  dirOwner?: { uid: number; gid: number; mode: string };
  /** Human-readable diagnosis, empty when everything is fine. */
  hint?: string;
}

type FsErrno = NodeJS.ErrnoException;

/**
 * Inspect the storage path. The DB layer creates the directory recursively, so a
 * directory that does not exist yet is only a problem when the closest existing
 * ancestor cannot hold it — which is what this checks.
 */
export function checkStoragePath(databasePath: string): StoragePreflight {
  const dbPath = isAbsolute(databasePath) ? resolve(databasePath) : resolve(process.cwd(), databasePath);
  const dir = dirname(dbPath);
  const uid = process.getuid?.() ?? -1;
  const gid = process.getgid?.() ?? -1;

  let probe = dir;
  let owner: StoragePreflight["dirOwner"];
  for (let hops = 0; hops < 32; hops++) {
    const st = statOrNull(probe);
    if (st) {
      owner = { uid: st.uid, gid: st.gid, mode: (st.mode & 0o777).toString(8).padStart(3, "0") };
      break;
    }
    const parent = dirname(probe);
    if (parent === probe) break; // reached the filesystem root
    probe = parent;
  }

  try {
    accessSync(probe, constants.W_OK | constants.R_OK);
    return { dbPath, dir, writable: true, uid, gid, dirOwner: owner };
  } catch (err) {
    return fail(dbPath, dir, owner, describeCode((err as FsErrno).code ?? "unknown"), probe);
  }
}

function statOrNull(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function fail(
  dbPath: string,
  dir: string,
  owner: StoragePreflight["dirOwner"],
  reason: string,
  checked: string,
): StoragePreflight {
  const via = checked === dir ? "" : ` (checked the closest existing parent, ${checked})`;
  return {
    dbPath,
    dir,
    writable: false,
    uid: process.getuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
    dirOwner: owner,
    hint:
      `runtime store "${dbPath}" is unusable: ${reason}${via}. ` +
      `${checked} is owned by ${owner ? `uid ${owner.uid} (mode ${owner.mode})` : "unknown"} ` +
      `and this process runs as uid ${process.getuid?.() ?? -1}. ` +
      `Fix: mount the persistent volume at "${dir}" and keep DATABASE_PATH inside it ` +
      `(e.g. ${dir}/codevia.db); the image entrypoint (/usr/local/bin/docker-entrypoint.sh) ` +
      `chowns that root-owned mount to the app user before starting Node, so the start ` +
      `command must run through it — replacing it with a bare \`node dist/index.js\` skips ` +
      `that step. See docs/DEPLOYMENT.md.`,
  };
}

function describeCode(code: string): string {
  switch (code) {
    case "EACCES":
      return "permission denied (EACCES) — the volume was mounted but never chowned to the app user";
    case "EPERM":
      return "operation not permitted (EPERM)";
    case "EROFS":
      return "the filesystem is read-only (EROFS) — the path is not a writable mount";
    case "ENOENT":
      return "no part of the path exists and it cannot be created (ENOENT)";
    default:
      return `${code} — not readable/writable`;
  }
}

/** Error to throw from startup when the storage path is not usable. */
export class StoragePreflightError extends Error {
  readonly info: StoragePreflight;
  constructor(info: StoragePreflight) {
    super(info.hint ?? `unusable storage path: ${info.dbPath}`);
    this.name = "StoragePreflightError";
    this.info = info;
  }
}
