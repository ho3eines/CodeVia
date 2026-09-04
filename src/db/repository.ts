import type { Db } from "./client.js";
import { getDb, nowIso } from "./client.js";
import type { ID } from "../types.js";

export interface EntityRecord<T> {
  id: ID;
  type: string;
  projectId?: ID;
  parentId?: ID;
  key?: string;
  data: T;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  type: string;
  project_id: string | null;
  parent_id: string | null;
  key: string | null;
  data: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertOptions {
  projectId?: ID;
  parentId?: ID;
  key?: string;
}

/**
 * Generic document-backed repository. Domain entities are serialized as JSON with
 * indexed metadata columns for querying. Provides the persistence abstraction the
 * platform's higher layers (Projects, Agents, Models, etc.) build on.
 */
export class DocumentRepository<T extends { id: ID }> {
  protected db: Db;
  constructor(
    protected readonly type: string,
    db: Db = getDb(),
  ) {
    this.db = db;
  }

  toRow(entity: T, opts: UpsertOptions, createdAt: string): Row {
    return {
      id: entity.id,
      type: this.type,
      project_id: opts.projectId ?? null,
      parent_id: opts.parentId ?? null,
      key: opts.key ?? null,
      data: JSON.stringify(entity),
      created_at: createdAt,
      updated_at: nowIso(),
    };
  }

  deserialize(row: Row): EntityRecord<T> {
    return {
      id: row.id,
      type: row.type,
      projectId: row.project_id ?? undefined,
      parentId: row.parent_id ?? undefined,
      key: row.key ?? undefined,
      data: JSON.parse(row.data) as T,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  insert(entity: T, opts: UpsertOptions = {}): EntityRecord<T> {
    const row = this.toRow(entity, opts, nowIso());
    this.db.run(
      `INSERT OR REPLACE INTO records (id, type, project_id, parent_id, key, data, created_at, updated_at)
       VALUES (:id, :type, :project_id, :parent_id, :key, :data, :created_at, :updated_at)`,
      row as unknown as Record<string, string | number | null>,
    );
    return this.deserialize(row);
  }

  update(entity: T, opts: UpsertOptions = {}): EntityRecord<T> {
    return this.insert(entity, opts);
  }

  /** Upsert preserving createdAt when the record already exists. */
  upsert(entity: T, opts: UpsertOptions = {}): EntityRecord<T> {
    const existing = this.findById(entity.id);
    const createdAt = existing?.createdAt ?? nowIso();
    const row = this.toRow(entity, opts, createdAt);
    if (existing) {
      row.created_at = existing.createdAt;
      row.project_id = opts.projectId ?? existing.projectId ?? null;
      row.parent_id = opts.parentId ?? existing.parentId ?? null;
      row.key = opts.key ?? existing.key ?? null;
    }
    this.db.run(
      `INSERT OR REPLACE INTO records (id, type, project_id, parent_id, key, data, created_at, updated_at)
       VALUES (:id, :type, :project_id, :parent_id, :key, :data, :created_at, :updated_at)`,
      row as unknown as Record<string, string | number | null>,
    );
    return this.deserialize(row);
  }

  findById(id: ID): EntityRecord<T> | undefined {
    const row = this.db.get<Row>(`SELECT * FROM records WHERE id = :id AND type = :type`, {
      id,
      type: this.type,
    });
    return row ? this.deserialize(row) : undefined;
  }

  findMany(filter: { projectId?: ID; key?: string; parentId?: ID } = {}): EntityRecord<T>[] {
    const clauses: string[] = ["type = :type"];
    const params: SqlLike = { type: this.type };
    if (filter.projectId) {
      clauses.push("project_id = :project_id");
      params.project_id = filter.projectId;
    }
    if (filter.key) {
      clauses.push("key = :key");
      params.key = filter.key;
    }
    if (filter.parentId) {
      clauses.push("parent_id = :parent_id");
      params.parent_id = filter.parentId;
    }
    const rows = this.db.all<Row>(
      `SELECT * FROM records WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return rows.map((r) => this.deserialize(r));
  }

  deleteById(id: ID): void {
    this.db.run(`DELETE FROM records WHERE id = :id AND type = :type`, { id, type: this.type });
  }

  deleteByProject(projectId: ID): void {
    this.db.run(`DELETE FROM records WHERE project_id = :project_id AND type = :type`, {
      project_id: projectId,
      type: this.type,
    });
  }

  count(): number {
    const r = this.db.get<{ n: number }>(`SELECT COUNT(*) as n FROM records WHERE type = :type`, {
      type: this.type,
    })!;
    return Number(r.n);
  }

  exists(id: ID): boolean {
    return !!this.findById(id);
  }
}

type SqlLike = Record<string, string | number | null | undefined>;
