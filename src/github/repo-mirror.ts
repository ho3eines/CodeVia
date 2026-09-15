import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logger } from "../logger.js";

/**
 * Read-only local mirror of a project's repository.
 *
 * What it is for
 * --------------
 * Repository *reading* — the file tree, README/manifests for the chat brief,
 * whole-file contents for agent context, and `git grep` code search — used to go
 * through the GitHub REST API. That costs one request per directory (fixed for
 * listings by the Git Trees API) and one request per file, is rate limited, and
 * cannot answer "where is this symbol used?" at all.
 *
 * A bare `git clone --mirror` on the CodeVia host makes all of that local and
 * instant, and it is what users expect when they say "clone the project first".
 *
 * What it is NOT
 * --------------
 * It is **not** a working copy and **not** an execution sandbox: nothing here
 * checks files out, installs dependencies, or runs repository code. Writes still
 * go through the GitHub API as an atomic commit on the task branch, and tests
 * are still read from GitHub check runs (see docs/AGENT_EXECUTION.md — running
 * `npm test`/`dotnet test` on the platform host would mean executing arbitrary
 * third-party code next to every account's tokens). Every `git` invocation is
 * `execFile` with a fixed argv (never a shell), read-only plumbing, a timeout
 * and an output cap.
 *
 * Isolation
 * ---------
 * Mirrors live under `<root>/<scope-hash>/<owner>/<name>.git`. The scope is the
 * acting account, so one account's private clone is never served to another
 * account that links the same repository name; token-less (public) clones share
 * the `public` scope. The credential is passed through `GIT_CONFIG_*` env vars
 * as an `http.extraHeader`, so it appears neither in the process argv nor in the
 * mirrored repository's config.
 */

export interface MirrorGitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface MirrorRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Cooperative cancellation (the registry / task cancel path). */
  signal?: AbortSignal;
}

/** Test seam: replace `git` entirely (no binary, no network). */
export type MirrorRunner = (args: string[], opts: MirrorRunOptions) => Promise<MirrorGitResult>;

export interface MirrorOptions {
  /** Root directory for mirrors (default `REPO_MIRROR_DIR` or `<data dir>/mirrors`). */
  root?: string;
  /** Master switch (default `REPO_MIRROR_ENABLED`, on). */
  enabled?: boolean;
  /** How long a mirror is considered fresh before a fetch (default 300 s). */
  refreshMs?: number;
  /** Per-git-command timeout (default 120 s for clone/fetch, 20 s for reads). */
  timeoutMs?: number;
  /** Read timeout for ls-tree/show/grep (default 20 s). */
  readTimeoutMs?: number;
  /** Hard cap on listed paths (default 20 000). */
  maxFiles?: number;
  /** Hard cap on a single file read, in bytes (default 512 KB). */
  maxReadBytes?: number;
  /** Refuse to keep a mirror larger than this (default 2 000 MB). */
  maxRepoMb?: number;
  /** Maximum grep hits (default 60). */
  maxSearchHits?: number;
  /** `git` binary (default `git`). */
  gitPath?: string;
  /** Clone URL template; `{repo}` is replaced with `owner/name` (default GitHub). */
  urlTemplate?: string;
  run?: MirrorRunner;
}

export type MirrorBlocker =
  | "disabled"
  | "git-missing"
  | "invalid-repo"
  | "clone-failed"
  | "fetch-failed"
  | "too-large"
  | "timeout"
  | "unreadable";

export interface MirrorState {
  enabled: boolean;
  /** A usable mirror exists on disk right now. */
  ready: boolean;
  repo: string;
  scope: string;
  path?: string;
  exists: boolean;
  headSha?: string;
  defaultBranch?: string;
  branches?: number;
  files?: number;
  sizeMb?: number;
  clonedAt?: string;
  fetchedAt?: string;
  fetchMs?: number;
  /** Why it is not ready (never contains a credential). */
  blocker?: MirrorBlocker;
  error?: string;
}

export interface MirrorSyncOptions {
  /** Acting account id — mirrors are stored per scope and never shared across accounts. */
  scope?: string;
  /** Bearer token for private repositories (public repos clone anonymously). */
  token?: string;
  /** Force a fetch even when the mirror is still fresh. */
  force?: boolean;
  /** Repository size hint in KB (from the GitHub API) to skip hopeless clones. */
  sizeKb?: number;
  signal?: AbortSignal;
}

export interface MirrorReadOptions {
  scope?: string;
  branch?: string;
  /** Only list paths under this folder. */
  prefix?: string;
}

const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Mirrors are ON by default in production, but **off under test** unless
 * explicitly enabled: `sync()` performs a real `git clone`, and the suites boot
 * containers against the mock GitHub (repository names that exist nowhere).
 * Tests that exercise the mirror build one with a `file://` URL template.
 */
function mirrorEnabledByDefault(): boolean {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return false;
  return true;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function defaultRoot(): string {
  const configured = (process.env.REPO_MIRROR_DIR ?? "").trim();
  if (configured) return resolve(configured);
  const dbPath = (process.env.DATABASE_PATH ?? "./data/codevia.db").trim() || "./data/codevia.db";
  return resolve(dirname(dbPath), "mirrors");
}

/** Reject anything that could escape the mirror root or be read as a git flag. */
function safeName(value: string | undefined): string | undefined {
  const v = String(value ?? "").trim();
  return v && v.length <= 100 && SAFE_NAME.test(v) && v !== "." && v !== ".." ? v : undefined;
}

/** Reject refs/paths that could be parsed as options or traverse the tree. */
function safeRef(value: string | undefined): string | undefined {
  const v = String(value ?? "").trim();
  if (!v || v.length > 200 || v.startsWith("-")) return undefined;
  if (/[\x00-\x20~^:?*[\\]/.test(v)) return undefined;
  if (v.includes("..") || v.endsWith(".lock")) return undefined;
  return v;
}

function safePath(value: string | undefined): string | undefined {
  const v = String(value ?? "")
    .trim()
    .replace(/^\/+/, "");
  if (!v || v.length > 500 || v.startsWith("-")) return undefined;
  if (v.split("/").some((part) => part === ".." || part === ".")) return undefined;
  if (/[\x00-\x20]/.test(v)) return undefined;
  return v;
}

/** Never let a credential reach a log line, an audit record or an API response. */
function redact(text: string, token?: string): string {
  let out = String(text ?? "");
  if (token && token.length >= 6) out = out.split(token).join("[redacted]");
  return out.replace(/(AUTHORIZATION:\s*bearer\s+)\S+/gi, "$1[redacted]").slice(0, 400);
}

/** A tiny FIFO semaphore so a burst of chat messages cannot start 20 clones. */
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

/** Recursive directory size in KB (bounded depth; mirrors are shallow). */
function dirSizeKb(dir: string, depth = 0): number {
  if (depth > 12) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSizeKb(full, depth + 1);
      else if (entry.isFile()) total += statSync(full).size / 1024;
    } catch {
      /* a vanished pack file must not fail the report */
    }
  }
  return total;
}

const defaultRunner: MirrorRunner = (args, opts) =>
  new Promise<MirrorGitResult>((resolvePromise) => {
    execFile(
      args[0]!,
      args.slice(1),
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code =
          typeof (error as { code?: number })?.code === "number"
            ? ((error as { code?: number }).code as number)
            : error
              ? 1
              : 0;
        resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
      },
    );
  });

export class RepoMirrorService {
  private readonly root: string;
  private readonly enabled: boolean;
  private readonly refreshMs: number;
  private readonly timeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly maxFiles: number;
  private readonly maxReadBytes: number;
  private readonly maxRepoMb: number;
  private readonly maxSearchHits: number;
  private readonly gitPath: string;
  private readonly urlTemplate: string;
  private readonly run: MirrorRunner;
  private readonly gates = new Semaphore(2);
  /** path key → last successful sync (freshness) and the in-flight promise. */
  private readonly freshness = new Map<string, { at: number }>();
  private readonly inflight = new Map<string, Promise<MirrorState>>();
  private gitCheck: Promise<{ available: boolean; version?: string; reason?: string }> | undefined;

  constructor(opts: MirrorOptions = {}) {
    this.root = opts.root ? resolve(opts.root) : defaultRoot();
    this.enabled = opts.enabled ?? envBool("REPO_MIRROR_ENABLED", mirrorEnabledByDefault());
    this.refreshMs = opts.refreshMs ?? envNumber("REPO_MIRROR_REFRESH_MS", 300_000);
    this.timeoutMs = opts.timeoutMs ?? envNumber("REPO_MIRROR_TIMEOUT_MS", 120_000);
    this.readTimeoutMs = opts.readTimeoutMs ?? envNumber("REPO_MIRROR_READ_TIMEOUT_MS", 20_000);
    this.maxFiles = opts.maxFiles ?? envNumber("REPO_MIRROR_MAX_FILES", 20_000);
    this.maxReadBytes = opts.maxReadBytes ?? envNumber("REPO_MIRROR_MAX_READ_BYTES", 512 * 1024);
    this.maxRepoMb = opts.maxRepoMb ?? envNumber("REPO_MIRROR_MAX_MB", 2_000);
    this.maxSearchHits = opts.maxSearchHits ?? envNumber("REPO_MIRROR_MAX_SEARCH_HITS", 60);
    this.gitPath = opts.gitPath ?? process.env.REPO_MIRROR_GIT_PATH ?? "git";
    this.urlTemplate = opts.urlTemplate ?? process.env.REPO_MIRROR_URL_TEMPLATE ?? "https://github.com/{repo}.git";
    this.run = opts.run ?? defaultRunner;
  }

  get mirrorRoot(): string {
    return this.root;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Is a usable `git` binary present? (Cached; the answer never changes at runtime.) */
  async detectGit(): Promise<{ available: boolean; version?: string; reason?: string }> {
    if (!this.enabled) return { available: false, reason: "disabled" };
    if (!this.gitCheck) {
      this.gitCheck = (async () => {
        try {
          const res = await this.run([this.gitPath, "--version"], { timeoutMs: 10_000 });
          if (res.code === 0) return { available: true, version: res.stdout.trim().split("\n")[0] };
          return { available: false, reason: `git exited ${res.code}: ${redact(res.stderr)}` };
        } catch (err) {
          return { available: false, reason: `git not runnable: ${redact(String((err as Error)?.message ?? err))}` };
        }
      })();
    }
    return this.gitCheck;
  }

  private scopeKey(scope?: string): string {
    const s = String(scope ?? "").trim();
    if (!s) return "public";
    return `acct-${createHash("sha1").update(s).digest("hex").slice(0, 16)}`;
  }

  /** Absolute path of a mirror; `undefined` when the repo name is not safe. */
  mirrorPath(repo: string, scope?: string): string | undefined {
    const [owner, ...rest] = String(repo ?? "").split("/");
    const name = rest.join("/");
    const safeOwner = safeName(owner);
    const safeRepo = safeName(name);
    if (!safeOwner || !safeRepo) return undefined;
    return join(this.root, this.scopeKey(scope), safeOwner, `${safeRepo}.git`);
  }

  private cloneUrl(repo: string): string {
    return this.urlTemplate.replace("{repo}", repo);
  }

  /** Environment for a git child process: no shell config, no prompts, no token in argv. */
  private gitEnv(token?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(this.root, ".empty-gitconfig"),
      GIT_OPTIONAL_LOCKS: "0",
      GCM_INTERACTIVE: "never",
      LC_ALL: "C.UTF-8",
    };
    delete env.GIT_ASKPASS;
    delete env.SSH_ASKPASS;
    if (token) {
      // Env-based config keeps the credential out of `ps` output and out of the
      // mirrored repository's own config file.
      env.GIT_CONFIG_COUNT = "2";
      env.GIT_CONFIG_KEY_0 = "http.extraHeader";
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: bearer ${token}`;
      env.GIT_CONFIG_KEY_1 = "protocol.version";
      env.GIT_CONFIG_VALUE_1 = "2";
    } else {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "protocol.version";
      env.GIT_CONFIG_VALUE_0 = "2";
    }
    return env;
  }

  private async git(args: string[], opts: MirrorRunOptions & { token?: string }): Promise<MirrorGitResult> {
    const env = this.gitEnv(opts.token);
    mkdirSync(dirname(env.GIT_CONFIG_GLOBAL!), { recursive: true });
    return this.run([this.gitPath, ...args], { ...opts, env });
  }

  /**
   * Make sure a fresh mirror exists: clone when missing, fetch when stale.
   * Concurrent callers for the same repository share one operation.
   */
  async sync(repo: string, opts: MirrorSyncOptions = {}): Promise<MirrorState> {
    const base: MirrorState = {
      enabled: this.enabled,
      ready: false,
      repo,
      scope: this.scopeKey(opts.scope),
      exists: false,
    };
    if (!this.enabled) return { ...base, blocker: "disabled" };
    const path = this.mirrorPath(repo, opts.scope);
    if (!path) return { ...base, blocker: "invalid-repo", error: `"${repo}" is not a valid owner/name` };
    const git = await this.detectGit();
    if (!git.available) return { ...base, path, blocker: "git-missing", error: git.reason };
    if (opts.sizeKb && opts.sizeKb / 1024 > this.maxRepoMb)
      return {
        ...base,
        path,
        blocker: "too-large",
        sizeMb: Math.round(opts.sizeKb / 1024),
        error: `repository is ~${Math.round(opts.sizeKb / 1024)} MB; the mirror cap is ${this.maxRepoMb} MB`,
      };

    const key = path;
    const existingInflight = this.inflight.get(key);
    if (existingInflight) return existingInflight;
    const fresh = this.freshness.get(key);
    if (!opts.force && fresh && existsSync(join(path, "HEAD")) && Date.now() - fresh.at < this.refreshMs)
      return {
        ...(await this.describe(repo, path, opts.scope)),
        ready: true,
        fetchedAt: new Date(fresh.at).toISOString(),
      };

    const task = (async (): Promise<MirrorState> => {
      const release = await this.gates.acquire();
      const started = Date.now();
      try {
        mkdirSync(dirname(path), { recursive: true });
        const isClone = !existsSync(join(path, "HEAD"));
        if (isClone) {
          rmSync(path, { recursive: true, force: true });
          const res = await this.git(["clone", "--mirror", "--no-tags", this.cloneUrl(repo), path], {
            timeoutMs: this.timeoutMs,
            token: opts.token,
            signal: opts.signal,
          });
          if (res.code !== 0) {
            const err = redact(`${res.stderr || res.stdout}`, opts.token);
            const timeout = /timed? ?out|killed/i.test(err);
            logger.warn("repository mirror clone failed", { repo, err });
            rmSync(path, { recursive: true, force: true });
            return { ...base, path, blocker: timeout ? "timeout" : "clone-failed", error: err };
          }
        } else {
          const res = await this.git(["remote", "update", "--prune"], {
            cwd: path,
            timeoutMs: this.timeoutMs,
            token: opts.token,
            signal: opts.signal,
          });
          if (res.code !== 0) {
            // A failed refresh must not make an existing mirror unusable: the
            // slightly stale copy is still better than 99 API calls.
            logger.warn("repository mirror refresh failed (keeping the current copy)", {
              repo,
              err: redact(res.stderr, opts.token),
            });
          }
        }
        const described = await this.describe(repo, path, opts.scope);
        if (described.sizeMb && described.sizeMb > this.maxRepoMb) {
          rmSync(path, { recursive: true, force: true });
          this.freshness.delete(key);
          return {
            ...described,
            ready: false,
            exists: false,
            blocker: "too-large",
            error: `mirror is ${described.sizeMb} MB; the cap is ${this.maxRepoMb} MB — removed`,
          };
        }
        this.freshness.set(key, { at: Date.now() });
        return {
          ...described,
          ready: described.exists,
          fetchMs: Date.now() - started,
          fetchedAt: new Date().toISOString(),
        };
      } catch (err) {
        const message = redact(String((err as Error)?.message ?? err), opts.token);
        logger.warn("repository mirror sync failed", { repo, err: message });
        return { ...base, path, blocker: /abort|timeout/i.test(message) ? "timeout" : "clone-failed", error: message };
      } finally {
        release();
      }
    })();
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Local facts about an existing mirror (no network, no fetch). */
  async describe(repo: string, path: string, scope?: string): Promise<MirrorState> {
    const state: MirrorState = {
      enabled: this.enabled,
      ready: false,
      repo,
      scope: this.scopeKey(scope),
      path,
      exists: existsSync(join(path, "HEAD")),
    };
    if (!state.exists) return state;
    const [head, headBranch, branches, size] = await Promise.all([
      this.git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: path, timeoutMs: this.readTimeoutMs }),
      this.git(["symbolic-ref", "--short", "--quiet", "HEAD"], { cwd: path, timeoutMs: this.readTimeoutMs }),
      this.git(["for-each-ref", "--format=%(refname)", "refs/heads"], { cwd: path, timeoutMs: this.readTimeoutMs }),
      this.git(["count-objects", "-v"], { cwd: path, timeoutMs: this.readTimeoutMs }),
    ]);
    if (head.code === 0) state.headSha = head.stdout.trim();
    if (headBranch.code === 0) state.defaultBranch = headBranch.stdout.trim() || undefined;
    if (branches.code === 0) state.branches = branches.stdout.split("\n").filter(Boolean).length;
    const packKb = Number(/size-pack:\s*(\d+)/.exec(size.stdout)?.[1] ?? 0);
    if (packKb) state.sizeMb = Math.max(1, Math.round(packKb / 1024));
    state.ready = !!state.headSha;
    return state;
  }

  /**
   * Local facts about a mirror **without touching the network**: what is on disk
   * for this acting account, how old the last sync is, and how long until the
   * next one. This is what `GET /projects/:id/repo-status` reports, so the UI can
   * show the mirror honestly (and a stale mirror is never a failure).
   */
  async status(
    repo: string,
    opts: { scope?: string } = {},
  ): Promise<MirrorState & { ageMs?: number; refreshInMs?: number }> {
    const scope = this.scopeKey(opts.scope);
    if (!this.enabled) return { enabled: false, ready: false, repo, scope, exists: false, blocker: "disabled" };
    const path = this.mirrorPath(repo, opts.scope);
    if (!path) return { enabled: true, ready: false, repo, scope, exists: false, blocker: "invalid-repo" };
    const described = await this.describe(repo, path, opts.scope);
    const at = this.freshness.get(path)?.at;
    const ageMs = at ? Date.now() - at : undefined;
    return {
      ...described,
      ageMs,
      refreshInMs: ageMs === undefined ? undefined : Math.max(0, this.refreshMs - ageMs),
    };
  }

  /**
   * Resolve a branch (or SHA) to something git can read; `undefined` when absent.
   * An *invalid* ref never silently degrades to HEAD — only an omitted one does.
   */
  private async resolveRef(path: string, branch: string | undefined): Promise<string | undefined> {
    const raw = String(branch ?? "").trim();
    if (!raw) return this.revParse(path, "HEAD");
    const wanted = safeRef(raw);
    if (!wanted) return undefined;
    const candidates = [`refs/heads/${wanted}`, wanted];
    for (const candidate of candidates) {
      const sha = await this.revParse(path, candidate);
      if (sha) return sha;
    }
    return undefined;
  }

  /** `git rev-parse --verify <ref>^{commit}` — empty when the ref is unknown. */
  private async revParse(path: string, ref: string): Promise<string | undefined> {
    if (ref.startsWith("-")) return undefined;
    const res = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: path,
      timeoutMs: this.readTimeoutMs,
    });
    return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : undefined;
  }

  /**
   * Ensure a mirror and return it only when it is actually usable.
   * Callers fall back to the GitHub API when this resolves `undefined`.
   */
  private async usable(
    repo: string,
    opts: MirrorReadOptions & MirrorSyncOptions,
  ): Promise<{ path: string; state: MirrorState } | undefined> {
    const state = await this.sync(repo, opts);
    if (!state.ready || !state.path) return undefined;
    return { path: state.path, state };
  }

  /** Whole-repository file listing from the local mirror. */
  async listFiles(repo: string, opts: MirrorReadOptions & MirrorSyncOptions = {}): Promise<string[] | undefined> {
    const mirror = await this.usable(repo, opts);
    if (!mirror) return undefined;
    const sha = await this.resolveRef(mirror.path, opts.branch);
    if (!sha) return undefined;
    const prefix = safePath(opts.prefix);
    const args = ["ls-tree", "-r", "--name-only", "--full-tree", sha];
    if (prefix) args.push("--", prefix);
    const res = await this.git(args, { cwd: mirror.path, timeoutMs: this.readTimeoutMs });
    if (res.code !== 0) return undefined;
    return res.stdout.split("\n").filter(Boolean).slice(0, this.maxFiles);
  }

  /** One file's content from the local mirror (bounded). */
  async readFile(
    repo: string,
    path: string,
    opts: MirrorReadOptions & MirrorSyncOptions = {},
  ): Promise<string | undefined> {
    const file = safePath(path);
    if (!file) return undefined;
    const mirror = await this.usable(repo, opts);
    if (!mirror) return undefined;
    const sha = await this.resolveRef(mirror.path, opts.branch);
    if (!sha) return undefined;
    // `-s` (size) first: a 40 MB binary must not be piped into a prompt.
    const size = await this.git(["cat-file", "-s", `${sha}:${file}`], {
      cwd: mirror.path,
      timeoutMs: this.readTimeoutMs,
    });
    if (size.code !== 0) return undefined;
    const bytes = Number(size.stdout.trim() || 0);
    if (bytes > this.maxReadBytes) return undefined;
    const res = await this.git(["cat-file", "blob", `${sha}:${file}`], {
      cwd: mirror.path,
      timeoutMs: this.readTimeoutMs,
      maxBuffer: this.maxReadBytes + 64 * 1024,
    });
    if (res.code !== 0) return undefined;
    return res.stdout;
  }

  /** HEAD SHA of a branch from the local mirror (no API call). */
  async headSha(repo: string, opts: MirrorReadOptions & MirrorSyncOptions = {}): Promise<string | undefined> {
    const mirror = await this.usable(repo, opts);
    if (!mirror) return undefined;
    return this.resolveRef(mirror.path, opts.branch);
  }

  /** Bounded `git grep` over a branch — the thing the REST API cannot do at all. */
  async search(
    repo: string,
    query: string,
    opts: MirrorReadOptions & MirrorSyncOptions & { ignoreCase?: boolean; pathGlob?: string } = {},
  ): Promise<Array<{ path: string; line: number; text: string }> | undefined> {
    const q = String(query ?? "").trim();
    if (!q || q.length > 200) return undefined;
    const mirror = await this.usable(repo, opts);
    if (!mirror) return undefined;
    const sha = await this.resolveRef(mirror.path, opts.branch);
    if (!sha) return undefined;
    const args = ["grep", "-I", "-n", "--no-color", "-F", `--max-count=${this.maxSearchHits}`];
    if (opts.ignoreCase !== false) args.push("-i");
    args.push("-e", q, sha);
    const glob = safePath(opts.pathGlob);
    if (glob) args.push("--", glob);
    const res = await this.git(args, { cwd: mirror.path, timeoutMs: this.readTimeoutMs });
    // grep exits 1 when there are no matches — that is an answer, not a failure.
    if (res.code !== 0 && res.code !== 1) return undefined;
    const out: Array<{ path: string; line: number; text: string }> = [];
    for (const raw of res.stdout.split("\n")) {
      if (!raw) continue;
      // <sha>:<path>:<line>:<text>
      const first = raw.indexOf(":");
      const second = raw.indexOf(":", first + 1);
      const third = raw.indexOf(":", second + 1);
      if (first < 0 || second < 0 || third < 0) continue;
      const path = raw.slice(first + 1, second);
      const line = Number(raw.slice(second + 1, third));
      if (!path || !Number.isFinite(line)) continue;
      out.push({ path, line, text: raw.slice(third + 1).slice(0, 300) });
      if (out.length >= this.maxSearchHits) break;
    }
    return out;
  }

  /** Drop a mirror (privacy / disk hygiene — e.g. when a project is deleted). */
  async remove(repo: string, scope?: string): Promise<boolean> {
    const path = this.mirrorPath(repo, scope);
    if (!path) return false;
    this.freshness.delete(path);
    this.inflight.delete(path);
    if (!existsSync(path)) return false;
    rmSync(path, { recursive: true, force: true });
    logger.info("repository mirror removed", { repo, scope: this.scopeKey(scope) });
    return true;
  }

  /** Forget freshness so the next read fetches again (after a commit/push). */
  invalidate(repo: string, scope?: string): void {
    const path = this.mirrorPath(repo, scope);
    if (path) this.freshness.delete(path);
  }

  /** Total size of every mirror on disk, in MB (settings/admin + disk hygiene). */
  diskUsageMb(): number {
    if (!this.enabled || !existsSync(this.root)) return 0;
    try {
      return Math.round(dirSizeKb(this.root) / 1024);
    } catch {
      return 0;
    }
  }
}

/** Singleton for the running process (the container owns it). */
let singleton: RepoMirrorService | undefined;
export function getRepoMirror(): RepoMirrorService {
  if (!singleton) singleton = new RepoMirrorService();
  return singleton;
}
export function setRepoMirrorForTest(service: RepoMirrorService | undefined): void {
  singleton = service;
}
