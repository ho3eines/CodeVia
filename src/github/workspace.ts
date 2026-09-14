import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { GithubRepoRef, IGitHubService } from "./types.js";
import { listRepoPaths } from "./repo-read.js";
import { logger } from "../logger.js";

/**
 * Local repository workspaces — the clone-first execution model.
 *
 * Agents and the project chat READ code from a local shallow checkout that the
 * platform keeps fresh (clone once, then fetch/reset on demand), instead of
 * pulling every file over the GitHub Contents API on every request:
 *
 *   1. the chat/context surfaces get the whole real tree instantly — no rate
 *      limits, no hundreds of per-directory API calls, no 8-second budget
 *      timeouts on large repositories;
 *   2. the "the AI says it cannot see my repository" class of failures becomes
 *      diagnosable (clone errors carry git's own message);
 *   3. later execution stages (local test runs, diff generation) have a real
 *      working copy to operate on.
 *
 * WRITES still go through the GitHub API path (branch `agent-task-<id>`,
 * atomic commits, draft PR, CI checks, human merge) — the local copy is a
 * read/snapshot layer, never a silent writer.
 *
 * Materialisation strategies, in order of preference:
 *   1. `git` binary available + real GitHub  → shallow clone / fetch+reset;
 *   2. `downloadTarball` on the adapter      → one-request snapshot extraction;
 *   3. any adapter (incl. Mock)               → file-by-file materialisation
 *      through listRepoPaths + getFile (capped).
 *
 * Everything here is advisory: a failing workspace never breaks a chat send or
 * an agent run — callers fall back to the API path.
 */

export interface WorkspaceMeta {
  repo: string;
  branch: string;
  head?: string;
  source: "git" | "tarball" | "api" | "mock";
  fetchedAt: string;
  fileCount: number;
}

export interface WorkspaceHandle {
  root: string;
  meta: WorkspaceMeta;
  /** Relative blob paths (no .git/). */
  listFiles(): string[];
  readFile(path: string): string | undefined;
}

export interface WorkspaceManagerOptions {
  /** Directory holding all workspaces (default ./data/workspaces). */
  rootDir?: string;
  /** Master switch — when false, ensure/peek are no-ops (tests/CI). */
  enabled?: boolean;
  /** Base for https remotes; tests may point this at a local path/URL. */
  gitRemoteBase?: string;
  /** Override binary availability detection (tests). */
  capabilities?: { git?: boolean; tar?: boolean };
  cloneTimeoutMs?: number;
  /** Refuse workspaces bigger than this (defaults below). */
  maxFiles?: number;
  maxTotalBytes?: number;
  /** After a failed materialisation, do not retry for this long. */
  failureCooldownMs?: number;
  /** Custom remote URL builder (tests / GitHub Enterprise). */
  remoteUrlFor?: (repo: GithubRepoRef) => string;
  /** Default freshness window when the caller does not override it. */
  maxAgeMs?: number;
}

interface EnsureOptions {
  repo: GithubRepoRef;
  branch?: string;
  github: IGitHubService;
  /** Credential for private repositories (never logged, never persisted). */
  token?: string;
  /** Refresh even when the workspace is still fresh. */
  force?: boolean;
  /** A workspace younger than this is reused as-is (default 5 min). */
  maxAgeMs?: number;
}

const META_FILE = ".codevia-workspace.json";
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;

/** Repo parts must be safe as path components — dots-only names escape. */
function isValidRepoPart(part: string): boolean {
  return SAFE_NAME.test(part) && part !== "." && part !== ".." && !part.startsWith("-");
}

function safePart(part: string, fallback: string): string {
  return isValidRepoPart(part) ? part : fallback;
}

/** `feature/x` → `feature__x` so branches map to single directory names. */
function safeBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9_.-]/g, "__") || "HEAD";
}

function hasBinary(bin: string): boolean {
  try {
    const res = spawnSync(bin, ["--version"], { timeout: 5000, stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

export class WorkspaceManager {
  private readonly rootDir: string;
  private readonly gitRemoteBase: string;
  private readonly cloneTimeoutMs: number;
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly failureCooldownMs: number;
  private readonly remoteUrlFor?: (repo: GithubRepoRef) => string;
  private readonly caps: { git: boolean; tar: boolean };
  private readonly enabled: boolean;
  private readonly defaultMaxAgeMs: number;
  /** One materialisation per repo@branch at a time. */
  private readonly inflight = new Map<string, Promise<WorkspaceHandle | undefined>>();
  private readonly failures = new Map<string, number>();

  constructor(opts: WorkspaceManagerOptions = {}) {
    this.rootDir = opts.rootDir ?? "./data/workspaces";
    this.gitRemoteBase = opts.gitRemoteBase ?? "https://github.com";
    this.cloneTimeoutMs = opts.cloneTimeoutMs ?? 120_000;
    this.maxFiles = opts.maxFiles ?? 30_000;
    this.maxTotalBytes = opts.maxTotalBytes ?? 300 * 1024 * 1024;
    this.failureCooldownMs = opts.failureCooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.remoteUrlFor = opts.remoteUrlFor;
    this.enabled = opts.enabled ?? true;
    this.defaultMaxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.caps = {
      git: opts.capabilities?.git ?? hasBinary("git"),
      tar: opts.capabilities?.tar ?? hasBinary("tar"),
    };
  }

  private key(repo: GithubRepoRef, branch: string): string {
    return `${repo.owner}/${repo.name}@${branch}`;
  }

  private dirFor(repo: GithubRepoRef, branch: string): string {
    const owner = safePart(repo.owner, "owner");
    const name = safePart(repo.name, "repo");
    return join(this.rootDir, `${owner}--${name}`, safeBranch(branch));
  }

  private metaPath(dir: string): string {
    return join(dir, META_FILE);
  }

  /** Read the on-disk workspace when it exists and is fresh — no network. */
  peek(repo: GithubRepoRef, branch: string, maxAgeMs?: number): WorkspaceHandle | undefined {
    if (!this.enabled) return undefined;
    const dir = this.dirFor(repo, branch);
    return this.readHandle(dir, maxAgeMs ?? this.defaultMaxAgeMs);
  }

  private readHandle(dir: string, maxAgeMs: number): WorkspaceHandle | undefined {
    try {
      const meta = JSON.parse(readFileSync(this.metaPath(dir), "utf8")) as WorkspaceMeta;
      if (Date.now() - Date.parse(meta.fetchedAt) > maxAgeMs) return undefined;
      return this.handleFor(dir, meta);
    } catch {
      return undefined;
    }
  }

  private handleFor(dir: string, meta: WorkspaceMeta): WorkspaceHandle {
    const root = resolve(dir);
    return {
      root,
      meta,
      listFiles: () => walk(root).filter((p) => p !== META_FILE && !p.startsWith(".git/")),
      readFile: (path: string) => {
        const abs = resolve(root, path);
        // Never escape the workspace root (traversal guard).
        if (abs !== root && !abs.startsWith(root + sep)) return undefined;
        if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
        try {
          return readFileSync(abs, "utf8");
        } catch {
          return undefined;
        }
      },
    };
  }

  /**
   * Ensure a fresh local copy of `repo@branch`. Reuses a fresh workspace,
   * deduplicates concurrent callers, honours a cooldown after failures and
   * NEVER throws — the caller's fallback path is the source of truth for
   * degradation.
   */
  async ensure(opts: EnsureOptions): Promise<WorkspaceHandle | undefined> {
    if (!this.enabled) return undefined;
    const branch = opts.branch || "main";
    if (!isValidRepoPart(opts.repo.owner) || !isValidRepoPart(opts.repo.name)) return undefined;
    const key = this.key(opts.repo, branch);
    const dir = this.dirFor(opts.repo, branch);

    const existing = this.readHandle(dir, opts.maxAgeMs ?? this.defaultMaxAgeMs);
    if (existing && !opts.force) return existing;

    const cooledDownAt = this.failures.get(key);
    if (!opts.force && cooledDownAt && Date.now() - cooledDownAt < this.failureCooldownMs) return undefined;

    const running = this.inflight.get(key);
    if (running) return running;

    const job = (async (): Promise<WorkspaceHandle | undefined> => {
      try {
        const handle = await this.materialise({ ...opts, branch, dir });
        this.failures.delete(key);
        return handle;
      } catch (err) {
        this.failures.set(key, Date.now());
        logger.warn("workspace materialisation failed", {
          repo: key,
          err: redact(String(err instanceof Error ? err.message : err)),
        });
        return undefined;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, job);
    return job;
  }

  private async materialise(opts: EnsureOptions & { branch: string; dir: string }): Promise<WorkspaceHandle> {
    const { repo, branch, github } = opts;
    // Strategy 1: a real git shallow clone (fastest, works for huge repos).
    if (this.caps.git && github.kind === "real") {
      try {
        return await this.viaGit(opts);
      } catch (err) {
        logger.debug("workspace git strategy failed, falling back", { repo: this.key(repo, branch), err: String(err) });
      }
    }
    // Strategy 2: tarball snapshot (one HTTP request).
    if (github.downloadTarball && this.caps.tar) {
      try {
        return await this.viaTarball(opts);
      } catch (err) {
        logger.debug("workspace tarball strategy failed, falling back", {
          repo: this.key(repo, branch),
          err: String(err),
        });
      }
    }
    // Strategy 3: file-by-file through the adapter (mock + last resort).
    return this.viaApi(opts);
  }

  /* ----------------------------- git strategy ----------------------------- */

  private remoteUrl(repo: GithubRepoRef): string {
    if (this.remoteUrlFor) return this.remoteUrlFor(repo);
    return `${this.gitRemoteBase}/${repo.owner}/${repo.name}.git`;
  }

  private gitEnv(token?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (token) {
      // Inject the credential through git config env vars — the token never
      // appears in the argument vector (ps) or on disk.
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.extraheader";
      env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${token}`;
    }
    return env;
  }

  private runGit(args: string[], opts: { cwd?: string; token?: string }): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("git", args, {
        cwd: opts.cwd,
        env: this.gitEnv(opts.token),
        stdio: ["ignore", "pipe", "pipe"],
        signal: AbortSignal.timeout(this.cloneTimeoutMs),
      });
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolvePromise("");
        else reject(new Error(redact(`git ${args[0]} exited ${code}: ${stderr.slice(-400)}`)));
      });
    });
  }

  private async viaGit(opts: EnsureOptions & { branch: string; dir: string }): Promise<WorkspaceHandle> {
    const { repo, branch, dir, token } = opts;
    const url = this.remoteUrl(repo);
    if (existsSync(join(dir, ".git"))) {
      await this.runGit(["fetch", "--depth", "1", "origin", branch], { cwd: dir, token });
      await this.runGit(["checkout", "-f", branch], { cwd: dir, token }).catch(() =>
        this.runGit(["checkout", "-B", branch, "FETCH_HEAD"], { cwd: dir, token }),
      );
      await this.runGit(["reset", "--hard", "FETCH_HEAD"], { cwd: dir, token });
    } else {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dirname(dir), { recursive: true });
      await this.runGit(["clone", "--depth", "1", "--single-branch", "--branch", branch, url, dir], { token });
    }
    const head = await this.headSha(dir).catch(() => undefined);
    const meta = this.writeMeta(dir, {
      repo: `${repo.owner}/${repo.name}`,
      branch,
      head,
      source: "git",
    });
    this.enforceLimits(dir);
    return this.handleFor(dir, meta);
  }

  private headSha(dir: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("git", ["rev-parse", "HEAD"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolvePromise(out.trim()) : reject(new Error("rev-parse failed"))));
    });
  }

  /* --------------------------- tarball strategy --------------------------- */

  private async viaTarball(opts: EnsureOptions & { branch: string; dir: string }): Promise<WorkspaceHandle> {
    const { repo, branch, dir, github } = opts;
    if (!github.downloadTarball) throw new Error("adapter has no tarball support");
    const bytes = await github.downloadTarball(repo, branch);
    const staging = mkdtempSync(join(tmpdir(), "codevia-ws-"));
    const archive = join(staging, "repo.tar.gz");
    try {
      writeFileSync(archive, bytes);
      await this.runTar(["-xzf", archive, "-C", staging]);
      // GitHub tarballs contain exactly one top-level directory.
      const inner = readdirSync(staging).find((e) => e !== "repo.tar.gz" && statSync(join(staging, e)).isDirectory());
      if (!inner) throw new Error("tarball contained no directory");
      const extracted = join(staging, inner);
      // The top-level dir name encodes owner-repo-sha — use it as head hint.
      const head = inner.split("-").pop();
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dirname(dir), { recursive: true });
      cpSync(extracted, dir, { recursive: true });
      const meta = this.writeMeta(dir, {
        repo: `${repo.owner}/${repo.name}`,
        branch,
        head,
        source: "tarball",
      });
      this.enforceLimits(dir);
      return this.handleFor(dir, meta);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  private runTar(args: string[]): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("tar", args, {
        stdio: ["ignore", "ignore", "pipe"],
        signal: AbortSignal.timeout(this.cloneTimeoutMs),
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolvePromise() : reject(new Error(`tar exited ${code}: ${stderr.slice(-200)}`)),
      );
    });
  }

  /* ------------------------- adapter (api) strategy ------------------------ */

  private async viaApi(opts: EnsureOptions & { branch: string; dir: string }): Promise<WorkspaceHandle> {
    const { repo, branch, dir, github } = opts;
    const listing = await listRepoPaths(github, repo, branch);
    if (!listing.ok) throw new Error(listing.failureDetail ?? `repository unreadable (${listing.failure})`);
    const effectiveBranch = listing.branch;
    const paths = listing.paths.slice(0, this.maxFiles);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    let totalBytes = 0;
    const CONCURRENCY = 8;
    for (let i = 0; i < paths.length; i += CONCURRENCY) {
      const batch = paths.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (p) => {
          try {
            return { p, content: (await github.getFile(repo, p, effectiveBranch))?.content };
          } catch {
            return { p, content: undefined };
          }
        }),
      );
      for (const { p, content } of results) {
        if (content === undefined) continue;
        totalBytes += content.length;
        if (totalBytes > this.maxTotalBytes) throw new Error("repository snapshot exceeds workspace size limit");
        const target = resolve(dir, p);
        if (target !== dir && !target.startsWith(dir + sep)) continue; // traversal guard
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
    const meta = this.writeMeta(dir, {
      repo: `${repo.owner}/${repo.name}`,
      branch: effectiveBranch,
      source: github.kind === "mock" ? "mock" : "api",
    });
    return this.handleFor(dir, meta);
  }

  /* ------------------------------- utilities ------------------------------ */

  private writeMeta(dir: string, meta: Omit<WorkspaceMeta, "fetchedAt" | "fileCount">): WorkspaceMeta {
    const full: WorkspaceMeta = { ...meta, fetchedAt: new Date().toISOString(), fileCount: 0 };
    full.fileCount = walk(dir).filter((p) => p !== META_FILE && !p.startsWith(".git/")).length;
    writeFileSync(this.metaPath(dir), JSON.stringify(full, null, 2));
    return full;
  }

  private enforceLimits(dir: string): void {
    let files = 0;
    let bytes = 0;
    for (const p of walk(dir)) {
      if (p === META_FILE || p.startsWith(".git/")) continue;
      files += 1;
      try {
        bytes += statSync(join(dir, p)).size;
      } catch {
        /* vanished mid-scan */
      }
      if (files > this.maxFiles || bytes > this.maxTotalBytes) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(
          `repository snapshot exceeds workspace limits (${this.maxFiles} files / ${this.maxTotalBytes} bytes)`,
        );
      }
    }
  }
}

/** Recursively list relative file paths under root (symlinks skipped). */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) visit(abs);
      else if (e.isFile()) out.push(relative(root, abs).split(sep).join("/"));
    }
  };
  visit(root);
  return out.sort();
}

/** Keep credentials out of logs even when git echoes the remote URL. */
function redact(text: string): string {
  return text.replace(/https?:\/\/[^@\s]+@/g, "https://••••@");
}
