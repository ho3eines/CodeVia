import { inflateRawSync } from "node:zlib";
import { isSensitivePath } from "../filesystem/filesystem-service.js";

export interface ProjectArchiveFile {
  path: string;
  content: Buffer;
}

export interface ProjectArchiveLimits {
  maxUploadBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_PROJECT_ARCHIVE_LIMITS: ProjectArchiveLimits = {
  maxUploadBytes: 25 * 1024 * 1024,
  maxFiles: 5000,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxCompressionRatio: 500,
};

export function projectArchiveLimitsFromEnv(): ProjectArchiveLimits {
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const parsed = Number(process.env[name]);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  return {
    maxUploadBytes: int(
      "PROJECT_IMPORT_MAX_UPLOAD_BYTES",
      DEFAULT_PROJECT_ARCHIVE_LIMITS.maxUploadBytes,
      1024,
      100 * 1024 * 1024,
    ),
    maxFiles: int("PROJECT_IMPORT_MAX_FILES", DEFAULT_PROJECT_ARCHIVE_LIMITS.maxFiles, 1, 20_000),
    maxFileBytes: int(
      "PROJECT_IMPORT_MAX_FILE_BYTES",
      DEFAULT_PROJECT_ARCHIVE_LIMITS.maxFileBytes,
      1024,
      100 * 1024 * 1024,
    ),
    maxTotalBytes: int(
      "PROJECT_IMPORT_MAX_TOTAL_BYTES",
      DEFAULT_PROJECT_ARCHIVE_LIMITS.maxTotalBytes,
      1024,
      1024 * 1024 * 1024,
    ),
    maxCompressionRatio: int(
      "PROJECT_IMPORT_MAX_COMPRESSION_RATIO",
      DEFAULT_PROJECT_ARCHIVE_LIMITS.maxCompressionRatio,
      1,
      10_000,
    ),
  };
}

const badArchive = (message: string): Error =>
  Object.assign(new Error(`Invalid project archive: ${message}`), { statusCode: 400 });

export function safeProjectArchivePath(raw: string): string {
  if (!raw || raw.includes("\\") || raw.includes("\0") || /[\x01-\x1f\x7f]/.test(raw))
    throw badArchive(`unsafe entry path ${JSON.stringify(raw)}`);
  if (raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:/.test(raw))
    throw badArchive(`absolute entry path ${JSON.stringify(raw)} is not allowed`);
  const trailingSlash = raw.endsWith("/");
  const parts = raw.split("/");
  if (trailingSlash) parts.pop();
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".."))
    throw badArchive(`traversal or empty path segment in ${JSON.stringify(raw)}`);
  if (
    parts.some((part) => part.length > 255 || /[:*?"<>|]$/.test(part) || /[<>:"|?*]/.test(part) || /[. ]$/.test(part))
  )
    throw badArchive(`non-portable path segment in ${JSON.stringify(raw)}`);
  if (parts.join("/").length > 240) throw badArchive(`entry path is too long: ${JSON.stringify(raw)}`);
  if (parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)))
    throw badArchive(`reserved path segment in ${JSON.stringify(raw)}`);
  return parts.join("/");
}

function u16(buf: Buffer, off: number): number {
  if (off < 0 || off + 2 > buf.length) throw badArchive("truncated zip header");
  return buf.readUInt16LE(off);
}
function u32(buf: Buffer, off: number): number {
  if (off < 0 || off + 4 > buf.length) throw badArchive("truncated zip header");
  return buf.readUInt32LE(off);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeName(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw badArchive("file names must be valid UTF-8");
  }
}

function assertNotLinkOrSpecial(versionMadeBy: number, externalAttributes: number, path: string): void {
  const host = versionMadeBy >>> 8;
  if (host !== 3 && host !== 19) return; // Unix or macOS attributes
  const mode = externalAttributes >>> 16;
  const type = mode & 0xf000;
  if (type === 0xa000) throw badArchive(`symbolic link entry is not allowed: ${path}`);
  if (type !== 0 && type !== 0x8000 && type !== 0x4000) throw badArchive(`special file entry is not allowed: ${path}`);
}

interface ZipRecord {
  path: string;
  isDirectory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  crc: number;
  method: number;
  flags: number;
  localOffset: number;
}

function readZipDirectory(buffer: Buffer, limits: ProjectArchiveLimits): ZipRecord[] {
  if (buffer.length < 22) throw badArchive("too small to be a zip archive");
  const scanStart = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let pos = buffer.length - 22; pos >= scanStart; pos--) {
    if (u32(buffer, pos) === 0x06054b50) {
      eocd = pos;
      break;
    }
  }
  if (eocd < 0) throw badArchive("end-of-central-directory record not found");
  if (u16(buffer, eocd + 4) !== 0 || u16(buffer, eocd + 6) !== 0)
    throw badArchive("multi-disk zip archives are not supported");
  const count = u16(buffer, eocd + 10);
  const diskCount = u16(buffer, eocd + 8);
  const cdSize = u32(buffer, eocd + 12);
  const cdOffset = u32(buffer, eocd + 16);
  const commentLength = u16(buffer, eocd + 20);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw badArchive("zip64 archives are not supported");
  if (count !== diskCount) throw badArchive("multi-disk zip archives are not supported");
  if (count > limits.maxFiles) throw badArchive(`too many archive entries (maximum ${limits.maxFiles})`);
  if (eocd + 22 + commentLength > buffer.length || cdOffset + cdSize > eocd)
    throw badArchive("central directory is truncated or overlaps the end record");

  const records: ZipRecord[] = [];
  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;
  const unique = new Set<string>();
  let declaredTotal = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cdEnd || u32(buffer, pos) !== 0x02014b50)
      throw badArchive(`central directory entry ${i + 1} is corrupt`);
    const madeBy = u16(buffer, pos + 4);
    const flags = u16(buffer, pos + 8);
    const method = u16(buffer, pos + 10);
    const crc = u32(buffer, pos + 16);
    const compressedSize = u32(buffer, pos + 20);
    const uncompressedSize = u32(buffer, pos + 24);
    const nameLength = u16(buffer, pos + 28);
    const extraLength = u16(buffer, pos + 30);
    const fileCommentLength = u16(buffer, pos + 32);
    const diskStart = u16(buffer, pos + 34);
    const externalAttributes = u32(buffer, pos + 38);
    const localOffset = u32(buffer, pos + 42);
    const recordEnd = pos + 46 + nameLength + extraLength + fileCommentLength;
    if (recordEnd > cdEnd) throw badArchive(`central directory entry ${i + 1} is truncated`);
    if (diskStart !== 0) throw badArchive("multi-disk zip entries are not supported");
    const rawName = decodeName(buffer.subarray(pos + 46, pos + 46 + nameLength));
    const isDirectory = rawName.endsWith("/");
    const path = safeProjectArchivePath(rawName);
    assertNotLinkOrSpecial(madeBy, externalAttributes, path);
    if (flags & 0x41) throw badArchive(`encrypted entry is not supported: ${path}`);
    if (method !== 0 && method !== 8) throw badArchive(`unsupported compression method ${method}: ${path}`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff)
      throw badArchive("zip64 entries are not supported");
    if (isDirectory && uncompressedSize !== 0) throw badArchive(`directory entry contains data: ${path}`);
    if (!isDirectory) {
      if (uncompressedSize > limits.maxFileBytes)
        throw badArchive(`file exceeds the ${limits.maxFileBytes} byte per-file limit: ${path}`);
      if (compressedSize === 0 && uncompressedSize > 0) throw badArchive(`invalid compressed size for ${path}`);
      if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio)
        throw badArchive(`compression ratio exceeds ${limits.maxCompressionRatio}:1 for ${path}`);
      declaredTotal += uncompressedSize;
      if (declaredTotal > limits.maxTotalBytes)
        throw badArchive(`archive expands beyond the ${limits.maxTotalBytes} byte total limit`);
      const folded = path.toLocaleLowerCase("en-US");
      if (unique.has(folded)) throw badArchive(`duplicate or case-colliding path: ${path}`);
      unique.add(folded);
    }
    if (localOffset + 30 > cdOffset || u32(buffer, localOffset) !== 0x04034b50)
      throw badArchive(`local file header is invalid: ${path}`);
    records.push({ path, isDirectory, compressedSize, uncompressedSize, crc, method, flags, localOffset });
    pos = recordEnd;
  }
  if (pos !== cdEnd) throw badArchive("central directory size does not match its entries");
  return records;
}

/** Parse a bounded ZIP archive without writing untrusted paths to disk. */
export function extractProjectZip(buffer: Buffer, limits = projectArchiveLimitsFromEnv()): ProjectArchiveFile[] {
  if (buffer.length > limits.maxUploadBytes)
    throw badArchive(`compressed archive exceeds ${limits.maxUploadBytes} bytes`);
  const records = readZipDirectory(buffer, limits);
  const files: ProjectArchiveFile[] = [];
  for (const entry of records) {
    if (entry.isDirectory) continue;
    const nameLength = u16(buffer, entry.localOffset + 26);
    const extraLength = u16(buffer, entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) throw badArchive(`file data is truncated: ${entry.path}`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    let content: Buffer;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) throw badArchive(`stored size mismatch: ${entry.path}`);
      content = Buffer.from(compressed);
    } else {
      try {
        content = inflateRawSync(compressed, {
          maxOutputLength: Math.min(limits.maxFileBytes, entry.uncompressedSize) + 1,
        });
      } catch {
        throw badArchive(`deflate data is corrupt or exceeds limits: ${entry.path}`);
      }
      if (content.length !== entry.uncompressedSize) throw badArchive(`expanded size mismatch: ${entry.path}`);
    }
    if (crc32(content) !== entry.crc) throw badArchive(`CRC mismatch: ${entry.path}`);
    files.push({ path: entry.path, content });
  }
  if (!files.length) throw badArchive("archive has no regular files");
  return files;
}

/** Filter secrets and validate an already-parsed project file list before Git import. */
export function prepareProjectFiles(
  input: readonly ProjectArchiveFile[],
  limits = projectArchiveLimitsFromEnv(),
): { files: ProjectArchiveFile[]; omittedSensitive: string[] } {
  if (input.length > limits.maxFiles) throw badArchive(`too many files (maximum ${limits.maxFiles})`);
  const files: ProjectArchiveFile[] = [];
  const omittedSensitive: string[] = [];
  const folded = new Set<string>();
  let total = 0;
  for (const file of input) {
    const path = safeProjectArchivePath(file.path);
    if (path.split("/").some((part) => [".git", ".hg", ".svn"].includes(part.toLowerCase()))) continue;
    if (isSensitivePath(path)) {
      omittedSensitive.push(path);
      continue;
    }
    if (!Buffer.isBuffer(file.content)) throw badArchive(`file content is not binary data: ${path}`);
    if (file.content.length > limits.maxFileBytes) throw badArchive(`file exceeds the per-file limit: ${path}`);
    const lower = path.toLocaleLowerCase("en-US");
    if (folded.has(lower)) throw badArchive(`duplicate or case-colliding path: ${path}`);
    folded.add(lower);
    total += file.content.length;
    if (total > limits.maxTotalBytes) throw badArchive(`project files exceed ${limits.maxTotalBytes} bytes`);
    files.push({ path, content: file.content });
  }
  if (!files.length) throw badArchive("no importable files remain after excluding metadata and secret files");
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (folded.has(parts.slice(0, i).join("/").toLocaleLowerCase("en-US")))
        throw badArchive(`file/directory path collision: ${parts.slice(0, i).join("/")}`);
    }
  }
  return { files, omittedSensitive };
}
