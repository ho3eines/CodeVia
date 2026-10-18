import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_ARCHIVE_LIMITS,
  extractProjectZip,
  prepareProjectFiles,
  safeProjectArchivePath,
  type ProjectArchiveLimits,
} from "../projects/project-archive.js";
import { makeZip } from "./zip-fixture.js";

/* ------------------------------------------------------------------ *
 * Project archive import (.zip).
 *
 * The importer is the only place where untrusted bytes become repository
 * files, so these tests cover the rejection paths (traversal, links, zip
 * bombs, CRC corruption) as carefully as the happy path.
 * ------------------------------------------------------------------ */

const limits = (patch: Partial<ProjectArchiveLimits> = {}): ProjectArchiveLimits => ({
  ...DEFAULT_PROJECT_ARCHIVE_LIMITS,
  ...patch,
});

describe("extractProjectZip", () => {
  it("reads stored and deflated entries byte-exactly", () => {
    const binary = Buffer.from([0, 1, 2, 255, 254]);
    const zip = makeZip([
      { path: "package.json", content: '{"name":"demo"}', method: 8 },
      { path: "src/logo.bin", content: binary, method: 0 },
      { path: "src/" }, // directory entries are skipped
      { path: "docs/read me.md", content: "# hi" },
    ]);
    const files = extractProjectZip(zip, limits());
    expect(files.map((f) => f.path)).toEqual(["package.json", "src/logo.bin", "docs/read me.md"]);
    expect(files[0].content.toString("utf8")).toBe('{"name":"demo"}');
    expect(files[1].content.equals(binary)).toBe(true);
    expect(files[2].content.toString("utf8")).toBe("# hi");
  });

  it.each([
    "../evil.txt",
    "a/../../evil.txt",
    "/etc/passwd",
    "C:/Windows/system.ini",
    "src\\..\\evil.txt",
    "foo//bar.txt",
    "./foo.txt",
  ])("rejects an unsafe entry path: %s", (path) => {
    const zip = makeZip([{ path, content: "x" }]);
    expect(() => extractProjectZip(zip, limits())).toThrow(/Invalid project archive/);
  });

  it("rejects symbolic links and special files", () => {
    const symlink = makeZip([{ path: "link.txt", content: "/etc/passwd", mode: 0o120777 }]);
    expect(() => extractProjectZip(symlink, limits())).toThrow(/symbolic link/i);
    const fifo = makeZip([{ path: "pipe", content: "", mode: 0o010644 }]);
    expect(() => extractProjectZip(fifo, limits())).toThrow(/special file/i);
  });

  it("ignores Unix modes when the archive was written on MS-DOS", () => {
    const zip = makeZip([{ path: "readme.txt", content: "ok", mode: 0o120777, hostSystem: 0 }]);
    expect(extractProjectZip(zip, limits())[0].content.toString("utf8")).toBe("ok");
  });

  it("rejects duplicate and case-colliding paths", () => {
    const zip = makeZip([
      { path: "README.md", content: "a" },
      { path: "readme.md", content: "b" },
    ]);
    expect(() => extractProjectZip(zip, limits())).toThrow(/duplicate or case-colliding/i);
  });

  it("rejects a CRC mismatch instead of importing corrupted bytes", () => {
    const zip = makeZip([{ path: "app.ts", content: "export {}", crc: 0xdeadbeef }]);
    expect(() => extractProjectZip(zip, limits())).toThrow(/CRC mismatch/i);
  });

  it("rejects a zip bomb by compression ratio", () => {
    const zip = makeZip([{ path: "bomb.txt", content: "A".repeat(300_000) }]);
    expect(() => extractProjectZip(zip, limits({ maxCompressionRatio: 10 }))).toThrow(/compression ratio/i);
  });

  it("enforces the upload, file-count, per-file and total limits", () => {
    const small = makeZip([
      { path: "a.txt", content: "aa" },
      { path: "b.txt", content: "bb" },
    ]);
    expect(() => extractProjectZip(small, limits({ maxFiles: 1 }))).toThrow(/too many archive entries/i);
    expect(() => extractProjectZip(small, limits({ maxUploadBytes: 10 }))).toThrow(/compressed archive exceeds/i);
    expect(() => extractProjectZip(small, limits({ maxFileBytes: 1 }))).toThrow(/per-file limit/i);
    expect(() => extractProjectZip(small, limits({ maxTotalBytes: 1 }))).toThrow(/total limit/i);
  });

  it("rejects encrypted entries and unsupported compression methods", () => {
    expect(() => extractProjectZip(makeZip([{ path: "s.txt", content: "x", flags: 0x1 }]), limits())).toThrow(
      /encrypted/i,
    );
    expect(() => extractProjectZip(makeZip([{ path: "s.txt", content: "x", method: 99 }]), limits())).toThrow(
      /unsupported compression method/i,
    );
  });

  it("rejects a size lie and an empty archive", () => {
    expect(() => extractProjectZip(makeZip([{ path: "s.txt", content: "hello", declaredSize: 99 }]), limits())).toThrow(
      /expanded size mismatch/i,
    );
    expect(() => extractProjectZip(makeZip([]), limits())).toThrow(/no regular files/i);
    expect(() => extractProjectZip(Buffer.from("not a zip"), limits())).toThrow(/too small|central directory/i);
  });
});

describe("safeProjectArchivePath", () => {
  it("normalizes portable paths and rejects reserved Windows names", () => {
    expect(safeProjectArchivePath("src/app.ts")).toBe("src/app.ts");
    expect(safeProjectArchivePath("src/we ird/ü.txt")).toBe("src/we ird/ü.txt");
    for (const bad of ["con.txt", "src/nul", "a/aux.md", "trailing. ", "colon:name", "a".repeat(245)]) {
      expect(() => safeProjectArchivePath(bad)).toThrow(/Invalid project archive/);
    }
  });
});

describe("prepareProjectFiles", () => {
  it("drops secrets and VCS metadata instead of committing them", () => {
    const result = prepareProjectFiles([
      { path: ".env", content: Buffer.from("SECRET=1") },
      { path: ".git/config", content: Buffer.from("[remote]") },
      { path: "src/.npmrc", content: Buffer.from("//registry:_authToken=x") },
      { path: "src/index.ts", content: Buffer.from("export {}") },
    ]);
    expect(result.files.map((f) => f.path)).toEqual(["src/index.ts"]);
    expect(result.omittedSensitive.sort()).toEqual([".env", "src/.npmrc"]);
  });

  it("refuses an archive with nothing importable left", () => {
    expect(() => prepareProjectFiles([{ path: ".env.local", content: Buffer.from("X=1") }])).toThrow(
      /no importable files/i,
    );
  });

  it("rejects duplicate paths, path collisions and non-binary content", () => {
    const file = (path: string) => ({ path, content: Buffer.from("x") });
    expect(() => prepareProjectFiles([file("a.txt"), file("A.txt")])).toThrow(/duplicate or case-colliding/i);
    expect(() => prepareProjectFiles([file("src"), file("src/index.ts")])).toThrow(/collision/i);
    expect(() => prepareProjectFiles([{ path: "a.txt", content: "not a buffer" as unknown as Buffer }])).toThrow(
      /not binary data/i,
    );
  });
});
