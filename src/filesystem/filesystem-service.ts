/**
 * FilesystemService — safe, bounded server-filesystem access.
 *
 * Backs the local-folder project feature (`POST /projects/scan`,
 * `POST /projects/from-local`, `GET /fs/list`, `GET /fs/stat`). Every path is
 * validated against the configured allowed roots *after* symlink resolution,
 * reads are size-limited, directory listings are entry-limited, and files that
 * look like secrets (.env, private keys, credentials…) are never opened —
 * only their metadata is ever returned.
 *
 * Configuration (env, overridable per instance for tests):
 *   - CODEVIA_ALLOWED_ROOTS     comma/semicolon separated allowed directories.
 *                               Default: the CodeVia install directory only.
 *   - CODEVIA_FS_MAX_FILE_KB    max single-file read size (default 1024 KB).
 *   - CODEVIA_FS_MAX_ENTRIES    max directory entries per listing (default 5000).
 *   - CODEVIA_FS_MAX_DEPTH      max symlink-safe resolution depth (default 32).
 */

import { promises as fsp, constants as fsc } from "node:fs";
import * as path from "node:path";
import { FilesystemError, filesystemErrorFromNode } from "./filesystem-error.js";

export interface FilesystemServiceOptions {
  /** Absolute directories the service may touch. Default: env or `[process.cwd()]`. */
  allowedRoots?: string[];
  /** Max bytes returned by a single `readFile` (default 1 MiB). */
  maxFileSizeBytes?: number;
  /** Max entries returned by `listDirectory` (default 5000). */
  maxEntries?: number;
  /** Max symlink-resolution depth (default 32). */
  maxDepth?: number;
  /** Max concurrent filesystem operations (default 8). */
  maxConcurrent?: number;
}

export type FileKind = "file" | "directory" | "symlink" | "other";

export interface FileStat {
  /** Normalized absolute path. */
  path: string;
  name: string;
  kind: FileKind;
  /** Size in bytes (files only; 0 otherwise). */
  size: number;
  createdAt?: string;
  modifiedAt?: string;
  /** Octal mode, e.g. "0644". */
  mode: string;
  /** Whether the process can read it. */
  readable: boolean;
  /** Matches the sensitive-file policy — metadata only, never opened. */
  sensitive: boolean;
}

export interface DirectoryEntry {
  name: string;
  kind: FileKind;
  /** Present for plain files. */
  size?: number;
  modifiedAt?: string;
  hidden: boolean;
  sensitive: boolean;
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
  /** True when `maxEntries` cut the listing short. */
  truncated: boolean;
  /** Total entries in the directory (before truncation). */
  total: number;
}

export interface FileContent {
  path: string;
  size: number;
  content: string;
}

export interface RootListing {
  roots: DirectoryEntry[];
}

/**
 * File names (any directory level) whose *contents* must never leave this
 * service. Metadata (name/size/mtime) is still exposed so the UI can show a
 * locked badge instead of pretending the file does not exist.
 */
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^\.env$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /\.(crt|cer)$/i, // certificates themselves are not secrets but never needed either
  /^\.(npmrc|netrc|git-credentials|gitconfig)$/i,
  /^credentials(\..*)?$/i,
  /^secrets?(\..*)?$/i,
  /^.*\.token$/i,
  /^.*\.secret$/i,
  /^service[-_]?account.*\.json$/i,
  /^\.htpasswd$/i,
  /^\.htaccess$/i,
  /^authorized_keys$/i,
  /^known_hosts$/i,
  /^\.git-(credentials|pass)$/i,
  /^shadow$/i,
  /^\.aws$/i,
  /^\.ssh$/i,
  /^\.gnupg$/i,
  /^\.docker$/i,
  /^\.kube$/i,
];

/** True when a *file name* (single segment) matches the sensitive policy. */
export function isSensitiveFileName(name: string): boolean {
  const n = name.toLowerCase();
  return SENSITIVE_FILE_PATTERNS.some((re) => re.test(n));
}

/** True when any segment of a relative/absolute path matches the policy. */
export function isSensitivePath(p: string): boolean {
  const segments = p.split(/[\\/]+/).filter(Boolean);
  return segments.some(isSensitiveFileName);
}

function envList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return undefined;
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Windows (NTFS) and macOS (default APFS/HFS+) filesystems are case-insensitive:
 * "d:/Hermes" and "D:/HERMES" are the same directory, so containment checks
 * must compare case-insensitively there or legitimate paths get rejected.
 */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/** True when `child` is `root` itself or located underneath it. */
function pathContains(root: string, child: string): boolean {
  const norm = (x: string): string => (CASE_INSENSITIVE_FS ? x.toLowerCase() : x);
  const r = norm(root);
  const c = norm(child);
  if (c === r) return true;
  const sep = norm(path.sep);
  // A root that already ends with the separator (e.g. "/" or "D:\") must not
  // require a second one, or nothing would ever be "under" the filesystem root.
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}

/** Tiny counting semaphore to bound concurrent fs work. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit) || 1);
  }
  private readonly limit: number;
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

export class FilesystemService {
  private readonly allowedRootsInput: string[];
  private readonly maxFileSizeBytes: number;
  private readonly maxEntries: number;
  private readonly maxDepth: number;
  private readonly sema: Semaphore;
  /** realpath'd roots cache (roots that exist). */
  private rootCache: string[] | undefined;
  private realRootsCache: string[] | undefined;

  constructor(options: FilesystemServiceOptions = {}) {
    const roots = options.allowedRoots ?? envList("CODEVIA_ALLOWED_ROOTS") ?? [process.cwd()];
    // An explicitly empty list is treated as "not configured" → install dir only.
    this.allowedRootsInput = roots.length > 0 ? roots : [process.cwd()];
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? envInt("CODEVIA_FS_MAX_FILE_KB", 1024) * 1024;
    this.maxEntries = options.maxEntries ?? envInt("CODEVIA_FS_MAX_ENTRIES", 5000);
    this.maxDepth = options.maxDepth ?? envInt("CODEVIA_FS_MAX_DEPTH", 32);
    this.sema = new Semaphore(options.maxConcurrent ?? 8);
  }

  /** Resolved allowed roots (for route exposure / tests). */
  listRoots(): string[] {
    return [...this.resolvedRoots()];
  }

  /**
   * Validate a caller-supplied path and return the normalized absolute path.
   * Throws `FS_INVALID_PATH` / `FS_PATH_OUTSIDE_ROOTS`.
   */
  assertSafePath(inputPath: string): string {
    if (typeof inputPath !== "string" || !inputPath.trim()) {
      throw new FilesystemError({ code: "FS_INVALID_PATH", message: "A non-empty path is required" });
    }
    if (inputPath.includes("\0")) {
      throw new FilesystemError({ code: "FS_INVALID_PATH", message: "Path contains NUL bytes" });
    }
    if (/[\x01-\x08\x0e-\x1f\x7f]/.test(inputPath)) {
      throw new FilesystemError({ code: "FS_INVALID_PATH", message: "Path contains control characters" });
    }
    const resolved = path.resolve(inputPath);
    if (!this.isUnderRoots(resolved)) {
      throw new FilesystemError({
        code: "FS_PATH_OUTSIDE_ROOTS",
        message: `Path is outside the allowed roots: ${inputPath}`,
        detail: { requested: inputPath },
      });
    }
    return resolved;
  }

  /** Validate + resolve, following symlinks so a link inside a root cannot escape it. */
  private async assertSafePathReal(inputPath: string): Promise<string> {
    const resolved = this.assertSafePath(inputPath);
    const real = await this.realpathWithinDepth(resolved);
    if (!(await this.isUnderRealRoots(real))) {
      throw new FilesystemError({
        code: "FS_PATH_OUTSIDE_ROOTS",
        message: `Path resolves outside the allowed roots (symlink escape): ${inputPath}`,
        detail: { requested: inputPath },
      });
    }
    return resolved;
  }

  async exists(targetPath: string): Promise<boolean> {
    const p = await this.safePath(targetPath);
    try {
      await fsp.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  async isDirectory(targetPath: string): Promise<boolean> {
    const p = await this.safePath(targetPath);
    try {
      return (await fsp.stat(p)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Typed metadata for a path. Never reads contents; sensitive files are described, not blocked. */
  async statPath(targetPath: string): Promise<FileStat> {
    const p = await this.safePath(targetPath);
    try {
      const [st, lst] = await Promise.all([fsp.stat(p), fsp.lstat(p)]);
      const kind: FileKind = lst.isSymbolicLink()
        ? "symlink"
        : st.isDirectory()
          ? "directory"
          : st.isFile()
            ? "file"
            : "other";
      let readable = false;
      try {
        await fsp.access(p, fsc.R_OK);
        readable = true;
      } catch {
        readable = false;
      }
      return {
        path: p,
        name: path.basename(p),
        kind,
        size: st.isFile() ? st.size : 0,
        createdAt: st.birthtime?.toISOString?.(),
        modifiedAt: st.mtime?.toISOString?.(),
        mode: (st.mode & 0o777).toString(8).padStart(3, "0"),
        readable,
        sensitive: isSensitivePath(p),
      };
    } catch (err) {
      throw filesystemErrorFromNode(err, p);
    }
  }

  /** List a directory (bounded, sorted: directories first). */
  async listDirectory(dirPath: string, options: { limit?: number } = {}): Promise<DirectoryListing> {
    const p = await this.safePath(dirPath);
    let dirents;
    try {
      dirents = await this.sema.run(() => fsp.readdir(p, { withFileTypes: true }));
    } catch (err) {
      throw filesystemErrorFromNode(err, p);
    }
    const total = dirents.length;
    const limit = Math.max(1, Math.min(options.limit ?? this.maxEntries, this.maxEntries));
    const statTargets = dirents.slice(0, limit);
    const entries: DirectoryEntry[] = await Promise.all(
      statTargets.map(async (d): Promise<DirectoryEntry> => {
        let size: number | undefined;
        let modifiedAt: string | undefined;
        // Metadata only — never content. Unreadable/lstat failures degrade to name+kind.
        try {
          const st = await fsp.stat(path.join(p, d.name));
          if (st.isFile()) size = st.size;
          modifiedAt = st.mtime?.toISOString?.();
        } catch {
          /* broken symlink / permission — still list the name */
        }
        return {
          name: d.name,
          kind: d.isSymbolicLink() ? "symlink" : d.isDirectory() ? "directory" : d.isFile() ? "file" : "other",
          size,
          modifiedAt,
          hidden: d.name.startsWith("."),
          sensitive: isSensitiveFileName(d.name),
        };
      }),
    );
    entries.sort((a, b) => {
      const dirWeight = (x: DirectoryEntry) => (x.kind === "directory" ? 0 : 1);
      const w = dirWeight(a) - dirWeight(b);
      return w !== 0 ? w : a.name.localeCompare(b.name);
    });
    return { path: p, entries, truncated: total > limit, total };
  }

  /**
   * Read a UTF-8 text file (size-limited). Sensitive files are refused —
   * the caller gets `FS_SENSITIVE_BLOCKED` and no content.
   */
  async readFile(filePath: string, options: { maxBytes?: number } = {}): Promise<FileContent> {
    const p = await this.safePath(filePath);
    if (isSensitivePath(p)) {
      throw new FilesystemError({
        code: "FS_SENSITIVE_BLOCKED",
        message: `Refusing to read a sensitive file: ${path.basename(p)}`,
        detail: { path: p, hint: "metadata only" },
      });
    }
    let st;
    try {
      st = await fsp.stat(p);
    } catch (err) {
      throw filesystemErrorFromNode(err, p);
    }
    if (!st.isFile()) {
      throw new FilesystemError({
        code: "FS_NOT_A_FILE",
        message: `Not a file: ${path.basename(p)}`,
        detail: { path: p },
      });
    }
    const maxBytes = options.maxBytes ?? this.maxFileSizeBytes;
    if (st.size > maxBytes) {
      throw new FilesystemError({
        code: "FS_FILE_TOO_LARGE",
        message: `File exceeds the read limit (${st.size} > ${maxBytes} bytes): ${path.basename(p)}`,
        detail: { path: p, size: st.size, limit: maxBytes },
      });
    }
    try {
      const content = await this.sema.run(() => fsp.readFile(p, "utf8"));
      return { path: p, size: st.size, content };
    } catch (err) {
      throw filesystemErrorFromNode(err, p);
    }
  }

  /** assertSafePath + symlink-aware containment, shared by every public method. */
  private safePath(inputPath: string): Promise<string> {
    return this.assertSafePathReal(inputPath);
  }

  private isUnderRoots(resolved: string): boolean {
    for (const root of this.resolvedRoots()) {
      if (pathContains(root, resolved)) return true;
    }
    return false;
  }

  /** Containment against *realpath'd* roots, so roots that are themselves symlinks work. */
  private async isUnderRealRoots(realPath: string): Promise<boolean> {
    if (this.isUnderRoots(realPath)) return true;
    for (const root of await this.realRoots()) {
      if (pathContains(root, realPath)) return true;
    }
    return false;
  }

  /** realpath'd roots (roots that do not exist stay lexically resolved). */
  private async realRoots(): Promise<string[]> {
    if (!this.realRootsCache) {
      this.realRootsCache = await Promise.all(
        this.resolvedRoots().map(async (root) => {
          try {
            return await fsp.realpath(root);
          } catch {
            return root;
          }
        }),
      );
    }
    return this.realRootsCache;
  }

  private resolvedRoots(): string[] {
    if (!this.rootCache) {
      this.rootCache = this.allowedRootsInput.map((r) => path.resolve(r));
    }
    return this.rootCache;
  }

  /**
   * realpath of the deepest *existing* ancestor, bounded by maxDepth. The
   * non-existing tail cannot be a symlink, so the result is escape-proof even
   * for paths that do not exist yet.
   */
  private async realpathWithinDepth(resolved: string): Promise<string> {
    let current = resolved;
    const tail: string[] = [];
    for (let depth = 0; depth < this.maxDepth; depth++) {
      try {
        const real = await fsp.realpath(current);
        return tail.length ? path.join(real, ...tail) : real;
      } catch (err) {
        if ((err as { code?: string }).code !== "ENOENT") {
          // Exists but realpath failed (e.g. permission on a parent).
          throw filesystemErrorFromNode(err, current);
        }
        const parent = path.dirname(current);
        if (parent === current) return resolved; // reached FS root
        tail.unshift(path.basename(current));
        current = parent;
      }
    }
    throw new FilesystemError({
      code: "FS_DEPTH_EXCEEDED",
      message: `Path exceeds the maximum resolution depth (${this.maxDepth})`,
      detail: { path: resolved },
    });
  }
}
