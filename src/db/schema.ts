/**
 * Logical schema for the runtime database.
 *
 * Per the platform's core principle, GitHub is the source of truth for persistent
 * project data. This SQLite-backed store is used for:
 *   - runtime state, cache, index, search
 *   - queue / job bookkeeping
 *   - session, token/cost usage, statistics, audit metadata
 *
 * Entities are stored in a document (`records`) table with typed metadata columns
 * for fast filtering. A separate `jobs` table backs the worker queue.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  project_id TEXT,
  parent_id  TEXT,
  key        TEXT,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
CREATE INDEX IF NOT EXISTS idx_records_project ON records(project_id);
CREATE INDEX IF NOT EXISTS idx_records_key ON records(key);
CREATE INDEX IF NOT EXISTS idx_records_parent ON records(parent_id);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  correlation_id TEXT,
  scheduled_at TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
CREATE INDEX IF NOT EXISTS idx_jobs_correlation ON jobs(correlation_id);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
