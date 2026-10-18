import { inflateRawSync } from "node:zlib";
import * as zlib from "node:zlib";
import { isStatePath } from "./state-codec.js";
import type { GithubFile } from "./types.js";

/**
 * State archive import — the model-free bootstrap path for LOCAL_GIT_MODE.
 *
 * A project whose repository carries no CodeVia/ state yet normally needs an
 * AI model to author its definitions. When no model is configured, the user
 * can instead supply a zip of an existing CodeVia folder (an export from
 * another installation, a colleague's project, or a GitHub "Download ZIP").
 * This module parses the archive with the standard library only — no zip
 * dependency — and reduces it to the managed state files it may contain.
 *
 * Security posture: the archive is untrusted input. Only `CodeVia/**` paths
 * survive (rooted at the archive root or under exactly one folder, the
 * GitHub download layout), path traversal is rejected before any name is
 * used, encrypted/unsupported entries are refused, and the same size caps
 * as repository commits apply (8 MB per file, 32 MB total, 200 files).
 */

/** Same per-file cap as ProjectFilesService commit/read paths. */
const MAX_FILE_BYTES = 8_000_000;
/** Same total-state cap as ProjectFilesService commit/read paths. */
const MAX_TOTAL_BYTES = 32_000_000;
const MAX_STATE_FILES = 200;
/** Hard reader ceilings — anything larger is not a state archive. */
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_RAW_BYTES = 64_000_000;
const MAX_ENTRY_RAW_BYTES = 16_000_000;

const badArchive = (message: string) =>
  Object.assign(new Error(`Invalid state archive: ${message}`), { statusCode: 400 });

interface ZipEntry {
  path: string;
  content: Buffer;
}

/** Normalize and validate an entry name; undefined means "not usable". */
function safeZipPath(name: string): string | undefined {
  if (!name || name.includes("\\")) return undefined;
  if (/[\x00-\x1f\x7f]/.test(name)) return undefined;
  const parts = name.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return undefined;
  return parts.join("/");
}

/** CRC-32 via zlib (node ≥ 20.15); absent on older runtimes, so verify only when available. */
const crc32: ((data: Buffer) => number) | undefined = (zlib as { crc32?: (data: Buffer) => number }).crc32;

function u16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function u32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

/**
 * Read a small, unencrypted, non-zip64 zip archive. Sizes always come from
 * the central directory (the local header may be zeroed behind a data
 * descriptor), which also makes the reader robust to appended junk before
 * the end-of-central-directory record.
 */
function readZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) throw badArchive("too small to be a zip file");
  // EOCD sits at the end, optionally followed by a ≤64 KB comment.
  const scanStart = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= scanStart; i--) {
    if (u32(buffer, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw badArchive("end-of-central-directory record not found (not a zip file?)");
  const count = u16(buffer, eocd + 10);
  const cdSize = u32(buffer, eocd + 12);
  const cdOffset = u32(buffer, eocd + 16);
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw badArchive("zip64 archives are not supported (and are far larger than any state archive)");
  if (count > MAX_ARCHIVE_ENTRIES) throw badArchive(`too many entries (${count}; maximum ${MAX_ARCHIVE_ENTRIES})`);
  if (cdOffset + cdSize > buffer.length) throw badArchive("central directory is truncated");

  const entries: ZipEntry[] = [];
  let totalRaw = 0;
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buffer.length || u32(buffer, pos) !== 0x02014b50)
      throw badArchive(`central directory entry ${i + 1} is corrupt`);
    const flags = u16(buffer, pos + 8);
    const method = u16(buffer, pos + 10);
    const crc = u32(buffer, pos + 16);
    const compSize = u32(buffer, pos + 20);
    const uncompSize = u32(buffer, pos + 24);
    const nameLen = u16(buffer, pos + 28);
    const extraLen = u16(buffer, pos + 30);
    const commentLen = u16(buffer, pos + 32);
    const localOffset = u32(buffer, pos + 42);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) throw badArchive("zip64 entries are not supported");
    const name = buffer.slice(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw badArchive(`entry "${name}" is encrypted; decrypted archives are not supported`);
    if (name.endsWith("/") || name.endsWith("\\")) continue; // directory entry
    const path = safeZipPath(name);
    if (!path) throw badArchive(`unsafe entry path: ${JSON.stringify(name)}`);
    if (uncompSize > MAX_ENTRY_RAW_BYTES) throw badArchive(`entry "${path}" is too large (${uncompSize} bytes)`);

    // Local file header: locate the compressed payload.
    if (localOffset + 30 > buffer.length || u32(buffer, localOffset) !== 0x04034b50)
      throw badArchive(`local header for "${path}" is corrupt`);
    const dataStart = localOffset + 30 + u16(buffer, localOffset + 26) + u16(buffer, localOffset + 28);
    if (dataStart + compSize > buffer.length) throw badArchive(`data for "${path}" is truncated`);
    const data = buffer.slice(dataStart, dataStart + compSize);

    let content: Buffer;
    if (method === 0) {
      if (compSize !== uncompSize) throw badArchive(`entry "${path}" has inconsistent store sizes`);
      content = data;
    } else if (method === 8) {
      try {
        content = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_RAW_BYTES + 1 });
      } catch {
        throw badArchive(`entry "${path}" uses unsupported deflate data`);
      }
      if (content.length !== uncompSize) throw badArchive(`entry "${path}" decompressed to an unexpected size`);
    } else {
      throw badArchive(`entry "${path}" uses unsupported compression method ${method} (only store/deflate)`);
    }
    if (crc32 && crc32(content) !== crc) throw badArchive(`CRC mismatch for "${path}" — the archive is corrupt`);
    totalRaw += content.length;
    if (totalRaw > MAX_ARCHIVE_RAW_BYTES) throw badArchive(`archive expands beyond ${MAX_ARCHIVE_RAW_BYTES} bytes`);
    entries.push({ path, content });
  }
  return entries;
}

/**
 * Extract the CodeVia state files from a zip archive. Accepts archives rooted
 * at `CodeVia/…` or at a single wrapping folder (`<repo>/CodeVia/…`, the
 * GitHub "Download ZIP" layout). Everything else in the archive is ignored.
 */
export function extractStateArchive(buffer: Buffer): GithubFile[] {
  const entries = readZipEntries(buffer);
  const rooted = entries.filter((e) => e.path.startsWith("CodeVia/"));
  const nested = entries.filter((e) => /^[^/]+\/CodeVia\//.test(e.path));
  const pool = rooted.length ? rooted : nested;
  if (!pool.length)
    throw badArchive(
      "no CodeVia/ folder found — expected an archive containing CodeVia/… (directly or under one folder)",
    );
  const stripFolder = pool === nested && pool.length > 0;

  const files = new Map<string, string>();
  let total = 0;
  for (const entry of pool) {
    const path = stripFolder ? entry.path.split("/").slice(1).join("/") : entry.path;
    if (!isStatePath(path)) continue; // non-managed files inside CodeVia/ are simply ignored
    if (entry.content.length > MAX_FILE_BYTES)
      throw badArchive(`state file "${path}" exceeds the ${MAX_FILE_BYTES} byte per-file limit`);
    total += entry.content.length;
    if (total > MAX_TOTAL_BYTES) throw badArchive(`state files exceed the ${MAX_TOTAL_BYTES} byte total limit`);
    files.set(path, entry.content.toString("utf8"));
  }
  if (!files.size) throw badArchive("the CodeVia/ folder contains no readable state files (.md definitions)");
  if (files.size > MAX_STATE_FILES)
    throw badArchive(`too many state files (${files.size}; maximum ${MAX_STATE_FILES})`);
  return [...files].map(([path, content]) => ({ path, content }));
}
