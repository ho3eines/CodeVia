import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemService, isSensitivePath } from "../filesystem/filesystem-service.js";
import { FilesystemError, isFilesystemError } from "../filesystem/filesystem-error.js";

/* ------------------------------------------------------------------ *
 * FilesystemService — safe server-filesystem access:
 *   - allowed-roots containment + path traversal + symlink escape
 *   - typed stat / directory listing (limits, truncation)
 *   - sensitive files are described but never opened
 *   - size limits and permission failures map to the error contract
 * ------------------------------------------------------------------ */

let root: string;
let outside: string;
let svc: FilesystemService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fs-roots-"));
  outside = mkdtempSync(join(tmpdir(), "fs-outside-"));
  svc = new FilesystemService({ allowedRoots: [root] });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const isRoot = () => (typeof process.getuid === "function" ? process.getuid() === 0 : false);

describe("assertSafePath", () => {
  it("resolves a path inside the root", () => {
    expect(svc.assertSafePath(join(root, "a/b.txt"))).toBe(join(root, "a/b.txt"));
  });

  it("accepts the root itself", () => {
    expect(svc.assertSafePath(root)).toBe(root);
  });

  it("rejects empty and non-string paths", () => {
    expect(() => svc.assertSafePath("")).toThrow(FilesystemError);
    expect(() => svc.assertSafePath("   ")).toThrow(FilesystemError);
    expect(() => svc.assertSafePath(null as unknown as string)).toThrow(FilesystemError);
  });

  it("rejects NUL bytes and control characters", () => {
    expect(() => svc.assertSafePath(join(root, "a\0b"))).toThrow(FilesystemError);
    expect(() => svc.assertSafePath(join(root, "a\x01b"))).toThrow(FilesystemError);
  });

  it("blocks path traversal outside the allowed roots", () => {
    let err: unknown;
    try {
      svc.assertSafePath(join(root, "..", "..", "etc", "passwd"));
    } catch (e) {
      err = e;
    }
    expect(isFilesystemError(err)).toBe(true);
    expect((err as FilesystemError).code).toBe("FS_PATH_OUTSIDE_ROOTS");
    expect((err as FilesystemError).statusCode).toBe(403);
  });

  it("blocks absolute paths outside the roots", () => {
    expect(() => svc.assertSafePath("/etc/passwd")).toThrow(FilesystemError);
    expect(() => svc.assertSafePath(outside)).toThrow(FilesystemError);
  });

  it("blocks symlink escape out of the root (read/stat paths)", async () => {
    const escape = join(outside, "secret.txt");
    writeFileSync(escape, "TOP SECRET");
    symlinkSync(escape, join(root, "escape-link"));
    await expect(svc.readFile(join(root, "escape-link"))).rejects.toMatchObject({ code: "FS_PATH_OUTSIDE_ROOTS" });
    await expect(svc.statPath(join(root, "escape-link"))).rejects.toMatchObject({ code: "FS_PATH_OUTSIDE_ROOTS" });
  });

  it("allows symlinks that stay inside the root", async () => {
    writeFileSync(join(root, "real.txt"), "hello");
    symlinkSync(join(root, "real.txt"), join(root, "inner-link"));
    const content = await svc.readFile(join(root, "inner-link"));
    expect(content.content).toBe("hello");
  });

  it("defaults to the process cwd when no roots are configured", () => {
    const saved = process.env.CODEVIA_ALLOWED_ROOTS;
    delete process.env.CODEVIA_ALLOWED_ROOTS;
    try {
      const s = new FilesystemService({ allowedRoots: [] });
      // An explicitly-empty list falls back to the install-dir default.
      expect(s.listRoots()).toContain(process.cwd());
    } finally {
      if (saved !== undefined) process.env.CODEVIA_ALLOWED_ROOTS = saved;
    }
  });
});

describe("exists / isDirectory", () => {
  it("reports existence and directory-ness", async () => {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "file.txt"), "x");
    expect(await svc.exists(join(root, "dir"))).toBe(true);
    expect(await svc.isDirectory(join(root, "dir"))).toBe(true);
    expect(await svc.isDirectory(join(root, "file.txt"))).toBe(false);
    expect(await svc.exists(join(root, "missing"))).toBe(false);
    expect(await svc.isDirectory(join(root, "missing"))).toBe(false);
  });

  it("refuses paths outside the roots", async () => {
    await expect(svc.exists("/etc/passwd")).rejects.toMatchObject({ code: "FS_PATH_OUTSIDE_ROOTS" });
  });
});

describe("statPath", () => {
  it("returns typed metadata for a file", async () => {
    writeFileSync(join(root, "app.ts"), "export {};");
    const stat = await svc.statPath(join(root, "app.ts"));
    expect(stat.kind).toBe("file");
    expect(stat.name).toBe("app.ts");
    expect(stat.size).toBe(10); // "export {};"
    expect(stat.readable).toBe(true);
    expect(stat.sensitive).toBe(false);
    expect(stat.mode).toMatch(/^[0-7]{3}$/);
    expect(stat.modifiedAt).toBeDefined();
  });

  it("flags sensitive files with metadata only (never blocks stat)", async () => {
    writeFileSync(join(root, ".env"), "SECRET=1");
    const stat = await svc.statPath(join(root, ".env"));
    expect(stat.sensitive).toBe(true);
    expect(stat.kind).toBe("file");
  });

  it("throws FS_NOT_FOUND for missing paths", async () => {
    await expect(svc.statPath(join(root, "nope"))).rejects.toMatchObject({ code: "FS_NOT_FOUND", statusCode: 404 });
  });
});

describe("listDirectory", () => {
  beforeEach(() => {
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, ".hidden-dir"));
    writeFileSync(join(root, "zeta.txt"), "z");
    writeFileSync(join(root, ".env"), "S=1");
    writeFileSync(join(root, "beta.md"), "b");
  });

  it("lists entries with directories first and typed metadata", async () => {
    const listing = await svc.listDirectory(root);
    const names = listing.entries.map((e) => e.name);
    expect(names.indexOf("alpha")).toBeLessThan(names.indexOf("beta.md"));
    expect(names).toContain("zeta.txt");
    expect(names).toContain(".env");
    expect(listing.total).toBe(5);
    expect(listing.truncated).toBe(false);
    const env = listing.entries.find((e) => e.name === ".env")!;
    expect(env.sensitive).toBe(true);
    expect(env.hidden).toBe(true);
    const dir = listing.entries.find((e) => e.name === "alpha")!;
    expect(dir.kind).toBe("directory");
  });

  it("truncates with a flag when the limit cuts the listing", async () => {
    const listing = await svc.listDirectory(root, { limit: 2 });
    expect(listing.entries.length).toBe(2);
    expect(listing.truncated).toBe(true);
    expect(listing.total).toBe(5);
  });

  it("rejects listing a file", async () => {
    await expect(svc.listDirectory(join(root, "beta.md"))).rejects.toMatchObject({ code: "FS_NOT_A_DIRECTORY" });
  });

  it("rejects listing outside the roots", async () => {
    await expect(svc.listDirectory(outside)).rejects.toMatchObject({ code: "FS_PATH_OUTSIDE_ROOTS" });
  });
});

describe("readFile", () => {
  it("reads UTF-8 content with size", async () => {
    writeFileSync(join(root, "note.txt"), "سلام CodeVia");
    const out = await svc.readFile(join(root, "note.txt"));
    expect(out.content).toBe("سلام CodeVia");
    expect(out.size).toBeGreaterThan(0);
  });

  it("never reads sensitive files (metadata only)", async () => {
    for (const name of [".env", ".env.production", "id_rsa", "server.pem", "credentials.json", ".npmrc", "my.token"]) {
      writeFileSync(join(root, name), "CANARY-SECRET-VALUE");
    }
    for (const name of [".env", ".env.production", "id_rsa", "server.pem", "credentials.json", ".npmrc", "my.token"]) {
      await expect(svc.readFile(join(root, name))).rejects.toMatchObject({
        code: "FS_SENSITIVE_BLOCKED",
        statusCode: 403,
      });
    }
  });

  it("blocks sensitive paths that contain sensitive directory segments", async () => {
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "config"), "Host *");
    await expect(svc.readFile(join(root, ".ssh", "config"))).rejects.toMatchObject({ code: "FS_SENSITIVE_BLOCKED" });
  });

  it("enforces the file size limit", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(2048));
    const small = new FilesystemService({ allowedRoots: [root], maxFileSizeBytes: 1024 });
    await expect(small.readFile(join(root, "big.txt"))).rejects.toMatchObject({
      code: "FS_FILE_TOO_LARGE",
      statusCode: 413,
    });
    // The default service (1 MiB) reads it fine.
    expect((await svc.readFile(join(root, "big.txt"))).content.length).toBe(2048);
  });

  it("rejects directories", async () => {
    mkdirSync(join(root, "dir"));
    await expect(svc.readFile(join(root, "dir"))).rejects.toMatchObject({ code: "FS_NOT_A_FILE" });
  });

  it("maps permission failures to FS_PERMISSION_DENIED", async () => {
    if (isRoot()) return; // root ignores file modes
    mkdirSync(join(root, "locked"));
    writeFileSync(join(root, "locked", "file.txt"), "x");
    chmodSync(join(root, "locked"), 0o000);
    try {
      await expect(svc.listDirectory(join(root, "locked"))).rejects.toMatchObject({
        code: "FS_PERMISSION_DENIED",
        statusCode: 403,
      });
    } finally {
      chmodSync(join(root, "locked"), 0o755);
    }
  });
});

describe("isSensitivePath helper", () => {
  it("recognizes common secret file names at any depth", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath("config/.env.local")).toBe(true);
    expect(isSensitivePath("/x/y/id_ed25519")).toBe(true);
    expect(isSensitivePath("certs/server.key")).toBe(true);
    expect(isSensitivePath(".ssh/known_hosts")).toBe(true);
    expect(isSensitivePath("src/app.ts")).toBe(false);
    expect(isSensitivePath("package.json")).toBe(false);
  });
});

describe("error contract", () => {
  it("serializes to JSON without contents", () => {
    const err = new FilesystemError({
      code: "FS_SENSITIVE_BLOCKED",
      message: "Refusing to read a sensitive file: .env",
    });
    const json = err.toJSON();
    expect(json.code).toBe("FS_SENSITIVE_BLOCKED");
    expect(json.status).toBe("denied");
    expect(json.error).not.toContain("CANARY");
  });
});
