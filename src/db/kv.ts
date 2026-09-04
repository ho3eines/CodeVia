import { getDb, nowIso } from "./client.js";
import type { Db } from "./client.js";

/**
 * Simple key/value store for system-level settings (static config, non-secret
 * bookkeeping). Secrets are never stored here — that's what env/secret manager is for.
 */
export class KvStore {
  constructor(private db: Db = getDb()) {}

  set(key: string, value: unknown): void {
    const serialized = JSON.stringify(value);
    this.db.run(
      `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (:key, :value, :updated_at)`,
      { key, value: serialized, updated_at: nowIso() },
    );
  }

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.get(`SELECT value FROM kv WHERE key = :key`, { key }) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  delete(key: string): void {
    this.db.run(`DELETE FROM kv WHERE key = :key`, { key });
  }

  all(): Record<string, unknown> {
    const rows = this.db.all(`SELECT key, value FROM kv`) as { key: string; value: string }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = JSON.parse(r.value);
    return out;
  }
}

export function getKv(): KvStore {
  return new KvStore();
}
