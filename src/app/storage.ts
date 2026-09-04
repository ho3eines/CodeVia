import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getEnv } from "../config/env.js";

/* ------------------------------------------------------------------ *
 * Runtime storage diagnostics.
 *
 * The runtime store (SQLite at DATABASE_PATH) holds the admin-managed GitHub
 * login settings, the user table and cached platform data. On container
 * hosts (Docker/Railway) the container filesystem is EPHEMERAL: every
 * deploy/restart starts from a fresh image, so anything written to
 * container-local paths is lost. Detectable persistent mounts (Railway
 * volumes, docker bind mounts, named volumes) survive deploys.
 *
 * This module reports whether DATABASE_PATH sits on a persistent mount so
 * the Admin UI can warn operators BEFORE they hit the classic symptom:
 * "I have to re-enter the GitHub settings after every deploy".
 * ------------------------------------------------------------------ */

export interface StorageInfo {
  /** Absolute path of the SQLite database file. */
  path: string;
  /** Directory containing the database file (what must be a persistent mount). */
  dir: string;
  /** Where we appear to run. */
  platform: "railway" | "docker" | "host";
  /**
   * True when the DB directory is on a dedicated mount (volume/bind mount) or
   * a non-container root filesystem. False when it is on the container's
   * ephemeral root filesystem. Undefined when it cannot be determined
   * (non-Linux host, /proc/mounts unreadable).
   */
  onPersistentVolume?: boolean;
  /** Actionable warning when production data is at risk of being wiped. */
  warning?: string;
}

interface MountEntry {
  device: string;
  mountPoint: string;
  fsType: string;
}

/** Read the kernel mount table (Linux only). Undefined elsewhere. */
async function readMounts(): Promise<MountEntry[] | undefined> {
  try {
    const text = await readFile("/proc/mounts", "utf8");
    const out: MountEntry[] = [];
    for (const line of text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      let mountPoint = parts[1];
      try {
        mountPoint = decodeURIComponent(mountPoint);
      } catch {
        /* keep raw */
      }
      out.push({ device: parts[0], mountPoint, fsType: parts[2] ?? "" });
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Deepest mount point covering `target` (equal or a path prefix). */
function deepestMountFor(mounts: MountEntry[], target: string): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const m of mounts) {
    const covers =
      target === m.mountPoint ||
      target.startsWith(m.mountPoint.endsWith("/") ? m.mountPoint : m.mountPoint + "/");
    if (covers && (!best || m.mountPoint.length > best.mountPoint.length)) best = m;
  }
  return best;
}

async function isDockerContainer(): Promise<boolean> {
  try {
    await readFile("/.dockerenv", "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const env = getEnv();
  const dbPath = resolve(env.DATABASE_PATH);
  const dir = dirname(dbPath);

  const onRailway = !!(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT);
  const platform: StorageInfo["platform"] = onRailway ? "railway" : (await isDockerContainer()) ? "docker" : "host";

  let onPersistentVolume: boolean | undefined;
  if (process.platform === "linux") {
    const mounts = await readMounts();
    const mount = mounts ? deepestMountFor(mounts, dir) : undefined;
    if (mount) {
      if (mount.mountPoint !== "/") {
        // A dedicated mount (volume / bind) covers the DB directory.
        onPersistentVolume = true;
      } else {
        // Container root filesystem (overlay in Docker) is ephemeral; a
        // normal host root filesystem is persistent.
        const inContainer = mount.device === "overlay" || (await isDockerContainer());
        onPersistentVolume = !inContainer;
      }
    }
  }

  let warning: string | undefined;
  if (onPersistentVolume === false && env.NODE_ENV === "production") {
    warning =
      `The runtime database (${dbPath}) is on container-local storage and is WIPED on every ` +
      `deploy/restart — GitHub login settings, users and cached data will be lost each time. ` +
      `Attach a persistent volume to ${dir} (Railway: Service → Settings → Storage → Add Volume, ` +
      `mount path ${dir}) or persist the login config via environment variables ` +
      `(GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_OAUTH_CALLBACK_URL / AUTH_SECRET / REQUIRE_AUTH).`;
  }

  return { path: dbPath, dir, platform, onPersistentVolume, warning };
}
