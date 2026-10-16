/**
 * Stable error contract for server-filesystem access.
 *
 * Mirrors `LocalGitError`: routes map `statusCode` straight to HTTP, callers
 * branch on `code`, and `retryable` tells the worker/queue layer whether a
 * repeat attempt can succeed. Error messages echo the *requested* path but
 * never include file contents.
 */

export type FilesystemErrorCode =
  /** Path is empty, not a string, or contains NUL/control characters. */
  | "FS_INVALID_PATH"
  /** Resolved (post-symlink) path is outside every allowed root. */
  | "FS_PATH_OUTSIDE_ROOTS"
  | "FS_NOT_FOUND"
  | "FS_NOT_A_DIRECTORY"
  | "FS_NOT_A_FILE"
  | "FS_PERMISSION_DENIED"
  | "FS_FILE_TOO_LARGE"
  | "FS_TOO_MANY_ENTRIES"
  | "FS_DEPTH_EXCEEDED"
  /** The path matches the sensitive-file policy (.env, keys, credentials…). */
  | "FS_SENSITIVE_BLOCKED"
  /** A scan budget (file count) was exceeded. */
  | "FS_LIMIT_EXCEEDED";

export interface FilesystemErrorInit {
  code: FilesystemErrorCode;
  message: string;
  /** HTTP status (default 400). */
  statusCode?: number;
  /** Machine-readable outcome — "denied" for authorization-style failures. */
  status?: "error" | "denied";
  /** Whether repeating the same call can succeed later (default false). */
  retryable?: boolean;
  /** Extra structured context (sizes, limits — never file contents). */
  detail?: Record<string, unknown>;
}

const DEFAULT_STATUS: Partial<Record<FilesystemErrorCode, number>> = {
  FS_PATH_OUTSIDE_ROOTS: 403,
  FS_NOT_FOUND: 404,
  FS_PERMISSION_DENIED: 403,
  FS_FILE_TOO_LARGE: 413,
  FS_TOO_MANY_ENTRIES: 413,
  FS_SENSITIVE_BLOCKED: 403,
};

export class FilesystemError extends Error {
  readonly code: FilesystemErrorCode;
  readonly statusCode: number;
  readonly status: "error" | "denied";
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  constructor(init: FilesystemErrorInit) {
    super(init.message);
    this.name = "FilesystemError";
    this.code = init.code;
    this.statusCode = init.statusCode ?? DEFAULT_STATUS[init.code] ?? 400;
    this.status =
      init.status ??
      (init.code === "FS_PATH_OUTSIDE_ROOTS" || init.code === "FS_SENSITIVE_BLOCKED" ? "denied" : "error");
    this.retryable = init.retryable ?? init.code === "FS_PERMISSION_DENIED";
    this.detail = init.detail ?? {};
  }

  toJSON(): { error: string; code: FilesystemErrorCode; status: string; detail: Record<string, unknown> } {
    return {
      error: this.message,
      code: this.code,
      status: this.status,
      detail: this.detail,
    };
  }
}

export function isFilesystemError(x: unknown): x is FilesystemError {
  return x instanceof FilesystemError;
}

/** Translate node fs errors into the contract; anything else is wrapped as a generic 500. */
export function filesystemErrorFromNode(err: unknown, path: string): FilesystemError {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === "ENOENT") {
    return new FilesystemError({ code: "FS_NOT_FOUND", message: `Path not found: ${path}`, detail: { path } });
  }
  if (code === "ENOTDIR") {
    return new FilesystemError({ code: "FS_NOT_A_DIRECTORY", message: `Not a directory: ${path}`, detail: { path } });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new FilesystemError({
      code: "FS_PERMISSION_DENIED",
      message: `Permission denied: ${path}`,
      retryable: true,
      detail: { path },
    });
  }
  if (code === "EMFILE" || code === "ENFILE") {
    return new FilesystemError({
      code: "FS_PERMISSION_DENIED",
      message: `Too many open files — retry later: ${path}`,
      retryable: true,
      detail: { path },
    });
  }
  return new FilesystemError({
    code: "FS_INVALID_PATH",
    message: `Filesystem operation failed: ${path}`,
    retryable: true,
    detail: { path, reason: err instanceof Error ? err.message : String(err) },
  });
}
