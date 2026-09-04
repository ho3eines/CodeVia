import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessSync, constants, chmodSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStoragePath } from "../app/storage-preflight.js";

/**
 * The runtime store is SQLite on a volume that Railway mounts root-owned. When the
 * container user cannot write there, node:sqlite only says
 * `unable to open database file` — the pre-flight exists to turn that into an
 * actionable message *before* the DB is opened.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codevia-storage-"));
});

afterEach(() => {
  try {
    chmodSync(dir, 0o755);
  } catch {
    /* already gone */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Root ignores permission bits, so the read-only fixtures would be meaningless. */
function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

describe("storage pre-flight", () => {
  it("accepts a writable directory and reports the resolved db path", () => {
    const info = checkStoragePath(join(dir, "codevia.db"));
    expect(info.writable).toBe(true);
    expect(info.dbPath).toBe(join(dir, "codevia.db"));
    expect(info.dir).toBe(dir);
    expect(info.hint).toBeUndefined();
  });

  it("resolves a relative DATABASE_PATH against the working directory", () => {
    const info = checkStoragePath("data/codevia.db");
    expect(info.dbPath).toBe(join(process.cwd(), "data", "codevia.db"));
    expect(info.dir).toBe(join(process.cwd(), "data"));
  });

  it("flags a read-only volume directory with the fix spelled out", () => {
    chmodSync(dir, 0o555); // readable, traversable, NOT writable
    if (isRoot()) {
      expect(accessSync(dir, constants.W_OK)).toBeUndefined();
      return;
    }
    const info = checkStoragePath(join(dir, "codevia.db"));
    expect(info.writable).toBe(false);
    expect(info.hint).toContain("permission denied");
    expect(info.hint).toContain("mount the persistent volume");
    expect(info.hint).toContain(dir); // the path to attach the volume to
    expect(info.hint).toContain("docker-entrypoint"); // the boot step that chowns it
  });

  it("reports the offending owner and mode so the fix is obvious", () => {
    chmodSync(dir, 0o755);
    const info = checkStoragePath(join(dir, "codevia.db"));
    expect(info.dirOwner?.mode).toBe("755");
    expect(info.uid).toBe(process.getuid?.());
  });

  it("accepts a directory that does not exist yet (the DB layer creates it)", () => {
    const nested = join(dir, "sub", "data", "codevia.db");
    expect(existsSync(join(dir, "sub"))).toBe(false);
    const info = checkStoragePath(nested);
    expect(info.writable).toBe(true);
    expect(info.dir).toBe(join(dir, "sub", "data"));
  });

  it("still fails when the existing parent of a missing directory is read-only", () => {
    const parent = join(dir, "locked");
    mkdirSync(parent);
    chmodSync(parent, 0o555);
    if (isRoot()) return;
    const info = checkStoragePath(join(parent, "codevia.db"));
    expect(info.writable).toBe(false);
    expect(info.hint).toContain(parent);
  });
});
