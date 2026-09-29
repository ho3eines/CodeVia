import type { Project } from "../domain/entities.js";
import type { MirrorState, RepoMirrorService } from "../github/repo-mirror.js";
import type { IGitHubService } from "../github/types.js";
import { logger } from "../logger.js";

/**
 * Repository evidence for conversational surfaces — and an honest answer when
 * there is none.
 *
 * Why this module exists
 * ----------------------
 * The project chat used to ask `buildRepoBrief()` for repository context and
 * swallow *every* failure into an empty string. The model then received a
 * prompt with no evidence at all and, being a model, invented a reason:
 * "I cannot see your code because the repository returns 404" — for a
 * repository that was public, reachable and 906 files large. The real cause was
 * mechanical: the listing walked the GitHub Contents API one directory at a
 * time (~99 sequential requests, ~12 s) against an 8 s chat budget, so the
 * brief always timed out on any real-size repository.
 *
 * Three fixes live here:
 *  1. **Structured result.** A brief carries `status` + `reason` + `hint`, so a
 *     prompt can state the actual cause instead of leaving a vacuum, and the UI
 *     can show an actionable banner instead of the model guessing.
 *  2. **Cache.** Repository shape does not change between two chat messages; a
 *     short TTL cache (scoped per acting account, so readability never leaks
 *     across accounts) makes the second message free.
 *  3. **Branch self-heal.** When the project's stored branch does not exist in
 *     the repository (a very common 404: `main` vs `master`), the repository's
 *     default branch is tried once and the substitution is reported.
 *
 * Advisory only: `readRepoBrief()` never throws.
 */

export type RepoBriefStatus = "ok" | "empty" | "unavailable";

export type RepoBriefErrorKind = "not-found" | "auth" | "rate-limit" | "timeout" | "too-large" | "network" | "unknown";

export interface RepoBrief {
  /** Prompt-ready evidence ("" when the repository could not be read). */
  text: string;
  status: RepoBriefStatus;
  /** `owner/name` as configured on the project. */
  repo: string;
  /** Branch the evidence was actually read from. */
  branch: string;
  /** Set when `branch` differs from the project's configured branch. */
  configuredBranch?: string;
  files: number;
  listed: number;
  directories: Array<{ path: string; files: number }>;
  readmePath?: string;
  reason?: string;
  hint?: string;
  errorKind?: RepoBriefErrorKind;
  fetchedAt: string;
  ageMs: number;
  source: "cache" | "github";
  /** Which transport produced the evidence: the local mirror or the GitHub API. */
  via: "mirror" | "api";
  /** Mirror state for the UI (present only when a mirror was attempted). */
  mirror?: {
    ready: boolean;
    headSha?: string;
    defaultBranch?: string;
    sizeMb?: number;
    fetchedAt?: string;
    /** Why the mirror could not be used (empty repository, git missing, …). */
    blocker?: string;
    error?: string;
  };
  elapsedMs: number;
}

export interface RepoBriefOptions {
  github: IGitHubService;
  project: Project;
  branch?: string;
  /** Cap on file-tree lines (default 120). */
  maxTree?: number;
  /** Cap on the README/Agent.md excerpt (default 4000 chars). */
  maxReadme?: number;
  /** Cap per manifest excerpt (default 1500 chars). */
  maxManifest?: number;
  /** Cap on the folder roll-up lines (default 40). */
  maxDirs?: number;
  /**
   * Cache isolation scope — pass the acting account id. Two accounts must never
   * share a cached readability answer for a private repository.
   */
  cacheScope?: string;
  /** Cache lifetime (default `REPO_BRIEF_TTL_MS`, 120 s). */
  ttlMs?: number;
  /** Bypass the cache (the UI's "Re-check" button). */
  refresh?: boolean;
  /** Internal budget; on expiry the brief reports `timeout` (default 8000 ms). */
  timeoutMs?: number;
  /**
   * Read-only local mirror of the repository. When enabled, evidence comes from
   * disk (`ls-tree` + `cat-file`) instead of the GitHub API, and any mirror
   * failure falls back to the API — the mirror is an optimisation, never a new
   * dependency. Nothing in the repository is ever executed.
   */
  mirror?: RepoMirrorService;
  /**
   * Bearer token for mirroring a private repository (resolved from the *acting*
   * account). Used only as a git HTTP header; never persisted, never logged.
   */
  mirrorToken?: string;
}

const README_CANDIDATES = ["README.md", "readme.md", "README", "Agent.md", "AGENTS.md"];

const CONFIG_MATCHERS: Array<{ test: (name: string) => boolean; priority: number }> = [
  { test: (n) => n === "package.json", priority: 0 },
  { test: (n) => n.endsWith(".csproj") || n.endsWith(".sln") || n.endsWith(".slnx"), priority: 1 },
  { test: (n) => n === "pyproject.toml" || n === "requirements.txt" || n === "setup.py", priority: 2 },
  { test: (n) => n === "go.mod" || n === "pom.xml" || n === "build.gradle" || n === "composer.json", priority: 3 },
  { test: (n) => n === "Cargo.toml" || n === "Gemfile", priority: 4 },
  { test: (n) => n === "tsconfig.json" || n === "appsettings.json" || n === ".editorconfig", priority: 5 },
  { test: (n) => n === "global.json" || n === "Dockerfile" || n === "docker-compose.yml", priority: 6 },
];

export function repoBriefTtlMs(): number {
  const raw = Number(process.env.REPO_BRIEF_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 120_000;
}

interface CacheEntry {
  at: number;
  brief: RepoBrief;
}
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 128;

function cacheKey(scope: string | undefined, repo: string, branch: string): string {
  return `${scope ?? "anonymous"}|${repo}@${branch}`;
}

function put(key: string, brief: RepoBrief): void {
  if (cache.size >= CACHE_MAX) {
    // Evict the oldest entry — bounded memory on a long-lived server.
    let oldest: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [k, v] of cache) {
      if (v.at < oldestAt) {
        oldest = k;
        oldestAt = v.at;
      }
    }
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), brief });
}

/** Drop cached briefs (after a commit/pull, or between tests). */
export function invalidateRepoBrief(match?: { repo?: string; branch?: string; scope?: string }): void {
  if (!match) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    const [scope, rest] = key.split("|");
    const [repo, branch] = (rest ?? "").split("@");
    if (match.scope !== undefined && scope !== match.scope) continue;
    if (match.repo !== undefined && repo.toLowerCase() !== match.repo.toLowerCase()) continue;
    if (match.branch !== undefined && branch !== match.branch) continue;
    cache.delete(key);
  }
}

/** Every cached entry (diagnostics/tests). */
export function repoBriefCacheSize(): number {
  return cache.size;
}

function classify(
  err: unknown,
  repo: string,
  branch: string,
): {
  kind: RepoBriefErrorKind;
  reason: string;
  hint: string;
} {
  const status = Number((err as { status?: number })?.status ?? 0);
  const message = String((err as Error)?.message ?? err).slice(0, 300);
  const url = `https://github.com/${repo}`;
  if (status === 404)
    return {
      kind: "not-found",
      reason: `GitHub answered 404 while reading ${repo}@${branch}.`,
      hint:
        `GitHub returns 404 both for a missing repository and for one the connected credential cannot see. ` +
        `Open ${url} in the browser as the connected account, verify the repository name and that branch "${branch}" exists, ` +
        `then sign out and back in (Settings → GitHub) so a fresh repository token is stored.`,
    };
  if (status === 401 || status === 403) {
    const rateLimited = /rate limit/i.test(message);
    return {
      kind: rateLimited ? "rate-limit" : "auth",
      reason: rateLimited
        ? `GitHub rate limit reached while reading ${repo}@${branch}.`
        : `GitHub rejected the credential (${status}) while reading ${repo}@${branch}.`,
      hint: rateLimited
        ? "Wait for the rate-limit window to reset, or connect an authenticated GitHub account (5 000 requests/h instead of 60)."
        : "Re-connect GitHub (Settings → GitHub) and make sure the login granted the 'repo' scope — a public-only token cannot read private repositories.",
    };
  }
  if (/timeout|timed out|aborted/i.test(message))
    return {
      kind: "timeout",
      reason: `GitHub did not answer in time while reading ${repo}@${branch}.`,
      hint: "Retry; if it keeps happening the repository may be very large or the network to api.github.com is blocked.",
    };
  if (/limit reached|truncated|incomplete/i.test(message))
    return {
      kind: "too-large",
      reason: `The listing of ${repo}@${branch} is too large to read completely (${message}).`,
      hint: "Ask about a specific folder or file instead of the whole repository, or split the repository.",
    };
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|socket hang up|network/i.test(message))
    return {
      kind: "network",
      reason: `api.github.com could not be reached while reading ${repo}@${branch}.`,
      hint: "Check outbound HTTPS (port 443) from the host running CodeVia.",
    };
  return {
    kind: "unknown",
    reason: `Reading ${repo}@${branch} failed: ${message}`,
    hint: "Retry; if it persists, re-connect the GitHub account.",
  };
}

/** Top-level folder roll-up so the shape of a large repo survives the file cap. */
function rollupDirectories(paths: string[], maxDirs: number): Array<{ path: string; files: number }> {
  const counts = new Map<string, number>();
  let root = 0;
  for (const p of paths) {
    const i = p.indexOf("/");
    if (i < 0) {
      root += 1;
      continue;
    }
    const dir = p.slice(0, i);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const out = [...counts.entries()]
    .map(([path, files]) => ({ path, files }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
  if (root) out.push({ path: "(root)", files: root });
  return out.slice(0, maxDirs);
}

/** Disk-backed reader used when the local mirror is ready. */
export interface MirrorAccess {
  list(branch: string): Promise<string[] | undefined>;
  read(branch: string, path: string): Promise<string | undefined>;
}

async function readOnce(
  opts: RepoBriefOptions,
  github: IGitHubService,
  repo: string,
  branch: string,
  mirror?: MirrorAccess,
): Promise<RepoBrief> {
  const maxTree = opts.maxTree ?? 120;
  const maxReadme = opts.maxReadme ?? 4000;
  const maxManifest = opts.maxManifest ?? 1500;
  const maxDirs = opts.maxDirs ?? 40;
  const started = Date.now();
  const [owner, ...rest] = repo.split("/");
  const ref = { owner, name: rest.join("/") };
  const base = (status: RepoBriefStatus): RepoBrief => ({
    text: "",
    status,
    repo,
    branch,
    configuredBranch: branch !== opts.branch && opts.branch ? opts.branch : undefined,
    files: 0,
    listed: 0,
    directories: [],
    fetchedAt: new Date(started).toISOString(),
    ageMs: 0,
    source: "github",
    via: mirror ? "mirror" : "api",
    elapsedMs: Date.now() - started,
  });

  const getFile = async (path: string): Promise<string | undefined> => {
    if (mirror) {
      const local = await mirror.read(branch, path);
      if (local !== undefined) return local;
    }
    try {
      return (await github.getFile(ref, path, branch))?.content;
    } catch {
      return undefined;
    }
  };

  let paths: string[] | undefined;
  if (mirror) paths = await mirror.list(branch);
  if (!paths) {
    try {
      paths = (await github.listFiles(ref, branch)).filter((e) => e.type === "blob").map((e) => e.path);
    } catch (err) {
      const c = classify(err, repo, branch);
      logger.warn("repository brief unavailable", { repo, branch, kind: c.kind, err: c.reason });
      return { ...base("unavailable"), via: "api", reason: c.reason, hint: c.hint, errorKind: c.kind };
    }
  }
  paths = paths.filter((p) => !p.startsWith(".git/") && !p.startsWith("CodeVia/"));
  const viaMirror = Boolean(mirror) && paths.length > 0;

  const directories = rollupDirectories(paths, maxDirs);
  const sections: string[] = [
    viaMirror
      ? `Repository: ${repo} @ ${branch} — ${paths.length} file(s) read from the local read-only mirror of the connected GitHub account.`
      : `Repository: ${repo} @ ${branch} — ${paths.length} file(s) read from the connected GitHub account.`,
  ];
  if (directories.length)
    sections.push(`Top-level folders: ${directories.map((d) => `${d.path}/ (${d.files})`).join(", ")}`);
  if (paths.length)
    sections.push(
      `Repository files (${paths.length}):`,
      ...paths.slice(0, maxTree).map((p) => `- ${p}`),
      ...(paths.length > maxTree ? [`- … +${paths.length - maxTree} more (ask for a folder to see it)`] : []),
    );

  let readmePath: string | undefined;
  for (const candidate of README_CANDIDATES) {
    const content = await getFile(candidate);
    if (content) {
      sections.push(`--- ${candidate} ---`, content.slice(0, maxReadme));
      readmePath = candidate;
      break;
    }
  }

  const manifests = paths
    .filter((p) => !README_CANDIDATES.includes(p))
    .map((p) => {
      const b = p.split("/").pop() ?? p;
      const m = CONFIG_MATCHERS.find((c) => c.test(b));
      return m ? { path: p, priority: m.priority } : undefined;
    })
    .filter((x): x is { path: string; priority: number } => !!x)
    .sort((a, b) => a.priority - b.priority || a.path.length - b.path.length)
    .slice(0, 3);
  for (const { path } of manifests) {
    const content = await getFile(path);
    if (content) sections.push(`--- ${path} ---`, content.slice(0, maxManifest));
  }

  const text = sections.join("\n");
  return {
    ...base(paths.length ? "ok" : "empty"),
    via: viaMirror ? "mirror" : "api",
    text: paths.length ? text : "",
    files: paths.length,
    listed: Math.min(paths.length, maxTree),
    directories,
    readmePath,
    ...(paths.length
      ? {}
      : {
          reason: `${repo}@${branch} is readable but contains no files.`,
          hint: "Push the project's code to this branch, or point the project at the branch that has it.",
        }),
  };
}

/**
 * Read the repository evidence for a project chat / question surface.
 * Never throws; always explains itself.
 */
export async function readRepoBrief(opts: RepoBriefOptions): Promise<RepoBrief> {
  const repo = String(opts.project?.configRepo ?? "").trim();
  const branch = (opts.branch || opts.project?.branch || "main").trim();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const started = Date.now();
  const unavailable = (reason: string, hint: string, kind: RepoBriefErrorKind): RepoBrief => ({
    text: "",
    status: "unavailable",
    repo: repo || "(none)",
    branch,
    files: 0,
    listed: 0,
    directories: [],
    reason,
    hint,
    errorKind: kind,
    fetchedAt: new Date(started).toISOString(),
    ageMs: 0,
    source: "github",
    via: "api",
    elapsedMs: Date.now() - started,
  });

  if (!repo || !repo.includes("/"))
    return unavailable(
      "This project has no connected repository.",
      "Open the project's Repositories tab and link the GitHub repository that holds the code.",
      "unknown",
    );

  const ttl = opts.ttlMs ?? repoBriefTtlMs();
  const key = cacheKey(opts.cacheScope, repo, branch);
  if (!opts.refresh && ttl > 0) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) {
      // A cached failure is still a failure — but report its real age so the UI
      // can say "checked 2 min ago" instead of implying a fresh read.
      return { ...hit.brief, source: "cache", ageMs: Date.now() - hit.at, elapsedMs: Date.now() - started };
    }
  }

  // ── Local read-only mirror ───────────────────────────────────────────────
  // One clone/fetch on disk replaces the per-message API walk; every read after
  // it is a local git *plumbing* call (ls-tree / cat-file). Nothing in the
  // repository is ever executed. Any mirror problem degrades to the API path and
  // is reported in `brief.mirror` — never as "repository unreadable".
  let mirrorState: MirrorState | undefined;
  let mirrorAccess: MirrorAccess | undefined;
  const prepareMirror = async (): Promise<MirrorAccess | undefined> => {
    const mirror = opts.mirror;
    if (!mirror?.isEnabled) return undefined;
    try {
      mirrorState = await mirror.sync(repo, {
        scope: opts.cacheScope,
        token: opts.mirrorToken,
        force: opts.refresh === true,
      });
    } catch (err) {
      mirrorState = undefined;
      logger.warn("repository mirror sync failed", { repo, err: String(err instanceof Error ? err.message : err) });
      return undefined;
    }
    if (!mirrorState.ready) return undefined;
    return {
      list: (b) => mirror.listFiles(repo, { scope: opts.cacheScope, branch: b }),
      read: (b, path) => mirror.readFile(repo, path, { scope: opts.cacheScope, branch: b }),
    };
  };

  let brief: RepoBrief;
  try {
    brief = await Promise.race([
      (async () => {
        mirrorAccess = await prepareMirror();
        return readOnce(opts, opts.github, repo, branch, mirrorAccess);
      })(),
      new Promise<RepoBrief>((resolve) =>
        setTimeout(
          () =>
            resolve(
              unavailable(
                `Reading ${repo}@${branch} took longer than ${Math.round(timeoutMs / 1000)} s and was aborted.`,
                opts.mirror?.isEnabled
                  ? "Retry — if this repository is large the first local mirror clone may still be running; it finishes in the background and the next message reads from disk."
                  : "Retry — the repository context is cached afterwards, so the next message is fast.",
                "timeout",
              ),
            ),
          timeoutMs,
        ).unref?.(),
      ),
    ]);
  } catch (err) {
    const c = classify(err, repo, branch);
    brief = unavailable(c.reason, c.hint, c.kind);
  }

  // Branch self-heal: a 404 on the configured branch is very often "the project
  // stores `main` but the repository's default branch is `master`". Try the
  // default branch once and say so explicitly.
  if (brief.status === "unavailable" && brief.errorKind === "not-found") {
    try {
      const [owner, ...rest] = repo.split("/");
      const meta = await opts.github.getRepository?.({ owner, name: rest.join("/") });
      const branches = meta ? [] : await opts.github.listBranches({ owner, name: rest.join("/") });
      const fallback =
        meta?.defaultBranch ||
        branches.find((b) => b.name === "main")?.name ||
        branches.find((b) => b.name === "master")?.name;
      if (fallback && fallback !== branch) {
        const retried = await readOnce({ ...opts, branch: fallback }, opts.github, repo, fallback, mirrorAccess);
        if (retried.status === "ok") {
          brief = {
            ...retried,
            configuredBranch: branch,
            reason: `Branch "${branch}" does not exist in ${repo}; read from the repository's default branch "${fallback}" instead.`,
            hint: `Update the project's branch to "${fallback}" (Project → Settings) so agents commit to the right place.`,
          };
        }
      }
    } catch {
      /* keep the original diagnosis */
    }
  }

  if (mirrorState)
    brief = {
      ...brief,
      mirror: {
        ready: mirrorState.ready,
        headSha: mirrorState.headSha,
        defaultBranch: mirrorState.defaultBranch,
        sizeMb: mirrorState.sizeMb,
        fetchedAt: mirrorState.fetchedAt,
        blocker: mirrorState.blocker,
        error: mirrorState.error,
      },
    };

  if (ttl > 0) put(key, brief);
  return { ...brief, ageMs: 0, elapsedMs: Date.now() - started };
}

/** Build an "unavailable" brief for a failure that happened before the read. */
export function unavailableRepoBrief(
  repo: string,
  branch: string,
  reason: string,
  hint: string,
  kind: RepoBriefErrorKind = "unknown",
): RepoBrief {
  const now = Date.now();
  return {
    text: "",
    status: "unavailable",
    repo: repo || "(none)",
    branch,
    files: 0,
    listed: 0,
    directories: [],
    reason,
    hint,
    errorKind: kind,
    fetchedAt: new Date(now).toISOString(),
    ageMs: 0,
    source: "github",
    via: "api",
    elapsedMs: 0,
  };
}

/**
 * The API/UI projection of a brief: everything needed to show a banner and to
 * answer "why can't the AI see my repository?", without the prompt text itself.
 */
export function repoContextFor(brief: RepoBrief | undefined): Record<string, unknown> | undefined {
  if (!brief) return undefined;
  return {
    status: brief.status,
    repo: brief.repo,
    branch: brief.branch,
    configuredBranch: brief.configuredBranch,
    files: brief.files,
    listed: brief.listed,
    readmePath: brief.readmePath,
    directories: brief.directories.slice(0, 12),
    reason: brief.reason,
    hint: brief.hint,
    errorKind: brief.errorKind,
    fetchedAt: brief.fetchedAt,
    ageMs: brief.ageMs,
    source: brief.source,
    via: brief.via,
    mirror: brief.mirror
      ? {
          ready: brief.mirror.ready,
          headSha: brief.mirror.headSha,
          sizeMb: brief.mirror.sizeMb,
          fetchedAt: brief.mirror.fetchedAt,
          blocker: brief.mirror.blocker,
          error: brief.mirror.error,
        }
      : undefined,
    elapsedMs: brief.elapsedMs,
  };
}

/**
 * The prompt block for a project chat message.
 *
 * With evidence: the real listing (and an instruction to use it).
 * Without evidence: the *actual* reason plus an explicit ban on inventing one —
 * this is what stops "your repository returns 404, so I'll analyse the README
 * you cannot see" answers.
 */
export function repoContextPrompt(brief: RepoBrief): string {
  if (brief.status === "empty") {
    return (
      `\n\nRepository context: the repository ${brief.repo} IS readable on branch "${brief.branch}", but it contains no files.` +
      `\nDo not describe any code, structure or README — there is nothing there yet. Say the repository is empty and suggest pushing the code or fixing the project's branch.`
    );
  }
  if (brief.status === "ok" && brief.text) {
    const note = brief.configuredBranch
      ? `\nNote: the project is configured for branch "${brief.configuredBranch}" but the evidence below was read from "${brief.branch}" (${brief.reason ?? "branch fallback"}).`
      : "";
    return (
      `\n\nRepository context (read this before answering questions about the codebase; never claim a file is missing without checking this list):\n${brief.text}` +
      note
    );
  }
  return (
    `\n\nRepository context: UNAVAILABLE for this message (repository ${brief.repo}, branch ${brief.branch}).` +
    `\nReason reported by the platform: ${brief.reason ?? "unknown"}` +
    `\nHard rules for this answer:` +
    `\n- Never claim the repository does not exist, is empty, or "returns 404/403" — you did not perform that check; the reason above is the only fact you have.` +
    `\n- Never describe, list or review files you cannot see, and never present invented structure as the project's.` +
    `\n- Say plainly that the platform could not read the repository for this message, quote the reason, and give this fix: ${brief.hint ?? "re-check the project's GitHub connection"}` +
    `\n- Then answer from the project name/description only, and label every assumption as an assumption.`
  );
}
