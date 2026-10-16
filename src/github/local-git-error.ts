/**
 * Error contract for LocalGitService.
 *
 * Every failure raised by the local Git adapter is a `LocalGitError` carrying:
 *   - `code`        — machine-readable failure class (stable API),
 *   - `statusCode` / `status` — the HTTP status the platform routes map it to
 *     (`errStatus` reads `statusCode`, `repo-brief`/`project-state` read
 *     `status`; both are always identical),
 *   - `retryable`   — transient failures the worker may retry (lock contention,
 *     git binary hiccups); permanent ones dead-letter immediately,
 *   - `committed`   — `true` only when a ref already moved and the commit
 *     exists, but a later step (working-tree sync, push) failed. Retrying the
 *     same operation with the old `parentSha` then yields LOCAL_STALE_PARENT
 *     instead of silently double-committing,
 *   - `provider`    — always `"local-git"`, so messages can stop mentioning
 *     GitHub when the local adapter is active.
 *
 * Behavioural rules (enforced by tests in src/tests/local-git-error.test.ts):
 *   1. Absence is `undefined`, never an error: getFile / getRepository /
 *      getPullRequest return `undefined` for anything missing.
 *   2. LOCAL_META_CORRUPT is never muted or overwritten (the metadata file is
 *      backed up as `.bak` before every rewrite instead).
 *   3. A failed push after a successful commit is a warning, not an error.
 */

export type LocalGitErrorCode =
  | "LOCAL_GIT_UNAVAILABLE" // git binary missing or not runnable (ENOENT/EACCES)
  | "LOCAL_REPO_NOT_FOUND" // no repository directory for owner/name
  | "LOCAL_REF_NOT_FOUND" // branch, tag, or commit does not exist
  | "LOCAL_PATH_NOT_FOUND" // directory prefix does not exist in the commit
  | "LOCAL_INVALID_INPUT" // unsafe repo name, branch name, or path
  | "LOCAL_STALE_PARENT" // CAS: parentSha no longer equals the branch head
  | "LOCAL_LOCKED" // ref or index lock held by another process
  | "LOCAL_MERGE_CONFLICT" // merge cannot be applied cleanly
  | "LOCAL_HEAD_MOVED" // expectedSha no longer matches the PR head
  | "LOCAL_META_CORRUPT" // codevia-local-meta.json cannot be parsed
  | "LOCAL_GIT_FAILED"; // any other git exit code, stderr attached

const STATUS: Record<LocalGitErrorCode, number> = {
  LOCAL_GIT_UNAVAILABLE: 503,
  LOCAL_REPO_NOT_FOUND: 404,
  LOCAL_REF_NOT_FOUND: 404,
  LOCAL_PATH_NOT_FOUND: 404,
  LOCAL_INVALID_INPUT: 400,
  LOCAL_STALE_PARENT: 409,
  LOCAL_LOCKED: 423,
  LOCAL_MERGE_CONFLICT: 409,
  LOCAL_HEAD_MOVED: 409,
  LOCAL_META_CORRUPT: 500,
  LOCAL_GIT_FAILED: 502,
};

/** Transient failures: safe to retry after a short delay. */
const RETRYABLE = new Set<LocalGitErrorCode>([
  "LOCAL_GIT_UNAVAILABLE",
  "LOCAL_LOCKED",
  "LOCAL_GIT_FAILED",
]);

export interface LocalGitErrorOptions {
  cause?: unknown;
  /** Set when the ref already moved — see the header comment. */
  committed?: boolean;
  /** The commit SHA that was created (only meaningful with `committed`). */
  sha?: string;
}

export class LocalGitError extends Error {
  readonly code: LocalGitErrorCode;
  readonly statusCode: number;
  readonly status: number;
  readonly retryable: boolean;
  readonly committed: boolean;
  readonly sha?: string;
  readonly provider = "local-git" as const;

  constructor(code: LocalGitErrorCode, message: string, opts: LocalGitErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LocalGitError";
    this.code = code;
    this.statusCode = STATUS[code];
    this.status = this.statusCode;
    this.retryable = RETRYABLE.has(code);
    this.committed = opts.committed === true;
    this.sha = opts.sha;
  }
}

export function isLocalGitError(err: unknown): err is LocalGitError {
  return err instanceof LocalGitError;
}

/** Trim stderr for inclusion in error messages (no trailing noise, capped). */
export function trimGitStderr(stderr: string, max = 300): string {
  return String(stderr ?? "")
    .replace(/\s+$/g, "")
    .slice(0, max);
}

/**
 * Map a raw git failure (stderr + exit code) onto the contract. Only patterns
 * that unambiguously identify a class are special-cased; everything else is
 * LOCAL_GIT_FAILED with the (trimmed) stderr attached.
 */
export function classifyGitFailure(stderr: string, fallbackMessage: string): LocalGitError {
  const text = trimGitStderr(stderr);
  // Compare-and-swap mismatch: "cannot lock ref 'refs/heads/x': is at <sha> but expected <sha>"
  if (/is at [0-9a-f]+ but expected [0-9a-f]+/i.test(text)) {
    return new LocalGitError(
      "LOCAL_STALE_PARENT",
      "Repository changed after inspection; refusing to overwrite newer work (the branch moved concurrently).",
    );
  }
  if (/lock/i.test(text) && (/\.lock/i.test(text) || /File exists/i.test(text))) {
    return new LocalGitError(
      "LOCAL_LOCKED",
      "A git lock file is held by another process (IDE or git command). Close it, or — if no git process is running — remove the stale .lock file mentioned in the git output and retry.",
    );
  }
  if (/cannot lock ref/i.test(text)) {
    return new LocalGitError(
      "LOCAL_LOCKED",
      "The branch reference is locked by another process. Retry after the other git process finishes.",
    );
  }
  return new LocalGitError("LOCAL_GIT_FAILED", `${fallbackMessage}: ${text || "git exited with an error"}`);
}
