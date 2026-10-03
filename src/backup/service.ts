import type { Db } from "../db/client.js";
import type { KvStore } from "../db/kv.js";
import type { IGitHubService, GithubRepoRef, GithubFile } from "../github/types.js";
import { parseRepoFullName } from "../github/types.js";
import type { NotificationRepository, AuditRepository } from "../observability/repos.js";
import type { ProviderRegistry } from "../ai/provider-registry.js";
import type { Logger } from "../logger.js";
import { getEnv } from "../config/env.js";
import { getEffectiveBackupSettings, getBackupSettings, updateBackupStatus, type BackupSettings } from "./settings.js";
import {
  bundleForStorage,
  createSnapshot,
  resolveSnapshotBundle,
  restoreSnapshot,
  snapshotFromFiles,
  snapshotFilePaths,
  snapshotPartPathsFromManifest,
  normalizeBackupSnapshot,
  type BackupSnapshot,
} from "./snapshot.js";
import { applyEnvironmentBundle, describeEnvironmentBundle, type ApplyResult, type BundleSummary } from "./secrets.js";
import {
  listLocalBackups,
  pruneLocalBackups,
  readLocalSnapshotFiles,
  resolveLocalBackupDir,
  writeLocalBackup,
  type LocalWriteResult,
} from "./local.js";
import { getUserGitHubToken } from "../auth/github-tokens.js";
import { RealGitHubService } from "../github/real-service.js";

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
  /** What the snapshot can bring back on another server (never plaintext). */
  secrets?: BundleSummary;
  /** Result of the on-disk copy next to the database. */
  local?: LocalWriteResult;
  /** Local snapshot directories removed by the retention policy. */
  pruned?: string[];
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
  /** Where this snapshot lives — a GitHub restore and a local one differ. */
  source: "github" | "local";
  /** True when the snapshot carries the environment/credential bundle. */
  secrets?: boolean;
  secretsEncrypted?: boolean;
  bytes?: number;
  latest?: boolean;
}

/** Non-secret report of what a restore brought back from the bundle. */
export interface EnvironmentRestoreSummary {
  /** Variable names restored from the backup (names only — never values). */
  envApplied: string[];
  /** Names this server already had, so the backup value was not applied. */
  envKept: string[];
  /** Deployment-local names recorded in `.env` but never injected here. */
  hostBound: string[];
  authSecretApplied: boolean;
  providers: number;
  telegramAccounts: number;
  githubTokens: number;
  secretsSkipped: number;
  envFile?: { ok: boolean; path: string; error?: string };
  warnings: string[];
}

export interface BackupRestoreResult {
  ok: boolean;
  from?: "github" | "local" | "snapshot";
  repo?: string;
  branch?: string;
  snapshot?: string;
  records: number;
  jobs: number;
  kv: number;
  replace: boolean;
  /** Present when the backup carried the environment/credential bundle. */
  environment?: EnvironmentRestoreSummary;
  warning?: string;
  error?: string;
}

function summarizeEnvironment(result: ApplyResult): EnvironmentRestoreSummary {
  return {
    envApplied: result.envApplied,
    envKept: result.envKept,
    hostBound: result.hostBound,
    authSecretApplied: result.authSecretApplied,
    providers: result.secretsReEncrypted.providers,
    telegramAccounts: result.secretsReEncrypted.telegramAccounts,
    githubTokens: result.secretsReEncrypted.githubTokens,
    secretsSkipped: result.secretsSkipped,
    envFile: result.envFile,
    warnings: result.warnings,
  };
}

function isObjectLike(value: unknown): boolean {
  return !!value && typeof value === "object";
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

  /**
   * Which credential writes/reads the backup repository.
   *
   * Backups are unattended, so there is no request to borrow a token from — but
   * the platform no longer needs a server-wide GITHUB_TOKEN for them either:
   * the account that configured the backup repository stored a GitHub OAuth
   * token at login, and that token is used here. The server PAT stays as the
   * fallback for installs that never logged in.
   */
  private githubFor(settings: BackupSettings): IGitHubService {
    const userId = settings.githubUserId;
    if (userId && getUserGitHubToken(this.deps.kv, userId)) {
      return new RealGitHubService({
        token: () => getUserGitHubToken(this.deps.kv, userId)?.token,
        label: "backup GitHub OAuth connection",
      });
    }
    return this.deps.github;
  }

  /** Create an in-memory snapshot (also used by /admin/backup/export). */
  async exportSnapshot(_settings = getBackupSettings(this.deps.kv)): Promise<BackupSnapshot> {
    return createSnapshot(this.deps.db);
  }

  /**
   * Create a full snapshot and store it in every configured destination:
   *   1. on disk next to the database (the mounted volume) — always, unless
   *      `localCopy` is off, so a backup exists even with no GitHub configured;
   *   2. in the configured GitHub repository — the off-machine copy.
   */
  async runNow(input?: Partial<Pick<BackupSettings, "repo" | "branch" | "path">>): Promise<BackupRunResult> {
    if (this.running) {
      return { ok: false, configured: true, githubKind: this.deps.github.kind, error: "A backup is already running" };
    }
    const settings: BackupSettings = mergeSettings(getEffectiveBackupSettings(this.deps.kv), input ?? {});
    const ref = repoRef(settings);
    const branch = settings.branch ?? "main";
    const base = normalizeBasePath(settings.path);
    const started = new Date();

    this.running = true;
    updateBackupStatus(this.deps.kv, {
      lastRunStatus: "running",
      lastRunAt: started.toISOString(),
      lastRunError: undefined,
    });
    try {
      const snapshot = await createSnapshot(this.deps.db, {
        includeEnv: settings.includeEnv,
        includeSecrets: settings.includeSecrets,
      });
      const dir = safeDirName(started);
      const snapshotPath = `${base}/${dir}`;
      // A passphrase protects the copies that live in the repo / on the volume;
      // the file an admin downloads stays plaintext (see `exportSnapshot`).
      const passphrase = getEnv().BACKUP_PASSPHRASE;
      const files = snapshotFilePaths(snapshotPath, snapshot, { passphrase });
      const secrets = describeEnvironmentBundle(snapshot.environment);
      const counts = {
        records: snapshot.records.length,
        jobs: snapshot.jobs.length,
        kv: snapshot.kv.length,
        ...(secrets ? { environment: secrets.envKeys, credentials: secrets.dbSecrets } : {}),
        byType: Object.entries(groupCounts(snapshot.records)).reduce<Record<string, number>>((acc, [k, v]) => {
          acc[k] = v;
          return acc;
        }, {}),
      };

      // ---- 1. local copy (works with no GitHub at all) ----
      let local: LocalWriteResult | undefined;
      let pruned: string[] | undefined;
      if (settings.localCopy) {
        const localDir = resolveLocalBackupDir(this.deps.db, settings.localDir);
        local = await writeLocalBackup(localDir, dir, files, bundleForStorage(snapshot, passphrase));
        if (local.ok) {
          pruned = await pruneLocalBackups(localDir, settings.retain ?? getEnv().BACKUP_LOCAL_RETAIN);
        } else {
          this.deps.logger.warn("local backup copy failed", { error: local.error, dir: localDir });
        }
      }

      // ---- 2. GitHub copy ----
      if (!settings.repo || !ref) {
        const warning = local?.ok
          ? "No GitHub repository configured — the snapshot was written to disk only (Admin → System Backup to push it off-machine)."
          : "Backup repository is not configured. Set owner/name in Admin → System Backup.";
        updateBackupStatus(this.deps.kv, {
          lastRunStatus: local?.ok ? "success" : "failed",
          lastRunError: local?.ok ? undefined : warning,
          lastRunAt: started.toISOString(),
          lastRunFiles: local?.files,
          lastRunBytes: local?.bytes,
          lastRunCounts: local?.ok
            ? {
                records: snapshot.records.length,
                jobs: snapshot.jobs.length,
                kv: snapshot.kv.length,
                files: local.files ?? 0,
              }
            : undefined,
        });
        return {
          ok: !!local?.ok,
          configured: false,
          githubKind: this.deps.github.kind,
          path: base,
          snapshotPath: local?.ok ? dir : undefined,
          files: local?.files,
          bytes: local?.bytes,
          counts: local?.ok ? counts : undefined,
          secrets,
          local,
          pruned,
          warning,
        };
      }

      const github = this.githubFor(settings);
      const filesPayload: GithubFile[] = files.map((f) => ({ path: f.path, content: f.content }));
      const latestPointer = {
        latest: snapshotPath,
        latestAt: snapshot.createdAt,
        commitMessage: `backup: system state (${snapshot.records.length} records, ${snapshot.jobs.length} jobs)`,
        createdAt: new Date().toISOString(),
        summary: snapshot.summary,
        counts: { records: snapshot.records.length, jobs: snapshot.jobs.length, kv: snapshot.kv.length },
        // Says, without revealing anything, whether this snapshot can restore
        // the API keys too — the first question after a disaster.
        ...(secrets
          ? {
              environment: {
                envKeys: secrets.envKeys,
                credentials: secrets.dbSecrets,
                secretKeys: secrets.secretKeys,
                encrypted: !!passphrase,
              },
            }
          : {}),
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
        counts,
        secrets,
        local,
        pruned,
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
        metadata: {
          repo: settings.repo,
          branch,
          path: snapshotPath,
          commit: commit.sha,
          files: filesPayload.length,
          // Never the values themselves — only how much credential material
          // travelled, so the audit log answers "did that backup include keys?".
          credentials: secrets?.dbSecrets ?? 0,
          environmentKeys: secrets?.envKeys ?? 0,
          secretsEncrypted: !!passphrase,
          localCopy: local?.ok ?? false,
        },
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
      return {
        ok: false,
        configured: !!settings.repo,
        githubKind: this.deps.github.kind,
        repo: settings.repo,
        branch,
        path: base,
        error: message,
      };
    } finally {
      this.running = false;
    }
  }

  /** List snapshot directories in the configured backup repository. */
  async listBackups(
    input?: Partial<Pick<BackupSettings, "repo" | "branch" | "path">>,
    limit = 50,
  ): Promise<BackupListEntry[]> {
    const settings: BackupSettings = mergeSettings(getEffectiveBackupSettings(this.deps.kv), input ?? {});
    const ref = repoRef(settings);
    if (!settings.repo || !ref) return [];
    const base = normalizeBasePath(settings.path);
    const branch = settings.branch ?? "main";
    const github = this.githubFor(settings);
    const entries = await github.listFiles(ref, branch, base);
    const manifests = entries
      .filter((e) => e.type === "blob" && e.path.split("/").pop() === "manifest.json")
      .map((e) => e.path)
      .sort();
    const out: BackupListEntry[] = [];
    for (const manifestPath of manifests.slice(-limit)) {
      const dir = manifestPath.replace(/\/manifest\.json$/, "");
      const id = dir.split("/").pop() ?? dir;
      const f = await github.getFile(ref, manifestPath, branch);
      if (!f) continue;
      try {
        const manifest = JSON.parse(f.content) as {
          createdAt?: string;
          summary?: { records?: number; jobs?: number; kv?: number };
          environment?: unknown;
          counts?: { environment?: unknown };
        };
        out.push({
          id,
          path: dir,
          createdAt: manifest.createdAt ?? "",
          records: Number(manifest.summary?.records ?? 0),
          jobs: Number(manifest.summary?.jobs ?? 0),
          kv: Number(manifest.summary?.kv ?? 0),
          source: "github",
          secrets: isObjectLike(manifest.environment) || isObjectLike(manifest.counts?.environment),
        });
      } catch {
        // Corrupt manifest entries are skipped.
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (out.length) out[0].latest = true;
    return out;
  }

  /** Snapshots written to disk next to the database (no GitHub needed). */
  async listLocal(limit = 50): Promise<BackupListEntry[]> {
    const settings = getEffectiveBackupSettings(this.deps.kv);
    const dir = resolveLocalBackupDir(this.deps.db, settings.localDir);
    const entries = await listLocalBackups(dir, limit);
    return entries.map((entry) => ({
      id: entry.id,
      path: entry.path,
      createdAt: entry.createdAt,
      records: entry.records,
      jobs: entry.jobs,
      kv: entry.kv,
      source: "local" as const,
      secrets: entry.secrets,
      secretsEncrypted: entry.secretsEncrypted,
      bytes: entry.bytes,
      latest: entry.latest,
    }));
  }

  /** Every snapshot this installation can restore from, newest first. */
  async listAll(limit = 50): Promise<BackupListEntry[]> {
    const [github, local] = await Promise.all([
      this.listBackups(undefined, limit).catch((err) => {
        this.deps.logger.warn("could not list GitHub backups", { error: errorMessage(err) });
        return [] as BackupListEntry[];
      }),
      this.listLocal(limit),
    ]);
    const merged = [...github, ...local].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
    merged.forEach((entry, index) => {
      entry.latest = index === 0;
    });
    return merged.slice(0, limit);
  }

  /**
   * Restore from a snapshot stored on this machine's volume. This is the path a
   * brand-new server takes when it was handed the backup directory (or when
   * GitHub is unreachable): the same complete snapshot, no network required.
   */
  async restoreFromLocal(input: {
    snapshot?: string;
    replace?: boolean;
    passphrase?: string;
  }): Promise<BackupRestoreResult> {
    const settings = getEffectiveBackupSettings(this.deps.kv);
    const dir = resolveLocalBackupDir(this.deps.db, settings.localDir);
    let target = input.snapshot && input.snapshot !== "latest" ? input.snapshot : undefined;
    if (!target) target = (await listLocalBackups(dir, 1))[0]?.id;
    if (!target) {
      return {
        ok: false,
        from: "local",
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input.replace ?? true,
        error: `No local backup found in ${dir}.`,
      };
    }
    if (!/^[A-Za-z0-9._-]+$/.test(target) || target === "." || target === "..") {
      return {
        ok: false,
        from: "local",
        snapshot: target,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input.replace ?? true,
        error: "Invalid backup snapshot id.",
      };
    }
    const files = await readLocalSnapshotFiles(dir, target);
    if (!files.length) {
      return {
        ok: false,
        from: "local",
        snapshot: target,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input.replace ?? true,
        error: `Backup is incomplete: ${target} holds no snapshot files.`,
      };
    }
    try {
      return this.restoreSnapshotObject(snapshotFromFiles(files, { passphrase: input.passphrase }), {
        snapshot: target,
        replace: input.replace ?? true,
        source: "local",
        passphrase: input.passphrase,
      });
    } catch (err) {
      return {
        ok: false,
        from: "local",
        snapshot: target,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input.replace ?? true,
        error: errorMessage(err),
      };
    }
  }

  /** Restore from a snapshot directory already committed to the configured repo. */
  async restoreFromGitHub(
    input?: Partial<
      Pick<BackupSettings, "repo" | "branch" | "path"> & { snapshot?: string; replace?: boolean; passphrase?: string }
    >,
  ): Promise<BackupRestoreResult> {
    const settings: BackupSettings = mergeSettings(getEffectiveBackupSettings(this.deps.kv), input ?? {});
    const ref = repoRef(settings);
    if (!settings.repo || !ref) {
      return {
        ok: false,
        from: "github",
        records: 0,
        jobs: 0,
        kv: 0,
        replace: true,
        error: "Backup repository is not configured.",
      };
    }
    const base = normalizeBasePath(settings.path);
    const branch = settings.branch ?? "main";
    const requested = input?.snapshot;
    // Use the same repo/branch/path overrides when resolving "latest". The old
    // code listed the globally configured repository here, so restoring with an
    // explicit repo/path could report success for the wrong snapshot or fail to
    // apply the backup the operator just selected.
    let latest: BackupListEntry | undefined;
    try {
      latest = (await this.listBackups({ repo: settings.repo, branch, path: base }, 1))[0];
    } catch (err) {
      return {
        ok: false,
        from: "github",
        repo: settings.repo,
        branch,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input?.replace ?? true,
        error: errorMessage(err),
      };
    }
    const target = requested && requested !== "latest" ? requested : latest?.id;
    if (!target) {
      return {
        ok: false,
        from: "github",
        repo: settings.repo,
        branch,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input?.replace ?? true,
        error: "No backup found in the configured repository.",
      };
    }
    // A snapshot id is one directory name, never a user-controlled path.
    if (!/^[A-Za-z0-9._-]+$/.test(target) || target === "." || target === "..") {
      return {
        ok: false,
        from: "github",
        repo: settings.repo,
        branch,
        snapshot: target,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input?.replace ?? true,
        error: "Invalid backup snapshot id.",
      };
    }

    const github = this.githubFor(settings);
    const dir = `${base}/${target}`;
    let manifest: GithubFile | undefined;
    try {
      manifest = await github.getFile(ref, `${dir}/manifest.json`, branch);
    } catch (err) {
      return {
        ok: false,
        from: "github",
        repo: settings.repo,
        branch,
        snapshot: target,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input?.replace ?? true,
        error: errorMessage(err),
      };
    }
    if (!manifest) {
      return {
        ok: false,
        from: "github",
        repo: settings.repo,
        branch,
        snapshot: target,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input?.replace ?? true,
        error: "Backup is incomplete: missing manifest.json",
      };
    }

    let names: string[];
    try {
      names = snapshotPartPathsFromManifest(manifest.content);
    } catch (err) {
      return {
        ok: false,
        from: "github",
        repo: settings.repo,
        branch,
        snapshot: target,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input?.replace ?? true,
        error: errorMessage(err),
      };
    }

    let loaded: Array<GithubFile | undefined>;
    try {
      loaded = await fetchBackupFiles(
        github,
        ref,
        names.map((name) => `${dir}/${name}`),
        branch,
      );
    } catch (err) {
      return {
        ok: false,
        from: "github",
        repo: settings.repo,
        branch,
        snapshot: target,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input?.replace ?? true,
        error: errorMessage(err),
      };
    }
    if (loaded.length !== names.length || loaded.some((file) => file === undefined)) {
      const index = loaded.findIndex((file) => file === undefined);
      return {
        ok: false,
        from: "github",
        repo: settings.repo,
        branch,
        snapshot: target,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input?.replace ?? true,
        error: `Backup is incomplete: missing ${names[index]}`,
      };
    }
    const files = [manifest, ...loaded].map((file) => ({ path: file!.path, content: file!.content }));
    try {
      return this.restoreSnapshotObject(snapshotFromFiles(files, { passphrase: input?.passphrase }), {
        repo: settings.repo,
        branch,
        snapshot: target,
        replace: input?.replace ?? true,
        source: "github",
        passphrase: input?.passphrase,
      });
    } catch (err) {
      return {
        ok: false,
        from: "github",
        repo: settings.repo,
        branch,
        snapshot: target,
        records: 0,
        jobs: 0,
        kv: 0,
        replace: input?.replace ?? true,
        error: errorMessage(err),
      };
    }
  }

  /**
   * Restore from an in-memory snapshot object (uploaded file / local import / test).
   *
   * Beyond the database rows this applies the snapshot's environment bundle: the
   * API keys that only ever lived in the environment are put back (and written to
   * `<database dir>/.env`), and every credential stored in a table is
   * re-encrypted with THIS server's AUTH_SECRET. That is what makes the same
   * file work on a different machine instead of restoring dead integrations.
   */
  restoreSnapshotObject(
    snapshot: unknown,
    meta?: {
      repo?: string;
      branch?: string;
      snapshot?: string;
      replace?: boolean;
      source?: "github" | "local" | "snapshot";
      passphrase?: string;
      overwriteEnv?: boolean;
      skipEnvFile?: boolean;
    },
  ): BackupRestoreResult {
    try {
      const normalized = normalizeBackupSnapshot(snapshot);
      const replace = meta?.replace ?? true;
      // Unlocking happens before any row is written: a bundle that cannot be
      // decrypted must fail the whole restore, not silently skip the keys.
      const bundle = resolveSnapshotBundle(normalized, meta?.passphrase);
      const result = restoreSnapshot(this.deps.db, normalized, replace);
      const environment = bundle
        ? summarizeEnvironment(
            applyEnvironmentBundle(this.deps.db, bundle, {
              overwriteEnv: meta?.overwriteEnv,
              skipEnvFile: meta?.skipEnvFile,
            }),
          )
        : undefined;
      // Drop cached provider adapters so restored provider config is re-read.
      this.deps.providerRegistry.all().forEach((p) => this.deps.providerRegistry.invalidate(p.id));
      updateBackupStatus(this.deps.kv, {
        lastRunStatus: "success",
        lastRunError: undefined,
        lastRunAt: new Date().toISOString(),
        lastRunCounts: { records: result.records, jobs: result.jobs, kv: result.kv },
      });
      const warnings = [...(environment?.warnings ?? [])];
      if (environment?.envFile && !environment.envFile.ok) warnings.push(environment.envFile.error ?? "");
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
        environment,
        warning: warnings.filter(Boolean).join("; ") || undefined,
      };
    } catch (err) {
      return {
        ok: false,
        from: meta?.source ?? "snapshot",
        records: 0,
        jobs: 0,
        kv: 0,
        replace: meta?.replace ?? true,
        error: errorMessage(err),
      };
    }
  }
}

async function fetchBackupFiles(
  github: IGitHubService,
  ref: GithubRepoRef,
  paths: string[],
  branch: string,
  concurrency = 8,
): Promise<Array<GithubFile | undefined>> {
  const out = new Array<GithubFile | undefined>(paths.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < paths.length) {
      const index = cursor++;
      out[index] = await github.getFile(ref, paths[index], branch);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, () => worker()));
  return out;
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
