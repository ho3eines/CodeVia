/**
 * LocalGitService — a 100% offline `IGitHubService` backed by the git binary
 * installed on this machine.
 *
 * Design goals (local mode):
 *   - No request ever leaves the machine: no api.github.com, no OAuth, no
 *     GITHUB_TOKEN. Reads and writes go through local git plumbing commands
 *     (`ls-tree`, `cat-file`, `hash-object`, `read-tree`/`update-index`,
 *     `commit-tree`, `update-ref`, `merge-tree`).
 *   - The developer's working copy is sacred: commits are built in a private
 *     temporary index (GIT_INDEX_FILE), the branch is moved with a
 *     compare-and-swap `update-ref <ref> <new> <old>`, and only the *touched*
 *     paths are synced to the checked-out working tree — and never when they
 *     carry uncommitted local changes. Staged/unstaged edits in other files,
 *     including the index, are left exactly as they were.
 *   - `git worktree` is never used (nothing to leak into .git/worktrees);
 *     merges run through `git merge-tree --write-tree` (git >= 2.38), with a
 *     worktree fallback for older git that is created and removed inside one
 *     critical section.
 *   - Pull requests / issues are Git-platform concepts, not git concepts:
 *     they are stored in `<gitdir>/codevia-local-meta.json` (inside .git, so
 *     it never pollutes the working tree) and merged with real `merge-tree` +
 *     `commit-tree` + `update-ref` operations.
 *
 * Error contract: every failure is a `LocalGitError` (see local-git-error.ts)
 * with a stable `code`, HTTP `status`/`statusCode`, and `retryable` flag.
 * Failures that happen *after* the branch ref moved carry `committed: true`
 * plus the new `sha`, so callers never mistake a half-applied sync for a
 * failed commit.
 *
 * Push behaviour: with LOCAL_GIT_AUTO_PUSH=true the service runs
 * `git push <remote> <branch>` through the *user's own* git (credential
 * manager / SSH keys). A failed push is a warning — commits stay local.
 */

import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  IGitHubService,
  GithubRepoRef,
  GithubRepository,
  GithubViewer,
  GithubBranch,
  GithubCommit,
  GithubCheck,
  GithubPullRequest,
  GithubIssue,
  GithubRelease,
  GithubFile,
  GithubFileBuffer,
  GithubTreeEntry,
  ListRepositoriesOptions,
  CreateRepositoryOptions,
} from "./types.js";
import { logger } from "../logger.js";
import { isSensitivePath } from "../filesystem/filesystem-service.js";
import { LocalGitError, classifyGitFailure, trimGitStderr } from "./local-git-error.js";

/** True when the platform runs in 100% local git CLI mode (LOCAL_GIT_MODE). */
export function isLocalGitMode(): boolean {
  return envFlag(process.env.LOCAL_GIT_MODE);
}

function envFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export interface LocalGitServiceOptions {
  /** Root directory that holds the local repositories (default LOCAL_REPOS_DIR or ./repos). */
  rootDir?: string;
  /** Git executable (default LOCAL_GIT_BIN or "git"). */
  gitBin?: string;
  /** Push each commit/merge with the system git (default LOCAL_GIT_AUTO_PUSH). */
  autoPush?: boolean;
  /** Remote name to push to (default LOCAL_GIT_REMOTE or "origin"). */
  remoteName?: string;
  /** Owner reported for flat repos under rootDir (default LOCAL_GIT_OWNER or "local"). */
  defaultOwner?: string;
  /** Fetch the remote before repository reads (default LOCAL_GIT_AUTO_FETCH). */
  autoFetch?: boolean;
  /** Shell command run as a real CI check in getChecks (default LOCAL_GIT_VERIFY_CMD). */
  verifyCmd?: string;
  /** A lock file older than this is considered stale and removed (default 10 min). */
  staleLockMs?: number;
}

interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface GitExecOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface LocalGitImportFile {
  path: string;
  content: Buffer;
}

export interface LocalGitImportResult {
  repository: GithubRepository;
  repoDir: string;
  commit: GithubCommit;
}

export interface LocalGitTreeExport {
  sha: string;
  files: LocalGitImportFile[];
  totalBytes: number;
}

export interface LocalGitTreeExportLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/** PR/issue records as persisted (superset of the public wire types). */
interface StoredPullRequest extends GithubPullRequest {
  body?: string;
  comments?: string[];
}

interface StoredIssue extends GithubIssue {
  body?: string;
  comments?: string[];
}

interface LocalRepoMeta {
  pulls: StoredPullRequest[];
  issues: StoredIssue[];
  releases: GithubRelease[];
  description?: string;
}

const EXT_LANGUAGE: Record<string, string> = {
  ".cs": "C#",
  ".cshtml": "C#",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".java": "Java",
  ".rs": "Rust",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".cc": "C++",
  ".hpp": "C++",
  ".rb": "Ruby",
  ".php": "PHP",
  ".swift": "Swift",
  ".kt": "Kotlin",
  ".fs": "F#",
};

/**
 * Normalize a repository-relative path: backslashes → slashes, leading
 * slashes / drive letters stripped, `.` segments dropped. Returns `null` for
 * anything unsafe (empty, traversal via `..`, or anything under `.git`).
 */
export function normalizeRepoPath(p: string): string | null {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096) return null;
  const s = p
    .replace(/\\/g, "/")
    .replace(/^[a-zA-Z]:/, "")
    .replace(/^\/+/, "");
  const segs: string[] = [];
  for (const seg of s.split("/")) {
    if (seg.length === 0 || seg === ".") continue;
    if (seg === "..") return null;
    if (seg.toLowerCase() === ".git") return null;
    segs.push(seg);
  }
  return segs.length ? segs.join("/") : null;
}

/** A directory is a git repository when it has a .git entry (dir or worktree file) or is a bare repo. */
function isGitDir(dir: string): boolean {
  try {
    if (existsSync(join(dir, ".git"))) return true;
    return existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects")) && existsSync(join(dir, "refs"));
  } catch {
    return false;
  }
}

/** The null object id: `git update-ref` reads it as "the ref must not exist yet". */
const NO_PARENT = "0".repeat(40);

function validateBranchName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.length > 250) {
    throw new LocalGitError("LOCAL_INVALID_INPUT", `Invalid branch name: ${JSON.stringify(name)}`);
  }
  if (
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    /[\s~^:?*[\\\x00-\x1f]/.test(name)
  ) {
    throw new LocalGitError("LOCAL_INVALID_INPUT", `Invalid branch name: ${name}`);
  }
}

function isSha(value: string | undefined | null): value is string {
  return typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value);
}

export class LocalGitService implements IGitHubService {
  /**
   * "real": repositories on disk are real (not simulation scaffolds), so the
   * platform's mock-mode bypasses (merge gate, write access) do not apply.
   */
  readonly kind = "real" as const;

  private readonly rootDir: string;
  private readonly gitBin: string;
  private readonly autoPush: boolean;
  private readonly remoteName: string;
  private readonly defaultOwner: string;
  private readonly autoFetch: boolean;
  private readonly staleLockMs: number;

  private gitAvailable: Promise<void> | undefined;
  private readonly repoLocks = new Map<string, Promise<unknown>>();
  private readonly gitDirCache = new Map<string, string>();
  private readonly repoInfoCache = new Map<string, GithubRepository>();
  private readonly lastFetch = new Map<string, number>();
  /** merge-tree --write-tree support (git >= 2.38); detected lazily. */
  private mergeTreeSupport: boolean | undefined;

  constructor(opts: LocalGitServiceOptions = {}) {
    const rootDir = resolve(opts.rootDir ?? process.env.LOCAL_REPOS_DIR ?? "./repos");
    mkdirSync(rootDir, { recursive: true });
    this.rootDir = realpathSync(rootDir);
    this.gitBin = opts.gitBin ?? process.env.LOCAL_GIT_BIN ?? "git";
    this.autoPush = opts.autoPush ?? envFlag(process.env.LOCAL_GIT_AUTO_PUSH);
    this.remoteName = opts.remoteName ?? process.env.LOCAL_GIT_REMOTE ?? "origin";
    this.defaultOwner = opts.defaultOwner ?? process.env.LOCAL_GIT_OWNER ?? "local";
    this.autoFetch = opts.autoFetch ?? envFlag(process.env.LOCAL_GIT_AUTO_FETCH);
    if ((opts.verifyCmd ?? process.env.LOCAL_GIT_VERIFY_CMD)?.trim())
      logger.warn(
        "LOCAL_GIT_VERIFY_CMD is ignored: repository commands are never executed on the CodeVia host; use the Docker sandbox runner",
      );
    this.staleLockMs = opts.staleLockMs ?? (Number(process.env.LOCAL_GIT_STALE_LOCK_MS) || 10 * 60_000);
  }

  private assertNoSymlinkComponents(targetPath: string): void {
    const root = realpathSync(this.rootDir);
    const target = resolve(targetPath);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new LocalGitError("LOCAL_INVALID_INPUT", "Repository path escapes LOCAL_REPOS_DIR");
    let current = root;
    for (const segment of rel ? rel.split(sep) : []) {
      current = join(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new LocalGitError(
            "LOCAL_INVALID_INPUT",
            `Symbolic links are not allowed in repository paths: ${current}`,
          );
      } catch (err) {
        if (err instanceof LocalGitError) throw err;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
        throw err;
      }
    }
  }

  private assertSafeRepoDir(repoDir: string): void {
    this.assertNoSymlinkComponents(repoDir);
    try {
      if (lstatSync(join(repoDir, ".git")).isSymbolicLink())
        throw new LocalGitError("LOCAL_INVALID_INPUT", "A repository with a symbolic-link .git entry is not supported");
    } catch (err) {
      if (err instanceof LocalGitError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /* ------------------------------------------------------------------ *
   * git process plumbing
   * ------------------------------------------------------------------ */

  /** Run git; never rejects — failures come back as a non-zero `code`. */
  private git(args: string[], cwd: string, opts: GitExecOptions = {}): Promise<GitExecResult> {
    return new Promise((resolvePromise) => {
      execFile(
        this.gitBin,
        args,
        {
          cwd,
          timeout: opts.timeoutMs ?? 60_000,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (error, stdout, stderr) => {
          const err = error as { code?: number | string } | null;
          const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
          let errText = String(stderr ?? "");
          if (err?.code === "ENOENT" && !errText.trim()) {
            errText = `git binary not found or not runnable: ${this.gitBin}`;
          }
          resolvePromise({ stdout: String(stdout ?? ""), stderr: errText, code });
        },
      );
    });
  }

  /** Capture binary object data from git plumbing without UTF-8 corruption. */
  private gitBuffer(
    args: string[],
    cwd: string,
    opts: GitExecOptions = {},
  ): Promise<{ stdout: Buffer; stderr: string; code: number }> {
    return new Promise((resolvePromise) => {
      execFile(
        this.gitBin,
        args,
        {
          cwd,
          timeout: opts.timeoutMs ?? 60_000,
          maxBuffer: 128 * 1024 * 1024,
          windowsHide: true,
          encoding: "buffer",
          env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (error, stdout, stderr) => {
          const err = error as { code?: number | string } | null;
          const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
          let errText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
          if (err?.code === "ENOENT" && !errText.trim())
            errText = `git binary not found or not runnable: ${this.gitBin}`;
          resolvePromise({
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? "")),
            stderr: errText,
            code,
          });
        },
      );
    });
  }

  /** Run git and classify failures; retries once after removing a *stale* lock file. */
  private async gitChecked(
    args: string[],
    cwd: string,
    errContext: string,
    opts: GitExecOptions = {},
  ): Promise<GitExecResult> {
    const first = await this.git(args, cwd, opts);
    if (first.code === 0) return first;
    const lockFile = lockPathFromStderr(first.stderr, cwd);
    if (lockFile && (await this.removeStaleLock(lockFile))) {
      const second = await this.git(args, cwd, opts);
      if (second.code === 0) return second;
      throw classifyGitFailure(second.stderr, errContext);
    }
    throw classifyGitFailure(first.stderr, errContext);
  }

  /** One-time check that the git binary exists; every public method awaits it. */
  private ensureGitAvailable(): Promise<void> {
    this.gitAvailable ??= new Promise<void>((resolvePromise, rejectPromise) => {
      execFile(this.gitBin, ["--version"], { timeout: 15_000, windowsHide: true }, (error) => {
        if (error) {
          rejectPromise(
            new LocalGitError(
              "LOCAL_GIT_UNAVAILABLE",
              `Git binary not found or not runnable: "${this.gitBin}". Install Git (https://git-scm.com) or set LOCAL_GIT_BIN to the full path of the git executable.`,
            ),
          );
        } else {
          resolvePromise();
        }
      });
    });
    return this.gitAvailable;
  }

  /** Remove a lock file only when it is clearly stale (crashed git process). */
  private async removeStaleLock(lockFile: string): Promise<boolean> {
    try {
      const st = statSync(lockFile);
      if (Date.now() - st.mtimeMs < this.staleLockMs) return false;
      rmSync(lockFile, { force: true });
      logger.warn(
        `LocalGitService: removed stale git lock file (untouched for over ${Math.round(this.staleLockMs / 60_000)} minutes): ${lockFile}`,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Serialize writes per repository inside this process (concurrent state saves all land). */
  private withRepoLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
    const key = resolve(repoDir).toLowerCase();
    const previous = this.repoLocks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.repoLocks.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  /* ------------------------------------------------------------------ *
   * repo / ref / path resolution
   * ------------------------------------------------------------------ */

  private validateRepoRef(repo: GithubRepoRef): void {
    const ok = (s: unknown): s is string =>
      typeof s === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(s) &&
      s !== "." &&
      s !== ".." &&
      !s.endsWith(".lock");
    if (!ok(repo?.owner) || !ok(repo?.name)) {
      throw new LocalGitError("LOCAL_INVALID_INPUT", `Unsafe repository name: ${repo?.owner}/${repo?.name}`);
    }
  }

  /** Find the repository directory: <root>/<owner>/<name>[.git] then <root>/<name>[.git]. */
  private resolveRepoDir(repo: GithubRepoRef): string {
    this.validateRepoRef(repo);
    const candidates = [
      join(this.rootDir, repo.owner, repo.name),
      join(this.rootDir, repo.owner, `${repo.name}.git`),
      join(this.rootDir, repo.name),
      join(this.rootDir, `${repo.name}.git`),
    ];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      this.assertSafeRepoDir(candidate);
      if (isGitDir(candidate)) return candidate;
    }
    throw new LocalGitError(
      "LOCAL_REPO_NOT_FOUND",
      `Local repository not found for ${repo.owner}/${repo.name} (searched ${this.rootDir})`,
    );
  }

  /** Resolve a branch name or commit SHA to a full commit SHA (undefined when missing). */
  private async resolveCommitSha(repoDir: string, ref: string): Promise<string | undefined> {
    if (ref.startsWith("-")) return undefined; // never pass option-like strings to git
    const asBranch = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], repoDir);
    if (asBranch.code === 0) return asBranch.stdout.trim();
    const asCommit = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoDir);
    if (asCommit.code === 0) return asCommit.stdout.trim();
    return undefined;
  }

  private async branchHeadOpt(repoDir: string, branch: string): Promise<string | undefined> {
    validateBranchName(branch);
    const res = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoDir);
    return res.code === 0 ? res.stdout.trim() : undefined;
  }

  /** True when the repository has at least one branch (a commit exists somewhere). */
  private async repoHasAnyBranch(repoDir: string): Promise<boolean> {
    const res = await this.git(["for-each-ref", "--count=1", "refs/heads"], repoDir);
    return res.code === 0 && res.stdout.trim() !== "";
  }

  /**
   * Writes may create what reads only discover: a brand-new LOCAL_GIT_MODE
   * project points at a folder that does not exist yet, or was never
   * `git init`-ed. Initialize it at the canonical <rootDir>/<owner>/<name>
   * layout so the project can bootstrap itself. Reads never call this — a
   * missing repository keeps failing with LOCAL_REPO_NOT_FOUND.
   */
  private async ensureRepoDirForWrite(repo: GithubRepoRef, branch: string): Promise<string> {
    try {
      return this.resolveRepoDir(repo);
    } catch (err) {
      if (!(err instanceof LocalGitError) || err.code !== "LOCAL_REPO_NOT_FOUND") throw err;
    }
    const dir = join(this.rootDir, repo.owner, repo.name);
    this.assertNoSymlinkComponents(dirname(dir));
    mkdirSync(dir, { recursive: true });
    this.assertSafeRepoDir(dir);
    let res = await this.git(["init", "--initial-branch", branch], dir);
    if (res.code !== 0) {
      // git < 2.28 has no --initial-branch; plain init + symbolic-ref works everywhere.
      res = await this.git(["init"], dir);
      if (res.code !== 0) throw classifyGitFailure(res.stderr, `git init failed for ${repo.owner}/${repo.name}`);
      await this.git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir);
    }
    logger.info(`LocalGitService: initialized repository ${repo.owner}/${repo.name} at ${dir} (branch "${branch}")`);
    return dir;
  }

  private async requireBranchHead(repoDir: string, branch: string): Promise<string> {
    const sha = await this.branchHeadOpt(repoDir, branch);
    if (!sha) {
      throw new LocalGitError("LOCAL_REF_NOT_FOUND", `Branch "${branch}" does not exist in the local repository`);
    }
    return sha;
  }

  private async gitDirOf(repoDir: string): Promise<string> {
    const cached = this.gitDirCache.get(repoDir);
    if (cached) return cached;
    const res = await this.git(["rev-parse", "--absolute-git-dir"], repoDir);
    const dir = res.code === 0 && res.stdout.trim() ? resolve(repoDir, res.stdout.trim()) : join(repoDir, ".git");
    this.gitDirCache.set(repoDir, dir);
    return dir;
  }

  private async metaPath(repoDir: string): Promise<string> {
    return join(await this.gitDirOf(repoDir), "codevia-local-meta.json");
  }

  /* ------------------------------------------------------------------ *
   * metadata (PRs / issues) — corrupt files are NEVER overwritten
   * ------------------------------------------------------------------ */

  private async readMeta(repoDir: string): Promise<LocalRepoMeta> {
    const path = await this.metaPath(repoDir);
    if (!existsSync(path)) return { pulls: [], issues: [], releases: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new LocalGitError(
        "LOCAL_META_CORRUPT",
        `Local pull-request metadata is corrupt: ${path}. Restore it from ${path}.bak or fix it manually — CodeVia refuses to overwrite or silently reset it.`,
        { cause: err },
      );
    }
    const meta = parsed as Partial<LocalRepoMeta>;
    if (
      !meta ||
      typeof meta !== "object" ||
      !Array.isArray(meta.pulls) ||
      !Array.isArray(meta.issues) ||
      !Array.isArray(meta.releases)
    ) {
      throw new LocalGitError(
        "LOCAL_META_CORRUPT",
        `Local pull-request metadata has an invalid shape: ${path}. Restore it from ${path}.bak or fix it manually — CodeVia refuses to overwrite or silently reset it.`,
      );
    }
    return { pulls: meta.pulls, issues: meta.issues, releases: meta.releases, description: meta.description };
  }

  private async writeMeta(repoDir: string, meta: LocalRepoMeta): Promise<void> {
    const path = await this.metaPath(repoDir);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try {
        copyFileSync(path, `${path}.bak`);
      } catch {
        /* best-effort backup; the write itself must still happen */
      }
    }
    writeFileSync(path, JSON.stringify(meta, null, 2), "utf8");
  }

  /* ------------------------------------------------------------------ *
   * commit plumbing (private temp index — the user's index is untouched)
   * ------------------------------------------------------------------ */

  /** Author/committer identity for commits, from the user's git config (no config is written). */
  private async commitEnv(repoDir: string): Promise<Record<string, string>> {
    const name = (await this.git(["config", "user.name"], repoDir)).stdout.trim();
    const email = (await this.git(["config", "user.email"], repoDir)).stdout.trim();
    return {
      GIT_AUTHOR_NAME: name || "CodeVia Local Agent",
      GIT_AUTHOR_EMAIL: email || "agent@codevia.local",
      GIT_COMMITTER_NAME: name || "CodeVia Local Agent",
      GIT_COMMITTER_EMAIL: email || "agent@codevia.local",
    };
  }

  /**
   * Build a commit on `parent` in a private temporary index:
   * read-tree → update-index (adds/removes) → write-tree → commit-tree.
   * The repository's real index and working tree are never touched here.
   * Arguments are batched so very large commits cannot overflow argv (Windows).
   */
  private async commitViaIndex(
    repoDir: string,
    parent: string | undefined,
    message: string,
    adds: Array<{ path: string; content: string | Buffer }>,
    removes: string[],
  ): Promise<{ sha: string; author: string }> {
    const indexFile = join(tmpdir(), `codevia-index-${randomUUID()}`);
    const blobDir = join(tmpdir(), `codevia-blobs-${randomUUID()}`);
    const indexEnv = { GIT_INDEX_FILE: indexFile };
    try {
      // An unborn HEAD has no tree to read — the root commit starts from an empty index.
      if (parent !== undefined)
        await this.gitChecked(["read-tree", parent], repoDir, "git read-tree failed", { env: indexEnv });
      if (adds.length) {
        // Staging area for the blobs (content bytes are hashed verbatim with
        // --no-filters, exactly like the GitHub contents API).
        mkdirSync(blobDir, { recursive: true });
        const staged = adds.map((add, i) => {
          const tmp = join(blobDir, `f${i}`);
          writeFileSync(tmp, add.content);
          return { tmp, path: add.path };
        });
        const hashed: Array<{ path: string; sha: string }> = [];
        for (const part of chunk(staged, 60)) {
          const res = await this.gitChecked(
            ["hash-object", "-w", "--no-filters", ...part.map((s) => s.tmp)],
            repoDir,
            "git hash-object failed",
          );
          const shas = res.stdout
            .trim()
            .split(/\r?\n/)
            .map((s) => s.trim());
          part.forEach((s, i) => hashed.push({ path: s.path, sha: shas[i] ?? "" }));
        }
        // Existing modes (preserve the executable bit) in one lookup per batch.
        const modes = new Map<string, string>();
        if (parent !== undefined)
          for (const part of chunk(
            adds.map((a) => a.path),
            80,
          )) {
            const res = await this.git(["ls-tree", parent, "--", ...part.map((p) => `:(literal)${p}`)], repoDir);
            if (res.code !== 0) continue;
            for (const line of res.stdout.split("\n")) {
              if (!line.trim()) continue;
              const tabAt = line.indexOf("\t");
              if (tabAt < 0) continue;
              modes.set(line.slice(tabAt + 1).trim(), line.slice(0, tabAt).trim().split(/\s+/)[0]);
            }
          }
        for (const part of chunk(hashed, 60)) {
          const args = ["update-index", "--add"];
          for (const h of part) {
            const mode = modes.get(h.path) === "100755" ? "100755" : "100644";
            args.push("--cacheinfo", `${mode},${h.sha},${h.path}`);
          }
          await this.gitChecked(args, repoDir, "git update-index failed", { env: indexEnv });
        }
      }
      // Removing a path that is not in the tree is a successful no-op.
      for (const part of chunk(removes, 80)) {
        await this.gitChecked(["update-index", "--force-remove", ...part], repoDir, "git update-index failed", {
          env: indexEnv,
        });
      }
      const treeRes = await this.gitChecked(["write-tree"], repoDir, "git write-tree failed", { env: indexEnv });
      const env = await this.commitEnv(repoDir);
      const commitArgs = ["commit-tree", treeRes.stdout.trim()];
      if (parent !== undefined) commitArgs.push("-p", parent);
      commitArgs.push("-m", message);
      const commitRes = await this.gitChecked(commitArgs, repoDir, "git commit-tree failed", { env });
      return { sha: commitRes.stdout.trim(), author: env.GIT_AUTHOR_NAME };
    } finally {
      for (const file of [indexFile, blobDir]) {
        try {
          rmSync(file, { force: true, recursive: true });
        } catch {
          /* antivirus may briefly hold temp files on Windows */
        }
      }
    }
  }

  /** Paths changed between two commits (no renames: A/D pairs instead). */
  private async changedPaths(
    repoDir: string,
    from: string,
    to: string,
  ): Promise<Array<{ status: string; path: string }>> {
    const res = await this.git(["diff", "--no-renames", "--name-status", from, to], repoDir);
    if (res.code !== 0) return [];
    const out: Array<{ status: string; path: string }> = [];
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [status, ...rest] = line.split("\t");
      const path = rest.join("\t").trim();
      if (path) out.push({ status: status.trim(), path });
    }
    return out;
  }

  /**
   * Which of the touched paths carry uncommitted local changes? Must be asked
   * BEFORE the branch ref moves (afterwards our own commit would look dirty).
   *
   * A *staged deletion with no file on disk* is NOT counted as dirty: it holds
   * no local bytes to protect, and it is exactly the residue a failed
   * working-tree sync leaves behind (scenario C) — so the next commit heals it.
   * Everything else (untracked files, edits, working-tree deletions) protects
   * the developer's data and is skipped by the sync.
   */
  private async dirtyPaths(repoDir: string, paths: string[]): Promise<Set<string>> {
    const dirty = new Set<string>();
    if (!paths.length) return dirty;
    for (const part of chunk(paths, 80)) {
      const res = await this.git(["status", "--porcelain", "--", ...part], repoDir);
      if (res.code !== 0) return dirty; // best effort; real failures surface during sync
      for (const line of res.stdout.split("\n")) {
        if (line.length < 4) continue;
        const x = line[0];
        const y = line[1];
        const path = line.slice(3).trim();
        if (path.includes("->")) {
          // rename entries list both sides — protect both
          const [from, to] = path.split("->").map((s) => s.trim());
          if (from) dirty.add(from);
          if (to) dirty.add(to);
          continue;
        }
        if (x === "D" && y === " " && !existsSync(join(repoDir, path))) continue; // healable
        dirty.add(path);
      }
    }
    return dirty;
  }

  /**
   * Bring the checked-out working tree up to date with the moved branch — for
   * the explicitly touched paths only (never a full checkout: the developer's
   * staged/unstaged state elsewhere is left alone). Files with uncommitted
   * local changes are skipped (and warned about) so user data is never
   * overwritten. Paths are passed explicitly — not derived from a diff — so a
   * re-commit of identical content still heals a previously failed sync.
   */
  private async syncWorktreeIfCheckedOut(
    repoDir: string,
    branch: string,
    newSha: string,
    toWrite: string[],
    toRemove: string[],
    dirty: Set<string>,
  ): Promise<void> {
    const bare = await this.git(["rev-parse", "--is-bare-repository"], repoDir);
    if (bare.code === 0 && bare.stdout.trim() === "true") return;
    const head = await this.git(["symbolic-ref", "--short", "-q", "HEAD"], repoDir);
    if (head.code !== 0 || head.stdout.trim() !== branch) return;

    const checkout: string[] = [];
    for (const path of toWrite) {
      if (dirty.has(path)) {
        logger.warn(
          `LocalGitService: "${path}" has uncommitted local changes — the branch was updated but this file was NOT overwritten. Review it and run "git checkout ${branch} -- ${path}" if you want the committed version.`,
          { branch },
        );
        continue;
      }
      checkout.push(path);
    }
    const remove: string[] = toRemove.filter((path) => {
      if (dirty.has(path)) {
        logger.warn(
          `LocalGitService: "${path}" has uncommitted local changes — the branch was updated but this file was NOT deleted. Review it and run "git rm -- ${path}" if you want the deletion applied.`,
          { branch },
        );
        return false;
      }
      return true;
    });
    if (checkout.length) {
      for (const part of chunk(checkout, 80)) {
        await this.gitChecked(
          ["restore", `--source=${newSha}`, "--staged", "--worktree", "--", ...part],
          repoDir,
          `working-tree sync failed for branch "${branch}"`,
        );
      }
    }
    if (remove.length) {
      for (const part of chunk(remove, 80)) {
        await this.gitChecked(
          ["rm", "-f", "--ignore-unmatch", "--", ...part],
          repoDir,
          `working-tree sync failed for branch "${branch}"`,
        );
      }
    }
  }

  /** Wrap post-ref failures so callers can see the commit DID land. */
  private asCommittedError(err: unknown, sha: string, prefix: string): LocalGitError {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof LocalGitError) {
      return new LocalGitError(err.code, `${prefix}: ${err.message}`, { committed: true, sha });
    }
    return new LocalGitError("LOCAL_GIT_FAILED", `${prefix}: ${detail}`, { committed: true, sha, cause: err });
  }

  /** Compare-and-swap branch update; a concurrent mover yields LOCAL_STALE_PARENT. */
  private async updateRefChecked(repoDir: string, branch: string, newSha: string, oldSha: string): Promise<void> {
    await this.gitChecked(
      ["update-ref", `refs/heads/${branch}`, newSha, oldSha],
      repoDir,
      `git update-ref failed for branch "${branch}"`,
    );
  }

  /** Push through the user's own git (credential manager / SSH). Failure is a warning. */
  private async maybePush(repoDir: string, branch: string): Promise<void> {
    if (!this.autoPush) return;
    const remotes = await this.git(["remote"], repoDir);
    const names = remotes.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.includes(this.remoteName)) {
      logger.debug(`LocalGitService: auto-push is on but no remote "${this.remoteName}" exists — staying local`, {
        branch,
      });
      return;
    }
    const res = await this.git(["push", this.remoteName, branch], repoDir, { timeoutMs: 180_000 });
    if (res.code !== 0) {
      logger.warn(
        `LocalGitService: git push failed for branch "${branch}" — the commits are safe in the local repository and will be pushed on the next successful push.`,
        { remote: this.remoteName, stderr: trimGitStderr(res.stderr, 400) },
      );
    }
  }

  private async maybeFetch(repoDir: string): Promise<void> {
    if (!this.autoFetch) return;
    const now = Date.now();
    if (now - (this.lastFetch.get(repoDir) ?? 0) < 60_000) return;
    this.lastFetch.set(repoDir, now);
    const remotes = await this.git(["remote"], repoDir);
    if (
      !remotes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .includes(this.remoteName)
    )
      return;
    const res = await this.git(["fetch", "--prune", this.remoteName], repoDir, { timeoutMs: 120_000 });
    if (res.code !== 0) {
      logger.warn("LocalGitService: git fetch failed — continuing with local refs", {
        remote: this.remoteName,
        stderr: trimGitStderr(res.stderr, 200),
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * repository metadata / discovery
   * ------------------------------------------------------------------ */

  private async inspectRepo(owner: string, name: string, repoDir: string): Promise<GithubRepository | undefined> {
    if (!isGitDir(repoDir)) return undefined;
    const headRes = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], repoDir);
    const headSha = headRes.code === 0 ? headRes.stdout.trim() : undefined;
    const branchRes = await this.git(["symbolic-ref", "--short", "HEAD"], repoDir);
    let defaultBranch = branchRes.code === 0 ? branchRes.stdout.trim() : "";
    if (!defaultBranch) defaultBranch = "main";

    const cacheKey = `${repoDir}|${headSha ?? `unborn:${defaultBranch}`}`;
    const cached = this.repoInfoCache.get(cacheKey);
    if (cached) return { ...cached };
    if (this.repoInfoCache.size > 400) this.repoInfoCache.clear();

    let updatedAt: string | undefined;
    if (headSha) {
      const dateRes = await this.git(["log", "-1", "--format=%cI", headSha], repoDir);
      if (dateRes.code === 0 && dateRes.stdout.trim()) updatedAt = dateRes.stdout.trim();
    }
    const language = headSha ? await this.detectLanguage(repoDir, headSha) : undefined;
    let description: string | undefined;
    try {
      description = (await this.readMeta(repoDir)).description;
    } catch {
      /* corrupt metadata must not break listings; writes still refuse */
    }

    const info: GithubRepository = {
      owner,
      name,
      fullName: `${owner}/${name}`,
      private: true,
      defaultBranch,
      description: description ?? `Local repository at ${repoDir}`,
      htmlUrl: `file://${repoDir.replace(/\\/g, "/")}`,
      language,
      updatedAt: updatedAt ?? new Date().toISOString(),
      archived: false,
      permissions: { admin: true, push: true, pull: true },
    };
    this.repoInfoCache.set(cacheKey, info);
    return { ...info };
  }

  private async detectLanguage(repoDir: string, sha: string): Promise<string | undefined> {
    try {
      const res = await this.git(["ls-tree", "-r", "--name-only", sha], repoDir, { timeoutMs: 20_000 });
      if (res.code !== 0) return undefined;
      const counts = new Map<string, number>();
      let seen = 0;
      for (const line of res.stdout.split("\n")) {
        const path = line.trim();
        if (!path) continue;
        if (++seen > 5000) break; // sampling cap for large repositories
        if (path.startsWith("CodeVia/")) continue;
        const language = EXT_LANGUAGE[extname(path).toLowerCase()];
        if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
      }
      let best: string | undefined;
      let bestCount = 0;
      for (const [language, count] of counts) {
        if (count > bestCount) {
          best = language;
          bestCount = count;
        }
      }
      return best;
    } catch {
      return undefined;
    }
  }

  async listRepositories(opts: ListRepositoriesOptions = {}): Promise<GithubRepository[]> {
    await this.ensureGitAvailable();
    if (!existsSync(this.rootDir)) return [];
    const found = new Map<string, GithubRepository>();
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      // Case 1: a repository directly under rootDir → owned by defaultOwner.
      const direct = await this.inspectRepo(this.defaultOwner, stripDotGit(entry.name), join(this.rootDir, entry.name));
      if (direct) {
        found.set(direct.fullName, direct);
        continue;
      }
      // Case 2: an owner folder containing <owner>/<repo> pairs.
      const ownerDir = join(this.rootDir, entry.name);
      let subs;
      try {
        subs = readdirSync(ownerDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (!sub.isDirectory() || sub.name.startsWith(".")) continue;
        const nested = await this.inspectRepo(entry.name, stripDotGit(sub.name), join(ownerDir, sub.name));
        if (nested) found.set(nested.fullName, nested);
      }
    }
    const query = (opts.query ?? "").trim().toLowerCase();
    const list = [...found.values()].filter(
      (r) => !query || r.fullName.toLowerCase().includes(query) || (r.description ?? "").toLowerCase().includes(query),
    );
    return list.slice(0, opts.limit ?? 300);
  }

  async getRepository(repo: GithubRepoRef): Promise<GithubRepository | undefined> {
    await this.ensureGitAvailable();
    try {
      const repoDir = this.resolveRepoDir(repo);
      await this.maybeFetch(repoDir);
      return await this.inspectRepo(repo.owner, repo.name, repoDir);
    } catch (err) {
      if (err instanceof LocalGitError && err.code === "LOCAL_REPO_NOT_FOUND") return undefined;
      throw err;
    }
  }

  async createRepository(opts: CreateRepositoryOptions): Promise<GithubRepository> {
    await this.ensureGitAvailable();
    const owner = (opts.owner ?? this.defaultOwner).trim();
    const name = opts.name.trim();
    this.validateRepoRef({ owner, name });
    const defaultBranch = opts.defaultBranch ?? "main";
    validateBranchName(defaultBranch);
    const repoDir = join(this.rootDir, owner, name);
    this.assertNoSymlinkComponents(dirname(repoDir));
    if (existsSync(repoDir)) {
      throw new LocalGitError("LOCAL_INVALID_INPUT", `Repository already exists at ${repoDir}`);
    }
    mkdirSync(repoDir, { recursive: true });
    this.assertSafeRepoDir(repoDir);
    let initRes = await this.git(["init", "-b", defaultBranch], repoDir);
    if (initRes.code !== 0 && /unknown option/i.test(initRes.stderr)) {
      // git < 2.28 has no `init -b`
      initRes = await this.git(["init"], repoDir);
      if (initRes.code === 0) {
        await this.git(["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], repoDir);
      }
    }
    if (initRes.code !== 0) throw classifyGitFailure(initRes.stderr, "git init failed");
    if (opts.autoInit !== false) {
      writeFileSync(join(repoDir, "README.md"), `# ${name}\n\n${opts.description ?? ""}\n`, "utf8");
      const env = await this.commitEnv(repoDir);
      await this.gitChecked(["add", "README.md"], repoDir, "git add failed");
      await this.gitChecked(["commit", "-m", "Initial commit"], repoDir, "git commit failed", { env });
    }
    if (opts.description) {
      const meta = await this.readMeta(repoDir);
      meta.description = opts.description;
      await this.writeMeta(repoDir, meta);
    }
    const info = await this.inspectRepo(owner, name, repoDir);
    if (!info) throw new LocalGitError("LOCAL_GIT_FAILED", `Failed to initialize local repository at ${repoDir}`);
    return info;
  }

  /** Create a local repo and a single initial commit from validated regular files (including binary assets). */
  async createRepositoryFromFiles(
    opts: CreateRepositoryOptions,
    files: LocalGitImportFile[],
  ): Promise<LocalGitImportResult> {
    if (!files.length) throw new LocalGitError("LOCAL_INVALID_INPUT", "A project import needs at least one file");
    if (files.length > 20_000)
      throw new LocalGitError("LOCAL_INVALID_INPUT", "A project import cannot exceed 20,000 files");
    let totalBytes = 0;
    const validated = files.map((file) => {
      const path = normalizeRepoPath(file.path);
      if (
        !path ||
        path !== file.path ||
        path.split("/").some((segment) => [".git", ".hg", ".svn"].includes(segment.toLowerCase()))
      )
        throw new LocalGitError("LOCAL_INVALID_INPUT", `Unsafe imported file path: ${file.path}`);
      if (!Buffer.isBuffer(file.content))
        throw new LocalGitError("LOCAL_INVALID_INPUT", `Imported content must be a Buffer: ${path}`);
      if (file.content.length > 100 * 1024 * 1024)
        throw new LocalGitError("LOCAL_INVALID_INPUT", `Imported file is too large: ${path}`);
      totalBytes += file.content.length;
      if (totalBytes > 200 * 1024 * 1024)
        throw new LocalGitError("LOCAL_INVALID_INPUT", "Project import exceeds the 200 MiB Git-service limit");
      if (isSensitivePath(path))
        throw new LocalGitError("LOCAL_INVALID_INPUT", `Secret-bearing file is not importable: ${path}`);
      return { path, content: file.content };
    });
    const paths = validated.map((file) => file.path.toLocaleLowerCase("en-US"));
    if (new Set(paths).size !== paths.length)
      throw new LocalGitError("LOCAL_INVALID_INPUT", "Duplicate imported file paths");
    for (const file of validated) {
      const parts = file.path.split("/");
      for (let i = 1; i < parts.length; i++)
        if (paths.includes(parts.slice(0, i).join("/").toLocaleLowerCase("en-US")))
          throw new LocalGitError(
            "LOCAL_INVALID_INPUT",
            `File/directory path collision: ${parts.slice(0, i).join("/")}`,
          );
    }
    const repository = await this.createRepository({ ...opts, autoInit: false });
    const ref = { owner: repository.owner, name: repository.name };
    const repoDir = this.resolveRepoDir(ref);
    try {
      for (const file of validated) {
        const destination = resolve(repoDir, ...file.path.split("/"));
        const rel = relative(repoDir, destination);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
          throw new LocalGitError("LOCAL_INVALID_INPUT", `Imported file escapes the repository: ${file.path}`);
        this.assertNoSymlinkComponents(dirname(destination));
        mkdirSync(dirname(destination), { recursive: true });
        this.assertNoSymlinkComponents(dirname(destination));
        writeFileSync(destination, file.content, { flag: "wx", mode: 0o644 });
      }
      const now = new Date().toISOString();
      const commit = await this.withRepoLock(repoDir, async () => {
        const { sha, author } = await this.commitViaIndex(repoDir, undefined, "Initial project import", validated, []);
        await this.updateRefChecked(repoDir, repository.defaultBranch, sha, NO_PARENT);
        await this.gitChecked(["read-tree", sha], repoDir, "git read-tree failed after project import");
        await this.maybePush(repoDir, repository.defaultBranch);
        return { sha, message: "Initial project import", author, date: now };
      });
      this.repoInfoCache.clear();
      const saved = await this.inspectRepo(repository.owner, repository.name, repoDir);
      if (!saved) throw new LocalGitError("LOCAL_GIT_FAILED", `Imported repository disappeared: ${repoDir}`);
      return { repository: saved, repoDir, commit };
    } catch (err) {
      this.repoInfoCache.clear();
      rmSync(repoDir, { recursive: true, force: true });
      throw err;
    }
  }

  /** Remove a just-created import that could not be registered; never follows symlinked repository components. */
  discardUnregisteredRepository(repoDir: string): void {
    const absolute = resolve(repoDir);
    this.assertSafeRepoDir(absolute);
    const rel = relative(this.rootDir, absolute);
    if (rel.split(sep).filter(Boolean).length < 2 || rel.split(sep).filter(Boolean).length > 2)
      throw new LocalGitError(
        "LOCAL_INVALID_INPUT",
        "Only a direct LOCAL_REPOS_DIR owner/name repository can be discarded",
      );
    rmSync(absolute, { recursive: true, force: true });
    this.repoInfoCache.clear();
  }

  async getViewer(): Promise<GithubViewer> {
    await this.ensureGitAvailable();
    const name = (await this.git(["config", "user.name"], this.rootDir)).stdout.trim();
    return {
      login: name ? name.replace(/\s+/g, "-") : this.defaultOwner,
      name: name || "Local Git User",
      scopes: ["repo", "read:user", "user:email"],
    };
  }

  /* ------------------------------------------------------------------ *
   * reads
   * ------------------------------------------------------------------ */

  async listBranches(repo: GithubRepoRef): Promise<GithubBranch[]> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    const res = await this.git(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], repoDir);
    if (res.code !== 0) throw classifyGitFailure(res.stderr, `git for-each-ref failed in ${repo.owner}/${repo.name}`);
    return res.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const spaceAt = line.lastIndexOf(" ");
        return { name: line.slice(0, spaceAt), sha: line.slice(spaceAt + 1) };
      });
  }

  async listCommits(repo: GithubRepoRef, branch?: string): Promise<GithubCommit[]> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    const ref = (branch ?? "").trim();
    const sha = await this.resolveCommitSha(repoDir, ref || "HEAD");
    if (!sha) return []; // unknown branch → empty history (UI-friendly absence)
    const res = await this.git(["log", "-n", "30", "--format=%H%x09%an%x09%cI%x09%s", sha], repoDir);
    if (res.code !== 0) throw classifyGitFailure(res.stderr, `git log failed in ${repo.owner}/${repo.name}`);
    return res.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha2, author, date, ...message] = line.split("\t");
        return { sha: sha2, author, date, message: message.join("\t") };
      });
  }

  async listFiles(repo: GithubRepoRef, branch?: string, path?: string): Promise<GithubTreeEntry[]> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    const ref = (branch ?? "").trim();
    const sha = await this.resolveCommitSha(repoDir, ref || "HEAD");
    if (!sha) {
      if (!ref && (await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], repoDir)).code !== 0) {
        return []; // freshly initialized repository: no commits yet
      }
      throw new LocalGitError("LOCAL_REF_NOT_FOUND", `Ref "${ref || "HEAD"}" not found in ${repo.owner}/${repo.name}`);
    }
    const prefix = path ? normalizeRepoPath(path) : null;
    if (path && !prefix) return []; // unsafe/empty path → no matches
    const args = ["ls-tree", "-r", "-l", "-z", "--full-tree", sha];
    if (prefix) args.push("--", `:(literal)${prefix}`);
    const res = await this.git(args, repoDir);
    if (res.code !== 0) throw classifyGitFailure(res.stderr, `git ls-tree failed in ${repo.owner}/${repo.name}`);
    const stdout = res.stdout;
    if (prefix && !stdout.trim()) {
      // project-state relies on this exact signal: a missing CodeVia/ folder
      // is a 404 so it falls back to reading the repository root.
      throw new LocalGitError(
        "LOCAL_PATH_NOT_FOUND",
        `Path "${prefix}" not found in ${repo.owner}/${repo.name}@${sha.slice(0, 7)}`,
      );
    }
    const entries: GithubTreeEntry[] = [];
    for (const chunk of stdout.split("\0")) {
      if (!chunk) continue;
      const tabAt = chunk.indexOf("\t");
      if (tabAt < 0) continue;
      const meta = chunk.slice(0, tabAt).trim().split(/\s+/);
      const filePath = chunk.slice(tabAt + 1);
      const size = Number(meta[3]);
      entries.push({
        path: filePath,
        type: meta[1] === "tree" ? "tree" : "blob",
        size: Number.isFinite(size) ? size : undefined,
        mode: meta[0],
      });
    }
    return entries;
  }

  async getFile(repo: GithubRepoRef, path: string, branch?: string): Promise<GithubFile | undefined> {
    await this.ensureGitAvailable();
    const cleanPath = normalizeRepoPath(path);
    if (!cleanPath) return undefined; // unsafe paths simply do not exist
    let repoDir: string;
    try {
      repoDir = this.resolveRepoDir(repo);
    } catch (err) {
      if (err instanceof LocalGitError && err.code === "LOCAL_REPO_NOT_FOUND") return undefined;
      throw err;
    }
    const ref = (branch ?? "").trim() || "HEAD";
    if (ref.startsWith("-")) return undefined;
    const shaRes = await this.git(["rev-parse", "--verify", "--quiet", `${ref}:${cleanPath}`], repoDir);
    if (shaRes.code !== 0) return undefined;
    const blobSha = shaRes.stdout.trim();
    const typeRes = await this.git(["cat-file", "-t", blobSha], repoDir);
    if (typeRes.code !== 0 || typeRes.stdout.trim() !== "blob") return undefined; // directories are not files
    const show = await this.git(["cat-file", "blob", blobSha], repoDir);
    if (show.code !== 0) return undefined;
    return { path: cleanPath, content: show.stdout, sha: blobSha };
  }

  async getFileBuffer(repo: GithubRepoRef, path: string, branch?: string): Promise<GithubFileBuffer | undefined> {
    await this.ensureGitAvailable();
    const cleanPath = normalizeRepoPath(path);
    if (!cleanPath) return undefined;
    let repoDir: string;
    try {
      repoDir = this.resolveRepoDir(repo);
    } catch (err) {
      if (err instanceof LocalGitError && err.code === "LOCAL_REPO_NOT_FOUND") return undefined;
      throw err;
    }
    const ref = (branch ?? "").trim() || "HEAD";
    if (ref.startsWith("-")) return undefined;
    const shaRes = await this.git(["rev-parse", "--verify", "--quiet", `${ref}:${cleanPath}`], repoDir);
    if (shaRes.code !== 0) return undefined;
    const blobSha = shaRes.stdout.trim();
    const typeRes = await this.git(["cat-file", "-t", blobSha], repoDir);
    if (typeRes.code !== 0 || typeRes.stdout.trim() !== "blob") return undefined;
    const blob = await this.gitBuffer(["cat-file", "blob", blobSha], repoDir);
    if (blob.code !== 0) return undefined;
    return { path: cleanPath, content: blob.stdout, sha: blobSha };
  }

  /** Export an immutable commit tree as regular-file buffers for the Docker sandbox; symlinks are refused. */
  async exportTreeFiles(
    repo: GithubRepoRef,
    ref: string,
    limits: LocalGitTreeExportLimits = {},
  ): Promise<LocalGitTreeExport> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    const sha = await this.resolveCommitSha(repoDir, ref);
    if (!sha) throw new LocalGitError("LOCAL_REF_NOT_FOUND", `Ref "${ref}" not found in ${repo.owner}/${repo.name}`);
    const maxFiles = limits.maxFiles ?? 5000;
    const maxFileBytes = limits.maxFileBytes ?? 25 * 1024 * 1024;
    const maxTotalBytes = limits.maxTotalBytes ?? 200 * 1024 * 1024;
    const listed = await this.gitBuffer(["ls-tree", "-r", "-l", "-z", "--full-tree", sha], repoDir, {
      timeoutMs: 60_000,
    });
    if (listed.code !== 0) throw classifyGitFailure(listed.stderr, `git ls-tree failed in ${repo.owner}/${repo.name}`);
    const records: Array<{ meta: string; path: string }> = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let offset = 0;
    while (offset < listed.stdout.length) {
      const end = listed.stdout.indexOf(0, offset);
      if (end < 0) throw new LocalGitError("LOCAL_GIT_FAILED", "Malformed NUL-delimited git tree output");
      const record = listed.stdout.subarray(offset, end);
      offset = end + 1;
      if (!record.length) continue;
      const tabAt = record.indexOf(0x09);
      if (tabAt < 0) throw new LocalGitError("LOCAL_GIT_FAILED", "Malformed git tree entry");
      try {
        records.push({
          meta: decoder.decode(record.subarray(0, tabAt)).trim(),
          path: decoder.decode(record.subarray(tabAt + 1)),
        });
      } catch {
        throw new LocalGitError(
          "LOCAL_INVALID_INPUT",
          "Repository contains a non-UTF-8 path that cannot be safely sandboxed",
        );
      }
    }
    if (records.length > maxFiles)
      throw new LocalGitError(
        "LOCAL_INVALID_INPUT",
        `Repository has more than ${maxFiles} files for sandbox execution`,
      );
    const files: LocalGitImportFile[] = [];
    let totalBytes = 0;
    for (const record of records) {
      const [mode, type, blobSha, rawSize] = record.meta.split(/\s+/);
      const path = record.path;
      if (mode === "120000")
        throw new LocalGitError("LOCAL_INVALID_INPUT", `Sandbox refuses repository symbolic links: ${path}`);
      if (mode === "160000" || type !== "blob")
        throw new LocalGitError("LOCAL_INVALID_INPUT", `Sandbox refuses submodule or non-file tree entries: ${path}`);
      const cleanPath = normalizeRepoPath(path);
      if (!cleanPath || cleanPath !== path || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path))
        throw new LocalGitError("LOCAL_INVALID_INPUT", `Unsafe path in repository tree: ${JSON.stringify(path)}`);
      if (isSensitivePath(path)) continue;
      const size = Number(rawSize);
      if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes)
        throw new LocalGitError("LOCAL_INVALID_INPUT", `File exceeds the sandbox per-file limit: ${path}`);
      totalBytes += size;
      if (totalBytes > maxTotalBytes)
        throw new LocalGitError(
          "LOCAL_INVALID_INPUT",
          `Repository exceeds the sandbox source limit of ${maxTotalBytes} bytes`,
        );
      const blob = await this.gitBuffer(["cat-file", "blob", blobSha], repoDir, { timeoutMs: 60_000 });
      if (blob.code !== 0 || blob.stdout.length !== size)
        throw new LocalGitError("LOCAL_GIT_FAILED", `Could not read repository object for ${path}`);
      files.push({ path, content: blob.stdout });
    }
    if (!files.length)
      throw new LocalGitError(
        "LOCAL_INVALID_INPUT",
        "Repository has no importable regular files for sandbox execution",
      );
    return { sha, files, totalBytes };
  }

  /* ------------------------------------------------------------------ *
   * writes
   * ------------------------------------------------------------------ */

  async createBranch(repo: GithubRepoRef, name: string, baseSha: string): Promise<GithubBranch> {
    await this.ensureGitAvailable();
    validateBranchName(name);
    if (!isSha(baseSha)) {
      throw new LocalGitError("LOCAL_INVALID_INPUT", `Invalid base commit SHA: ${String(baseSha).slice(0, 12)}`);
    }
    const repoDir = this.resolveRepoDir(repo);
    const res = await this.git(["branch", "--force", name, baseSha], repoDir);
    if (res.code !== 0) {
      if (/not a valid object name|not a valid branch point/i.test(res.stderr)) {
        throw new LocalGitError(
          "LOCAL_REF_NOT_FOUND",
          `Base commit ${baseSha.slice(0, 7)} not found in ${repo.owner}/${repo.name}`,
        );
      }
      if (/checked out/i.test(res.stderr)) {
        throw new LocalGitError(
          "LOCAL_GIT_FAILED",
          `Cannot force-update branch "${name}": it is checked out. Use a different agent branch name.`,
        );
      }
      throw classifyGitFailure(res.stderr, `git branch failed for "${name}"`);
    }
    const sha = (await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], repoDir)).stdout.trim();
    if (!sha) throw classifyGitFailure(res.stderr, `git branch failed for "${name}"`);
    await this.maybePush(repoDir, name);
    return { name, sha };
  }

  async commit(
    repo: GithubRepoRef,
    branch: string,
    message: string,
    files: GithubFile[],
    parentSha?: string,
  ): Promise<GithubCommit> {
    await this.ensureGitAvailable();
    validateBranchName(branch);
    const repoDir = await this.ensureRepoDirForWrite(repo, branch);
    const adds = (files ?? []).map((f) => {
      const path = normalizeRepoPath(f?.path ?? "");
      if (!path) throw new LocalGitError("LOCAL_INVALID_INPUT", `Unsafe repository path: ${f?.path}`);
      if (typeof f.content !== "string")
        throw new LocalGitError("LOCAL_INVALID_INPUT", `File content must be a string: ${path}`);
      return { path, content: f.content };
    });

    return this.withRepoLock(repoDir, async () => {
      const head = await this.branchHeadOpt(repoDir, branch);
      if (head === undefined) {
        // Creating a missing branch on a repository that already has commits
        // would fork history — keep refusing exactly as before. A repository
        // with no commit at all (a fresh `git init`, unborn HEAD) has nothing
        // to fork: the write becomes the root commit and creates the branch.
        if (await this.repoHasAnyBranch(repoDir))
          throw new LocalGitError("LOCAL_REF_NOT_FOUND", `Branch "${branch}" does not exist in the local repository`);
      } else if (parentSha && parentSha !== head) {
        throw new LocalGitError(
          "LOCAL_STALE_PARENT",
          "Repository changed after inspection; refusing to overwrite newer work.",
        );
      }
      // Ask BEFORE the ref moves — after it, our own commit would look dirty.
      const dirty = await this.dirtyPaths(
        repoDir,
        adds.map((a) => a.path),
      );
      const { sha, author } = await this.commitViaIndex(repoDir, head, message, adds, []);
      await this.updateRefChecked(repoDir, branch, sha, head ?? NO_PARENT);
      try {
        await this.syncWorktreeIfCheckedOut(
          repoDir,
          branch,
          sha,
          adds.map((a) => a.path),
          [],
          dirty,
        );
      } catch (err) {
        throw this.asCommittedError(
          err,
          sha,
          `Commit ${sha.slice(0, 7)} was created and branch "${branch}" points to it, but the working tree could not be synced`,
        );
      }
      await this.maybePush(repoDir, branch);
      return { sha, message, author, date: new Date().toISOString() };
    });
  }

  async deleteFiles(
    repo: GithubRepoRef,
    branch: string,
    message: string,
    paths: string[],
    parentSha?: string,
  ): Promise<GithubCommit> {
    await this.ensureGitAvailable();
    validateBranchName(branch);
    const repoDir = this.resolveRepoDir(repo);
    const removes = (paths ?? []).map((p) => {
      const path = normalizeRepoPath(p ?? "");
      if (!path) throw new LocalGitError("LOCAL_INVALID_INPUT", `Unsafe repository path: ${p}`);
      return path;
    });

    return this.withRepoLock(repoDir, async () => {
      const head = await this.requireBranchHead(repoDir, branch);
      if (parentSha && parentSha !== head) {
        throw new LocalGitError(
          "LOCAL_STALE_PARENT",
          "Repository changed after inspection; refusing to delete newer work.",
        );
      }
      const dirty = await this.dirtyPaths(repoDir, removes);
      const { sha, author } = await this.commitViaIndex(repoDir, head, message, [], removes);
      await this.updateRefChecked(repoDir, branch, sha, head);
      try {
        await this.syncWorktreeIfCheckedOut(repoDir, branch, sha, [], removes, dirty);
      } catch (err) {
        throw this.asCommittedError(
          err,
          sha,
          `Commit ${sha.slice(0, 7)} was created and branch "${branch}" points to it, but the working tree could not be synced`,
        );
      }
      await this.maybePush(repoDir, branch);
      return { sha, message, author, date: new Date().toISOString() };
    });
  }

  /* ------------------------------------------------------------------ *
   * pull requests (local metadata) & merges (real git)
   * ------------------------------------------------------------------ */

  async listPullRequests(repo: GithubRepoRef): Promise<GithubPullRequest[]> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    const meta = await this.readMeta(repoDir);
    return meta.pulls.filter((p) => p.state === "open").map((p) => ({ ...p }));
  }

  async getPullRequest(repo: GithubRepoRef, number: number): Promise<GithubPullRequest | undefined> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    const pr = (await this.readMeta(repoDir)).pulls.find((p) => p.number === number);
    if (!pr) return undefined;
    const liveHead = await this.branchHeadOpt(repoDir, pr.head);
    return { ...pr, headSha: liveHead ?? pr.headSha };
  }

  async createPullRequest(
    repo: GithubRepoRef,
    title: string,
    body: string,
    head: string,
    base: string,
    opts?: { draft?: boolean },
  ): Promise<GithubPullRequest> {
    await this.ensureGitAvailable();
    validateBranchName(head);
    validateBranchName(base);
    const repoDir = this.resolveRepoDir(repo);
    const headSha = await this.branchHeadOpt(repoDir, head);
    if (!headSha) {
      throw new LocalGitError("LOCAL_REF_NOT_FOUND", `Cannot open a pull request: head branch "${head}" not found`);
    }
    if (!(await this.branchHeadOpt(repoDir, base))) {
      throw new LocalGitError("LOCAL_REF_NOT_FOUND", `Cannot open a pull request: base branch "${base}" not found`);
    }
    // The whole read-modify-write runs under the repo lock so a concurrent
    // merge (or another PR) can never lose this write.
    return this.withRepoLock(repoDir, async () => {
      const meta = await this.readMeta(repoDir);
      // Idempotent: an open PR for the same head/base pair is returned as-is.
      const existing = meta.pulls.find((p) => p.state === "open" && p.head === head && p.base === base);
      if (existing) {
        return { ...existing, headSha: (await this.branchHeadOpt(repoDir, head)) ?? existing.headSha };
      }
      const number = meta.pulls.reduce((max, p) => Math.max(max, p.number), 0) + 1;
      const pr: StoredPullRequest = {
        number,
        draft: opts?.draft ?? false,
        title,
        state: "open",
        head,
        base,
        body,
        htmlUrl: `local://${repo.owner}/${repo.name}/pull/${number}`,
        createdAt: new Date().toISOString(),
        headSha,
      };
      meta.pulls.unshift(pr);
      await this.writeMeta(repoDir, meta);
      return { ...pr };
    });
  }

  async updatePullRequest(
    repo: GithubRepoRef,
    number: number,
    patch: Partial<{ title: string; body: string; state: string }>,
  ): Promise<GithubPullRequest> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    return this.withRepoLock(repoDir, async () => {
      const meta = await this.readMeta(repoDir);
      const pr = meta.pulls.find((p) => p.number === number);
      if (!pr) {
        throw new LocalGitError(
          "LOCAL_REF_NOT_FOUND",
          `Pull request #${number} not found in ${repo.owner}/${repo.name}`,
        );
      }
      if (patch.title !== undefined) pr.title = patch.title;
      if (patch.body !== undefined) pr.body = patch.body;
      if (patch.state !== undefined) pr.state = patch.state;
      await this.writeMeta(repoDir, meta);
      return { ...pr };
    });
  }

  async mergePullRequest(
    repo: GithubRepoRef,
    number: number,
    opts?: { method?: "merge" | "squash" | "rebase"; commitTitle?: string; sha?: string },
  ): Promise<{ merged: boolean; sha?: string; message?: string }> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);

    return this.withRepoLock(repoDir, async () => {
      const meta = await this.readMeta(repoDir);
      const pr = meta.pulls.find((p) => p.number === number);
      if (!pr) return { merged: false, message: `Pull request #${number} not found in ${repo.owner}/${repo.name}` };
      if (pr.state !== "open") return { merged: false, message: `Pull request #${number} is already ${pr.state}` };
      const headSha = await this.branchHeadOpt(repoDir, pr.head);
      const baseSha = await this.branchHeadOpt(repoDir, pr.base);
      if (!headSha || !baseSha) {
        return { merged: false, message: `Branch "${pr.head}" or "${pr.base}" not found — nothing to merge` };
      }
      if (opts?.sha && headSha !== opts.sha) {
        return { merged: false, message: "Head branch moved since review" };
      }
      const merged = await this.mergeTree(repoDir, baseSha, headSha);
      if (merged.code !== 0) {
        const conflicts = merged.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /^CONFLICT/i.test(l))
          .slice(0, 5);
        return {
          merged: false,
          message:
            `Merge conflict between "${pr.head}" and "${pr.base}"` +
            (conflicts.length ? `: ${conflicts.join("; ")}` : "") +
            ". Resolve it locally (git merge), push a rebased branch, then retry.",
        };
      }
      const tree = merged.stdout.split(/\r?\n/)[0].trim();
      const method = opts?.method === "squash" || opts?.method === "rebase" ? "squash" : "merge";
      const commitTitle =
        opts?.commitTitle ??
        (method === "squash" ? `Merge PR #${number}: ${pr.title}` : `Merge pull request #${number} from ${pr.head}`);
      const env = await this.commitEnv(repoDir);
      const args =
        method === "squash"
          ? ["commit-tree", tree, "-p", baseSha, "-m", commitTitle]
          : ["commit-tree", tree, "-p", baseSha, "-p", headSha, "-m", commitTitle];
      const commitRes = await this.gitChecked(args, repoDir, `git commit-tree failed while merging PR #${number}`, {
        env,
      });
      const newSha = commitRes.stdout.trim();

      // Dirty check before the ref moves (see commit()).
      const changed = await this.changedPaths(repoDir, baseSha, newSha);
      const dirty = await this.dirtyPaths(
        repoDir,
        changed.map((c) => c.path),
      );
      const toWrite = changed.filter((c) => !c.status.startsWith("D")).map((c) => c.path);
      const toRemove = changed.filter((c) => c.status.startsWith("D")).map((c) => c.path);

      const upd = await this.git(["update-ref", `refs/heads/${pr.base}`, newSha, baseSha], repoDir);
      if (upd.code !== 0) {
        if (/is at [0-9a-f]+ but expected/i.test(upd.stderr)) {
          return { merged: false, message: `Base branch "${pr.base}" moved during the merge — please retry` };
        }
        throw classifyGitFailure(upd.stderr, `git update-ref failed while merging PR #${number}`);
      }
      pr.state = "merged";
      await this.writeMeta(repoDir, meta);
      try {
        await this.syncWorktreeIfCheckedOut(repoDir, pr.base, newSha, toWrite, toRemove, dirty);
      } catch (err) {
        throw this.asCommittedError(
          err,
          newSha,
          `PR #${number} was merged as ${newSha.slice(0, 7)}, but the working tree could not be synced`,
        );
      }
      await this.maybePush(repoDir, pr.base);
      return { merged: true, sha: newSha, message: `Merged locally via git (${method})` };
    });
  }

  /**
   * 3-way merge via `git merge-tree --write-tree <base> <head>` (git >= 2.38).
   * Exit 0 + first line = merged tree OID; exit 1 = conflict. Older git falls
   * back to a throwaway worktree that is always removed and pruned.
   */
  private async mergeTree(repoDir: string, baseSha: string, headSha: string): Promise<GitExecResult> {
    if (this.mergeTreeSupport !== false) {
      const res = await this.git(["merge-tree", "--write-tree", baseSha, headSha], repoDir);
      if (res.code === 0 || res.code === 1) return res;
      if (/unknown option|usage:/i.test(res.stderr)) {
        this.mergeTreeSupport = false;
      } else {
        return res;
      }
    }
    return this.mergeTreeViaWorktree(repoDir, baseSha, headSha);
  }

  private async mergeTreeViaWorktree(repoDir: string, baseSha: string, headSha: string): Promise<GitExecResult> {
    const worktreeDir = join(tmpdir(), `codevia-merge-${randomUUID()}`);
    try {
      const add = await this.git(["worktree", "add", "--detach", worktreeDir, baseSha], repoDir);
      if (add.code !== 0) return { stdout: "", stderr: add.stderr, code: 1 };
      const merge = await this.git(["merge", "--no-ff", "--no-commit", headSha], worktreeDir);
      if (merge.code !== 0) {
        return { stdout: "", stderr: merge.stderr, code: 1 };
      }
      const tree = await this.git(["write-tree"], worktreeDir);
      if (tree.code !== 0) return { stdout: "", stderr: tree.stderr, code: 1 };
      return { stdout: tree.stdout, stderr: "", code: 0 };
    } finally {
      await this.git(["worktree", "remove", "--force", worktreeDir], repoDir);
      try {
        rmSync(worktreeDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      await this.git(["worktree", "prune"], repoDir);
    }
  }

  /* ------------------------------------------------------------------ *
   * checks (local CI) / issues / releases
   * ------------------------------------------------------------------ */

  /** Repository-integrity evidence only. Project code is verified by the Docker sandbox tool, never by a host shell command. */
  async getChecks(repo: GithubRepoRef, sha: string): Promise<GithubCheck[]> {
    await this.ensureGitAvailable();
    let repoDir: string | undefined;
    try {
      repoDir = this.resolveRepoDir(repo);
    } catch {
      return [{ name: "local-git-integrity", status: "failure", detail: "Local repository not found" }];
    }
    if (!isSha(sha)) {
      return [
        { name: "local-git-integrity", status: "failure", detail: `Invalid commit SHA: ${String(sha).slice(0, 12)}` },
      ];
    }
    const exists = await this.git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], repoDir);
    if (exists.code !== 0) {
      return [
        {
          name: "local-git-integrity",
          status: "failure",
          detail: `Commit ${sha.slice(0, 7)} does not exist in the local repository`,
        },
      ];
    }
    const checks: GithubCheck[] = [
      {
        name: "local-git-integrity",
        status: "success",
        detail: `Commit ${sha.slice(0, 7)} verified in the local git object database`,
      },
    ];
    return checks;
  }

  async listIssues(repo: GithubRepoRef): Promise<GithubIssue[]> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    return (await this.readMeta(repoDir)).issues.map((i) => ({ ...i }));
  }

  async createIssue(repo: GithubRepoRef, title: string, body: string): Promise<GithubIssue> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    return this.withRepoLock(repoDir, async () => {
      const meta = await this.readMeta(repoDir);
      const number = meta.issues.reduce((max, i) => Math.max(max, i.number), 0) + 1;
      const issue: StoredIssue = {
        number,
        title,
        state: "open",
        body,
        htmlUrl: `local://${repo.owner}/${repo.name}/issues/${number}`,
      };
      meta.issues.unshift(issue);
      await this.writeMeta(repoDir, meta);
      return { ...issue };
    });
  }

  async commentOnIssue(repo: GithubRepoRef, number: number, body: string): Promise<void> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    await this.withRepoLock(repoDir, async () => {
      const meta = await this.readMeta(repoDir);
      const issue = meta.issues.find((i) => i.number === number);
      if (!issue) {
        logger.debug(`LocalGitService: comment on missing issue #${number} ignored`, {
          repo: `${repo.owner}/${repo.name}`,
        });
        return;
      }
      issue.comments = [...(issue.comments ?? []), body];
      await this.writeMeta(repoDir, meta);
    });
  }

  async commentOnPullRequest(repo: GithubRepoRef, number: number, body: string): Promise<void> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    await this.withRepoLock(repoDir, async () => {
      const meta = await this.readMeta(repoDir);
      const pr = meta.pulls.find((p) => p.number === number);
      if (!pr) {
        logger.debug(`LocalGitService: comment on missing pull request #${number} ignored`, {
          repo: `${repo.owner}/${repo.name}`,
        });
        return;
      }
      pr.comments = [...(pr.comments ?? []), body];
      await this.writeMeta(repoDir, meta);
    });
  }

  async listReleases(repo: GithubRepoRef): Promise<GithubRelease[]> {
    await this.ensureGitAvailable();
    const repoDir = this.resolveRepoDir(repo);
    return (await this.readMeta(repoDir)).releases.map((r) => ({ ...r }));
  }
}

function stripDotGit(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

/**
 * Split a list into fixed-size chunks. Guards against Windows argv length
 * limits (~32k chars) when an agent commits/reads hundreds of files at once.
 */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Extract the lock file path git complains about (absolute or cwd-relative). */
function lockPathFromStderr(stderr: string, cwd: string): string | undefined {
  const match = /unable to create '([^']+)'(?:\.\.\.)?:?/i.exec(stderr) ?? /'([^']+\.lock)'/i.exec(stderr);
  if (!match) return undefined;
  const path = match[1];
  return isAbsolute(path) ? path : resolve(cwd, path);
}
