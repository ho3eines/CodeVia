import { deflateRawSync } from "node:zlib";

/**
 * Minimal in-memory ZIP writer used by the archive tests.
 *
 * It deliberately exposes the low-level fields (method, flags, CRC, Unix mode,
 * declared sizes) so the tests can build the exact malicious or malformed
 * archives the importer must reject — not just well-formed happy paths.
 */
export interface ZipFixtureEntry {
  path: string;
  content?: Buffer | string;
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8 | number;
  /** Override the CRC written into both headers (to test corruption). */
  crc?: number;
  /** Unix mode in the external attributes (0o120777 = symlink). */
  mode?: number;
  /** General-purpose flags (0x1 = encrypted). */
  flags?: number;
  /** Declared uncompressed size; defaults to the real one. */
  declaredSize?: number;
  /** Declared compressed size; defaults to the real one. */
  declaredCompressedSize?: number;
  /** Host system byte of "version made by" (3 = Unix, 0 = MS-DOS). */
  hostSystem?: number;
}

export function crc32(bytes: Buffer): number {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface PreparedEntry {
  name: Buffer;
  method: number;
  flags: number;
  crc: number;
  compressed: Buffer;
  uncompressedSize: number;
  declaredCompressedSize: number;
  mode: number;
  hostSystem: number;
}

function prepare(entry: ZipFixtureEntry): PreparedEntry {
  const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? "", "utf8");
  const method = entry.method ?? 8;
  const compressed = method === 8 ? deflateRawSync(raw) : method === 0 ? raw : raw;
  const name = Buffer.from(entry.path, "utf8");
  return {
    name,
    method,
    flags: entry.flags ?? 0x0800, // UTF-8 names, like every modern archiver
    crc: entry.crc ?? crc32(raw),
    compressed,
    uncompressedSize: entry.declaredSize ?? raw.length,
    declaredCompressedSize: entry.declaredCompressedSize ?? compressed.length,
    mode: entry.mode ?? 0o100644,
    hostSystem: entry.hostSystem ?? 3,
  };
}

export function makeZip(entries: ZipFixtureEntry[]): Buffer {
  const prepared = entries.map(prepare);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of prepared) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(entry.flags, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(entry.crc >>> 0, 14);
    local.writeUInt32LE(entry.declaredCompressedSize >>> 0, 18);
    local.writeUInt32LE(entry.uncompressedSize >>> 0, 22);
    local.writeUInt16LE(entry.name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, entry.name, entry.compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((entry.hostSystem & 0xff) << 8) | 20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(entry.crc >>> 0, 16);
    central.writeUInt32LE(entry.declaredCompressedSize >>> 0, 20);
    central.writeUInt32LE(entry.uncompressedSize >>> 0, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((entry.mode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, entry.name);

    offset += local.length + entry.name.length + entry.compressed.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}
