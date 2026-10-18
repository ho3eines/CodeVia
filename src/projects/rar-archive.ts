import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getEnv } from "../config/env.js";
import {
  safeProjectArchivePath,
  projectArchiveLimitsFromEnv,
  type ProjectArchiveFile,
  type ProjectArchiveLimits,
} from "./project-archive.js";

export interface RarProcessOutput {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type RarProcessRunner = (
  binary: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
) => Promise<RarProcessOutput>;

export interface RarArchiveOptions {
  binaryCandidates?: string[];
  limits?: ProjectArchiveLimits;
  run?: RarProcessRunner;
}

const importError = (message: string, statusCode = 400): Error => Object.assign(new Error(message), { statusCode });

const defaultRun: RarProcessRunner = (binary, args, timeoutMs, maxOutputBytes) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let killedForLimit = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > maxOutputBytes) {
        killedForLimit = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(value);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        rejectPromise(
          importError(`RAR support requires 7z/7zz (configured: ${binary}); install it on the server`, 503),
        );
      else rejectPromise(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) return rejectPromise(importError("RAR utility timed out while reading the archive", 400));
      if (killedForLimit) return rejectPromise(importError("RAR utility output exceeded the configured limit", 400));
      resolvePromise({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });

function parseListing(text: string, limits: ProjectArchiveLimits): Array<{ path: string; size: number }> {
  const records: Array<Record<string, string>> = [];
  let current: Record<string, string> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line === "----------") {
      if (current && Object.keys(current).length) records.push(current);
      current = undefined;
      continue;
    }
    const pos = line.indexOf(" = ");
    if (pos < 0) continue;
    const key = line.slice(0, pos);
    const value = line.slice(pos + 3);
    if (key === "Path") {
      if (current && Object.keys(current).length) records.push(current);
      current = { Path: value };
    } else if (current) current[key] = value;
  }
  if (current && Object.keys(current).length) records.push(current);
  // First record describes the archive itself, not an entry.
  if (records.length && (records[0].Type || records[0]["Physical Size"])) records.shift();
  if (records.length > limits.maxFiles) throw importError(`RAR contains too many entries (maximum ${limits.maxFiles})`);
  const files: Array<{ path: string; size: number }> = [];
  const unique = new Set<string>();
  let total = 0;
  for (const record of records) {
    const raw = record.Path;
    if (!raw) throw importError("RAR listing contains an entry with no name");
    const path = safeProjectArchivePath(raw);
    const attributes = record.Attributes ?? "";
    if (record["Symbolic Link"] || record["Hard Link"] || /\bl(?:rwx|w|s|-)\w*/i.test(attributes))
      throw importError(`RAR symbolic or hard link is not allowed: ${path}`);
    const directory = record.Folder === "+" || /\bd\w{0,2}[rwx-]{0,9}/i.test(attributes);
    if (directory) continue;
    const size = Number(record.Size);
    const packed = Number(record["Packed Size"] ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes)
      throw importError(`RAR file exceeds the ${limits.maxFileBytes} byte per-file limit: ${path}`);
    if (Number.isFinite(packed) && packed > 0 && size / packed > limits.maxCompressionRatio)
      throw importError(`RAR compression ratio exceeds ${limits.maxCompressionRatio}:1: ${path}`);
    total += size;
    if (total > limits.maxTotalBytes) throw importError(`RAR expands beyond ${limits.maxTotalBytes} bytes`);
    const folded = path.toLocaleLowerCase("en-US");
    if (unique.has(folded)) throw importError(`Duplicate or case-colliding RAR path: ${path}`);
    unique.add(folded);
    files.push({ path, size });
  }
  if (!files.length) throw importError("RAR archive has no regular files");
  return files;
}

function tailText(buffer: Buffer): string {
  return buffer.toString("utf8").slice(-4000);
}

/** List and stream each RAR file through 7z stdout; never extract archive paths directly onto the host. */
export async function extractProjectRar(buffer: Buffer, opts: RarArchiveOptions = {}): Promise<ProjectArchiveFile[]> {
  const limits = opts.limits ?? projectArchiveLimitsFromEnv();
  if (buffer.length > limits.maxUploadBytes)
    throw importError(`Compressed archive exceeds ${limits.maxUploadBytes} bytes`);
  const configuredBinary = getEnv().PROJECT_IMPORT_7Z_BIN;
  const candidates = opts.binaryCandidates ?? (configuredBinary ? [configuredBinary] : ["7z", "7zz"]);
  const run = opts.run ?? defaultRun;
  const temp = await mkdtemp(join(tmpdir(), "codevia-rar-"));
  const archivePath = join(temp, `upload-${randomUUID()}.rar`);
  try {
    await writeFile(archivePath, buffer, { mode: 0o600, flag: "wx" });
    let selected: string | undefined;
    let listing: RarProcessOutput | undefined;
    let missingMessage: unknown;
    for (const candidate of candidates) {
      try {
        const result = await run(candidate, ["l", "-slt", "-bd", "-bb0", archivePath], 30_000, 8 * 1024 * 1024);
        if (result.code !== 0)
          throw importError(`7z could not list the RAR archive: ${tailText(result.stderr) || tailText(result.stdout)}`);
        selected = candidate;
        listing = result;
        break;
      } catch (error) {
        if (
          (error as Error & { statusCode?: number }).statusCode === 503 ||
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          missingMessage = error;
          continue;
        }
        throw error;
      }
    }
    if (!selected || !listing) {
      // A runner may surface a raw ENOENT instead of the friendly 503 the
      // default runner builds. Normalise it here so every caller sees the same
      // "install 7z" contract (and the route answers 503, not 500).
      if ((missingMessage as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
        throw importError("RAR support requires 7z or 7zz to be installed on the server", 503);
      throw missingMessage ?? importError("RAR support requires 7z or 7zz to be installed on the server", 503);
    }
    const entries = parseListing(listing.stdout.toString("utf8"), limits);
    const files: ProjectArchiveFile[] = [];
    let total = 0;
    for (const entry of entries) {
      const extracted = await run(
        selected,
        ["e", "-so", "-spd", "-bd", "-bb0", archivePath, "--", entry.path],
        30_000,
        Math.min(limits.maxFileBytes, entry.size) + 1,
      );
      if (extracted.code !== 0)
        throw importError(
          `7z could not read ${entry.path}: ${tailText(extracted.stderr) || tailText(extracted.stdout)}`,
        );
      if (extracted.stdout.length !== entry.size)
        throw importError(
          `RAR entry size mismatch for ${entry.path} (expected ${entry.size}, got ${extracted.stdout.length})`,
        );
      total += extracted.stdout.length;
      if (total > limits.maxTotalBytes) throw importError(`RAR expands beyond ${limits.maxTotalBytes} bytes`);
      files.push({ path: entry.path, content: extracted.stdout });
    }
    return files;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}
