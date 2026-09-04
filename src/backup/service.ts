import type { Db } from "../db/client.js";
import type { KvStore } from "../db/kv.js";
import type { IGitHubService, GithubRepoRef, GithubFile } from "../github/types.js";
import { parseRepoFullName } from "../github/types.js";
import type { NotificationRepository, AuditRepository } from "../observability/repos.js";
import type { ProviderRegistry } from "../ai/provider-registry.js";
import type { Logger } from "../logger.js";
import {
  getEffectiveBackupSettings,
  getBackupSettings,
  updateBackupStatus,
  type BackupSettings,
} from "./settings.js";
import {
  createSnapshot,
  restoreSnapshot,
  snapshotFromFiles,
  snapshotFilePaths,
  assertBackupSnapshot,
  type BackupSnapshot,
} from "./snapshot.js";

const MAX_RUN_MS = 120_000;

export interface BackupServiceDeps {
  db: Db;
  kv: KvStore;
  github: IGitHubService;
  auditRepo: AuditRepository;
  notificationRepo: NotificationRepository;
  providerRegistry: ProviderRegistry;
  logger: Logger;
}

export interface BackupRunResult {
  ok: boolean;
  configured: boolean;
  githubKind: "real" | "mock";
  repo?: string;
  branch?: string;
  path?: string;
  commit?: string;
  message?: string;
  snapshotPath?: string;
  files?: number;
  bytes?: number;
  counts?: Record<string, number | Record<string, number>>;
  warning?: string;
  error?: string;
}

export interface BackupListEntry {
  id: string;
  path: string;
  createdAt: string;
  records: number;
  jobs: number;
  kv: number;
  latest?: boolean;
}

export interface BackupRestoreResult {
  ok: boolean;
  from?: "github" | "snapshot";
  repo?: string;
  branch?: string;
  snapshot?: string;
  records: number;
  jobs: number;
  kv: number;
  replace: boolean;
  error?: string;
}

function normalizeBasePath(path?: string): string {
  const p = (path ?? ".codevia/backups").replace(/^\/+/, "").replace(/\/+$/, "");
  return p.length ? p : ".codevia/backups";
}

function safeDirName(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function repoRef(settings: BackupSettings): GithubRepoRef | undefined {
  return parseRepoFullName(settings.repo);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Spread a partial settings object without overwriting effective values with undefined. */
function mergeSettings<T extends Partial<BackupSettings>>(settings: BackupSettings, patch: T): BackupSettings {
  const out: BackupSettings = { ...settings };
  for (const key of Object.keys(patch ?? {}) as Array<keyof BackupSettings>) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Admin-only system backup service. It snapshots the full runtime DB and pushes
 * a JSON state dump into the configured GitHub repository at the configured
 * branch/interval. The same snapshots are also available for local export and
 * restore, so a fresh Railway deploy can recover all projects, models,
 * providers, agents, workflows, users, Telegram bots, memory and settings.
 */
export class BackupService {
  private running = false;

  constructor(private readonly deps: BackupServiceDeps) {}

  /** Create an in-memory snapshot (also used by /admin/backup/export). */
  async exportSnapshot(settings = getBackupSettings(this.deps.kv)): Promise<BackupSnapshot> {
    return createSnapshot(this.deps.db);
  }

  /** Push a full snapshot to the configured GitHub repository. */
  async runNow(input?: Partial<Pick<BackupSettings, "repo" | "branch" | "path">>): Promise<BackupRunResult> {
    if (this.running) {
      return { ok: false, configured: true, githubKind: this.deps.github.kind, error: "A backup is already running" };
    }
    const settings: BackupSettings = mergeSettings(getEffectiveBackupSettings(this.deps.kv), input ?? {});
    const ref = repoRef(settings);
    if (!settings.repo || !ref) {
      return {
        ok: false,
        configured: false,
        githubKind: this.deps.github.kind,
        warning: "Backup repository is not configured. Set owner/name in Admin → System Backup.",
      };
    }
    const branch = settings.branch ?? "main";
    const base = normalizeBasePath(settings.path);
    const github = this.deps.github;

    this.running = true;
    const started = new Date();
    updateBackupStatus(this.deps.kv, { lastRunStatus: "running", lastRunAt: started.toISOString(), lastRunError: undefined });
    try {
      const snapshot = await createSnapshot(this.deps.db);
      const dir = safeDirName(started);
      const snapshotPath = `${base}/${dir}`;
      const files = snapshotFilePaths(snapshotPath, snapshot);
      const filesPayload: GithubFile[] = files.map((f) => ({ path: f.path, content: f.content }));
      const latestPointer = {
        latest: snapshotPath,
        latestAt: snapshot.createdAt,
        commitMessage: `backup: system state (${snapshot.records.length} records, ${snapshot.jobs.length} jobs)`,
        createdAt: new Date().toISOString(),
        summary: snapshot.summary,
        counts: { records: snapshot.records.length, jobs: snapshot.jobs.length, kv: snapshot.kv.length },
      };
      filesPayload.push({
        path: `${base}/latest.json`,
        content: `${JSON.stringify(latestPointer, null, 2)}\n`,
      });

      const commit = await github.commit(ref, branch, `backup: system state ${started.toISOString()}`, filesPayload);
      const bytes = Buffer.byteLength(filesPayload.map((f) => f.content).join("\n"), "utf8");
      const result: BackupRunResult = {
        ok: true,
        configured: true,
        githubKind: github.kind,
        repo: settings.repo,
        branch,
        path: base,
        commit: commit.sha,
        message: commit.message,
        snapshotPath,
        files: filesPayload.length,
        bytes,
        counts: {
          records: snapshot.records.length,
          jobs: snapshot.jobs.length,
          kv: snapshot.kv.length,
          byType: Object.entries(groupCounts(snapshot.records)).reduce<Record<string, number>>((acc, [k, v]) => {
            acc[k] = v;
            return acc;
          }, {}),
        },
        warning:
          github.kind === "mock"
            ? "GitHub is in mock mode — the backup was written to the in-memory mock repository only. Configure GITHUB_TOKEN + GITHUB_ENABLED=true for a real repository."
            : undefined,
      };
      updateBackupStatus(this.deps.kv, {
        lastRunStatus: "success",
        lastRunError: undefined,
        lastRunCommit: commit.sha,
        lastRunFiles: filesPayload.length,
        lastRunBytes: bytes,
        lastRunCounts: {
          records: snapshot.records.length,
          jobs: snapshot.jobs.length,
          kv: snapshot.kv.length,
          files: filesPayload.length,
        },
      });
      await this.deps.auditRepo.record({
        userId: undefined,
        action: "admin.backup.run",
        result: "success",
        source: "system",
        correlationId: `backup-${started.getTime()}`,
        metadata: { repo: settings.repo, branch, path: snapshotPath, commit: commit.sha, files: filesPayload.length },
      });
      return result;
    } catch (err) {
      const message = errorMessage(err);
      updateBackupStatus(this.deps.kv, { lastRunStatus: "failed", lastRunError: message });
      await this.deps.auditRepo.record({
        userId: undefined,
        action: "admin.backup.run",
        result: "failure",
        source: "system",
        correlationId: `backup-${started.getTime()}`,
        metadata: { repo: settings.repo, branch, error: message },
      });
      this.deps.logger.warn("system backup failed", { error: message, repo: settings.repo });
      return { ok: false, configured: true, githubKind: github.kind, repo: settings.repo, branch, path: base, error: message };
    } finally {
      this.running = false;
    }
  }

  /** List snapshot directories in the configured backup repository. */
  async listBackups(input?: Partial<Pick<BackupSettings, "repo" | "branch" | "path">>, limit = 50): Promise<BackupListEntry[]> {
    const settings: BackupSettings = mergeSettings(getEffectiveBackupSettings(this.deps.kv), input ?? {});
    const ref = repoRef(settings);
    if (!settings.repo || !ref) return [];
    const base = normalizeBasePath(settings.path);
    const branch = settings.branch ?? "main";
    const entries = await this.deps.github.listFiles(ref, branch, base);
    const manifests = entries
      .filter((e) => e.type === "blob" && e.path.split("/").pop() === "manifest.json")
      .map((e) => e.path)
      .sort();
    const out: BackupListEntry[] = [];
    for (const manifestPath of manifests.slice(-limit)) {
      const dir = manifestPath.replace(/\/manifest\.json$/, "");
      const id = dir.split("/").pop() ?? dir;
      const f = await this.deps.github.getFile(ref, manifestPath, branch);
      if (!f) continue;
      try {
        const manifest = JSON.parse(f.content) as { createdAt?: string; summary?: { records?: number; jobs?: number; kv?: number } };
        out.push({
          id,
          path: dir,
          createdAt: manifest.createdAt ?? "",
          records: Number(manifest.summary?.records ?? 0),
          jobs: Number(manifest.summary?.jobs ?? 0),
          kv: Number(manifest.summary?.kv ?? 0),
        });
      } catch {
        // Corrupt manifest entries are skipped.
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (out.length) out[0].latest = true;
    return out;
  }

  /** Restore from a snapshot directory already committed to the configured repo. */
  async restoreFromGitHub(
    input?: Partial<Pick<BackupSettings, "repo" | "branch" | "path"> & { snapshot?: string; replace?: boolean }>,
  ): Promise<BackupRestoreResult> {
    const settings: BackupSettings = mergeSettings(getEffectiveBackupSettings(this.deps.kv), input ?? {});
    const ref = repoRef(settings);
    if (!settings.repo || !ref) {
      return { ok: false, from: "github", records: 0, jobs: 0, kv: 0, replace: true, error: "Backup repository is not configured." };
    }
    const base = normalizeBasePath(settings.path);
    const branch = settings.branch ?? "main";
    const requested = input?.snapshot;
    const list = await this.listBackups(undefined, 1);
    const latest = list[0];
    const target = requested && requested !== "latest" ? requested : latest?.id;
    if (!target) {
      return { ok: false, from: "github", repo: settings.repo, branch, records: 0, jobs: 0, kv: 0, replace: true, error: "No backup found in the configured repository." };
    }
    const dir = `${base}/${target}`;
    const files = [];
    for (const name of ["manifest.json", "records.json", "jobs.json", "kv.json"]) {
      const f = await this.deps.github.getFile(ref, `${dir}/${name}`, branch);
      if (!f) {
        return { ok: false, from: "github", repo: settings.repo, branch, snapshot: target, records: 0, jobs: 0, kv: 0, replace: true, error: `Backup is incomplete: missing ${name}` };
      }
      files.push({ path: f.path, content: f.content });
    }
    return this.restoreSnapshotObject(snapshotFromFiles(files), {
      repo: settings.repo,
      branch,
      snapshot: target,
      replace: input?.replace ?? true,
      source: "github",
    });
  }

  /** Restore from an in-memory snapshot object (local import / test). */
  restoreSnapshotObject(
    snapshot: unknown,
    meta?: { repo?: string; branch?: string; snapshot?: string; replace?: boolean; source?: "github" | "snapshot" },
  ): BackupRestoreResult {
    try {
      assertBackupSnapshot(snapshot);
      const replace = meta?.replace ?? true;
      const result = restoreSnapshot(this.deps.db, snapshot, replace);
      // Drop cached provider adapters so restored provider config is re-read.
      this.deps.providerRegistry.all().forEach((p) => this.deps.providerRegistry.invalidate(p.id));
      updateBackupStatus(this.deps.kv, {
        lastRunStatus: "success",
        lastRunError: undefined,
        lastRunAt: new Date().toISOString(),
        lastRunCounts: { records: result.records, jobs: result.jobs, kv: result.kv },
      });
      return {
        ok: true,
        from: meta?.source ?? "snapshot",
        repo: meta?.repo,
        branch: meta?.branch,
        snapshot: meta?.snapshot,
        records: result.records,
        jobs: result.jobs,
        kv: result.kv,
        replace,
      };
    } catch (err) {
      return {
        ok: false,
        from: meta?.source ?? "snapshot",
        records: 0,
        jobs: 0,
        kv: 0,
        replace: true,
        error: errorMessage(err),
      };
    }
  }
}

function groupCounts(records: BackupSnapshot["records"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) out[r.type] = (out[r.type] ?? 0) + 1;
  return out;
}

/** Used by the scheduler to avoid overlapping long-running backups. */
export function backupRunTimeoutMs(): number {
  return MAX_RUN_MS;
}
