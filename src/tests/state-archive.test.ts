import { describe, expect, it } from "vitest";
import { deflateRawSync, crc32 } from "node:zlib";
import { extractStateArchive } from "../github/state-archive.js";
import { PROJECT_FILE } from "../github/project-files.js";

/** Minimal deterministic zip builder (store + deflate) — no external dependency. */
function buildZip(
  files: Array<{ name: string; content: string | Buffer; method?: 0 | 8; flags?: number; crc?: number }>,
): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const content = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8");
    const method = f.method ?? 0;
    const data = method === 8 ? deflateRawSync(content) : content;
    const crc = f.crc ?? crc32(content);
    const flags = f.flags ?? 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(content.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    local.push(lfh, name, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(content.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);

    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, cd, eocd]);
}

const projectFile = "---\ndefinition:\n  schemaVersion: 2\n---\n\n# Demo\n";
const agentFile = "---\ntype: research\nslug: research\n---\n\nYou research.\n";

describe("state archive extraction", () => {
  it("keeps only CodeVia/** files from a directly rooted archive (store + deflate)", () => {
    const zip = buildZip([
      { name: "CodeVia/project.md", content: projectFile },
      { name: "CodeVia/agents/research.md", content: agentFile, method: 8 },
      { name: "README.md", content: "# repo readme\n" },
      { name: "src/index.ts", content: "export {};\n" },
      { name: "CodeVia/", content: "" }, // directory entry must be skipped
    ]);
    const files = extractStateArchive(zip);
    expect(files.map((f) => f.path).sort()).toEqual(["CodeVia/agents/research.md", "CodeVia/project.md"]);
    expect(files.find((f) => f.path === PROJECT_FILE)?.content).toBe(projectFile);
    expect(files.find((f) => f.path === "CodeVia/agents/research.md")?.content).toBe(agentFile);
  });

  it("accepts the GitHub download layout: <repo>/CodeVia/** is unwrapped", () => {
    const zip = buildZip([
      { name: "demo-main/CodeVia/project.md", content: projectFile },
      { name: "demo-main/CodeVia/agents/research.md", content: agentFile },
      { name: "demo-main/README.md", content: "# readme\n" },
    ]);
    const files = extractStateArchive(zip);
    expect(files.map((f) => f.path).sort()).toEqual(["CodeVia/agents/research.md", "CodeVia/project.md"]);
  });

  it("prefers a directly rooted CodeVia/ when both layouts are present", () => {
    const zip = buildZip([
      { name: "CodeVia/project.md", content: projectFile },
      { name: "wrap/CodeVia/project.md", content: "---\ndefinition: {}\n---\nwrong\n" },
    ]);
    const files = extractStateArchive(zip);
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe(projectFile);
  });

  it("later duplicate entries win, mirroring zip semantics", () => {
    const zip = buildZip([
      { name: "CodeVia/project.md", content: "old" },
      { name: "CodeVia/project.md", content: projectFile },
    ]);
    expect(extractStateArchive(zip)[0].content).toBe(projectFile);
  });

  it("rejects path traversal (zip-slip)", () => {
    const zip = buildZip([{ name: "CodeVia/../../evil.md", content: "x" }]);
    expect(() => extractStateArchive(zip)).toThrow(/unsafe entry path/i);
  });

  it("rejects absolute and backslash paths", () => {
    // A leading "/" is simply not a CodeVia path — the archive has no state folder.
    expect(() => extractStateArchive(buildZip([{ name: "/etc/passwd", content: "x" }]))).toThrow(
      /no CodeVia\/ folder found/i,
    );
    // Backslash separators are never valid inside a repository path.
    expect(() => extractStateArchive(buildZip([{ name: "CodeVia\\evil.md", content: "x" }]))).toThrow(
      /unsafe entry path/i,
    );
  });

  it("rejects encrypted entries", () => {
    const zip = buildZip([{ name: "CodeVia/project.md", content: projectFile, flags: 0x1 }]);
    expect(() => extractStateArchive(zip)).toThrow(/encrypted/i);
  });

  it("rejects a corrupt CRC", () => {
    const zip = buildZip([{ name: "CodeVia/project.md", content: projectFile, crc: 0xdeadbeef }]);
    expect(() => extractStateArchive(zip)).toThrow(/CRC mismatch/i);
  });

  it("rejects unsupported compression methods and truncated archives", () => {
    const zip = buildZip([{ name: "CodeVia/project.md", content: projectFile, method: 12 as 0 }]);
    expect(() => extractStateArchive(zip)).toThrow(/unsupported compression method/i);
    expect(() => extractStateArchive(Buffer.from("not a zip at all"))).toThrow(/Invalid state archive/i);
  });

  it("rejects archives without a CodeVia folder", () => {
    const zip = buildZip([{ name: "README.md", content: "# readme\n" }]);
    expect(() => extractStateArchive(zip)).toThrow(/no CodeVia\/ folder found/i);
  });

  it("keeps non-markdown files inside CodeVia/ — the pull-time codec is the authority", () => {
    const zip = buildZip([{ name: "CodeVia/bin/logo.png", content: Buffer.from([1, 2, 3]) }]);
    const files = extractStateArchive(zip);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("CodeVia/bin/logo.png");
  });

  it("enforces the state size caps", () => {
    const big = "x".repeat(8_000_001);
    expect(() => extractStateArchive(buildZip([{ name: "CodeVia/big.md", content: big }]))).toThrow(/per-file limit/i);
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `CodeVia/agents/a${i}.md`, content: agentFile }));
    expect(() => extractStateArchive(buildZip(many))).toThrow(/too many state files/i);
  });
});
