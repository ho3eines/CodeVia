import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEnv } from "../config/env.js";
import { SCHEMA } from "./schema.js";
import { logger } from "../logger.js";

/** Type-only reference to the experimental `node:sqlite` driver. */
type SqliteDatabase = import("node:sqlite").DatabaseSync;

const nodeRequire = createRequire(import.meta.url);
/** Lazily load the experimental built-in so Vite/vite-node never tries to resolve it. */
function loadSqlite(): typeof import("node:sqlite") {
  return nodeRequire("node:sqlite") as typeof import("node:sqlite");
}

export type SqlParams = Record<string, string | number | null | undefined>;

/** node:sqlite does not accept `undefined` as a bound value — map it to null. */
function sanitize(params: SqlParams): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const k of Object.keys(params)) {
    const v = params[k];
    out[k] = v === undefined ? null : v;
  }
  return out;
}

/**
 * Thin wrapper around node:sqlite. Kept deliberately small so its surface can be
 * swapped for Postgres in production without touching call sites (the platform
 * defines a repository abstraction; this is the default runtime adapter).
 */
export class Db {
  private db: SqliteDatabase;

  constructor(path?: string) {
    const dbPath = path ?? getEnv().DATABASE_PATH;
    mkdirSync(dirname(dbPath), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  run(sql: string, params: SqlParams = {}): void {
    (this.db.prepare(sql) as unknown as { run: (p: Record<string, string | number | null>) => void }).run(sanitize(params));
  }

  get<T = Record<string, unknown>>(sql: string, params: SqlParams = {}): T | undefined {
    return (this.db.prepare(sql) as unknown as { get: (p: Record<string, string | number | null>) => unknown }).get(sanitize(params)) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params: SqlParams = {}): T[] {
    return (this.db.prepare(sql) as unknown as { all: (p: Record<string, string | number | null>) => unknown[] }).all(sanitize(params)) as T[];
  }

  /** Execute a function inside a synchronous transaction. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Expose the underlying driver for advanced queries (e.g. health checks). */
  raw(): SqliteDatabase {
    return this.db;
  }
}

let defaultInstance: Db | null = null;

export function getDb(): Db {
  if (!defaultInstance) {
    defaultInstance = new Db();
    logger.debug("runtime sqlite initialized");
  }
  return defaultInstance;
}

export function setDbForTest(db: Db): void {
  defaultInstance = db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
