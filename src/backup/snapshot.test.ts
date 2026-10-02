import { afterEach, describe, expect, it } from "vitest";
import { KvStore } from "../db/kv.js";
import { DocumentRepository } from "../db/repository.js";
import { JobQueue } from "../db/queue.js";
import { freshDb } from "../tests/test-helpers.js";
import {
  createSnapshot,
  normalizeBackupSnapshot,
  restoreSnapshot,
  snapshotFilePaths,
  snapshotFromFiles,
  type BackupSnapshot,
} from "./snapshot.js";

const now = "2026-10-02T12:00:00.000Z";

describe("full runtime snapshots", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("round-trips records, queue jobs, kv objects, and string-valued kv entries exactly", async () => {
    const fx = freshDb();
    cleanup = fx.cleanup;
    const records = new DocumentRepository<{ id: string; text: string }>("example", fx.db);
    const queue = new JobQueue(fx.db);
    const kv = new KvStore(fx.db);
    records.upsert({ id: "record-1", text: "persisted" });
    const job = queue.enqueue("notify", { title: "Restored", message: "queue payload" });
    kv.set("object-value", { nested: [1, "two"] });
    kv.set("string-value", "a JSON string value");

    const snapshot = await createSnapshot(fx.db);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.kv).toHaveLength(2);

    fx.db.run("DELETE FROM records");
    fx.db.run("DELETE FROM jobs");
    fx.db.run("DELETE FROM kv");
    restoreSnapshot(fx.db, snapshot);

    expect(records.findById("record-1")?.data).toEqual({ id: "record-1", text: "persisted" });
    expect(queue.getById(job.id)?.payload).toEqual({ title: "Restored", message: "queue payload" });
    expect(kv.get("object-value")).toEqual({ nested: [1, "two"] });
    expect(kv.get("string-value")).toBe("a JSON string value");
  });

  it("normalizes raw SQLite rows with snake_case columns and JSON-text values", () => {
    const snapshot = normalizeBackupSnapshot({
      format: "codevia-sqlite-backup",
      version: 1,
      type: "codevia-runtime-backup",
      records: [
        {
          id: "r-sql",
          type: "project",
          project_id: "p1",
          parent_id: null,
          key: null,
          data: '{"id":"p1","name":"Raw SQLite"}',
          created_at: now,
          updated_at: now,
        },
      ],
      jobs: [
        {
          id: "j-sql",
          type: "notify",
          status: "pending",
          payload: '{"title":"hello"}',
          attempts: 1,
          max_attempts: 4,
          correlation_id: "corr-1",
          scheduled_at: null,
          started_at: null,
          finished_at: null,
          error: null,
          created_at: now,
          updated_at: now,
        },
      ],
      kv: [{ key: "quoted-string", value: '"keep quotes"', updated_at: now }],
    });

    expect(snapshot.records[0]).toMatchObject({
      id: "r-sql",
      projectId: "p1",
      data: { id: "p1", name: "Raw SQLite" },
    });
    expect(snapshot.jobs[0]).toMatchObject({ id: "j-sql", maxAttempts: 4, payload: { title: "hello" } });
    expect(snapshot.kv[0].value).toBe("keep quotes");
  });

  it("splits large tables into integrity-checked parts and rejects missing or changed parts", () => {
    const records = Array.from({ length: 3 }, (_, index) => ({
      id: `large-${index}`,
      type: "conversation",
      data: { text: "x".repeat(400 * 1024) },
      createdAt: now,
      updatedAt: now,
    }));
    const snapshot: BackupSnapshot = {
      version: 1,
      type: "codevia-runtime-backup",
      createdAt: now,
      databasePath: "test.db",
      platform: "host",
      summary: { records: records.length, jobs: 0, kv: 0, bytes: 0 },
      records,
      jobs: [],
      kv: [],
    };
    const files = snapshotFilePaths(".codevia/backups/example", snapshot).filter((file) => file.path.endsWith(".json"));
    const recordParts = files.filter((file) => /\/records-\d+\.json$/.test(file.path));
    expect(recordParts.length).toBeGreaterThan(1);

    const restored = snapshotFromFiles(files);
    expect(restored.records).toHaveLength(3);
    expect(restored.records.map((record) => record.id)).toEqual(["large-0", "large-1", "large-2"]);

    expect(() => snapshotFromFiles(files.filter((file) => file.path !== recordParts[0].path))).toThrow(
      /missing records-0001\.json/,
    );
    const tampered = files.map((file) =>
      file.path === recordParts[0].path ? { ...file, content: `${file.content} ` } : file,
    );
    expect(() => snapshotFromFiles(tampered)).toThrow(/SHA-256 integrity check/);
  });

  it("rejects undefined or non-JSON data before export serialization or destructive restore", () => {
    const makeSnapshot = (
      records: BackupSnapshot["records"] = [],
      jobs: BackupSnapshot["jobs"] = [],
      kv: BackupSnapshot["kv"] = [],
    ): BackupSnapshot => ({
      version: 1,
      type: "codevia-runtime-backup",
      createdAt: now,
      databasePath: "test.db",
      platform: "host",
      summary: { records: records.length, jobs: jobs.length, kv: kv.length, bytes: 0 },
      records,
      jobs,
      kv,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidSnapshots = [
      makeSnapshot([{ id: "undefined", type: "example", data: undefined, createdAt: now, updatedAt: now }]),
      makeSnapshot([
        { id: "nested-undefined", type: "example", data: { nested: undefined }, createdAt: now, updatedAt: now },
      ]),
      makeSnapshot(
        [],
        [
          {
            id: "undefined-payload",
            type: "run",
            status: "pending",
            payload: undefined,
            attempts: 0,
            maxAttempts: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
      ),
      makeSnapshot([], [], [{ key: "non-finite", value: Number.NaN, updatedAt: now }]),
      makeSnapshot([{ id: "cyclic", type: "example", data: cyclic, createdAt: now, updatedAt: now }]),
    ];

    for (const snapshot of invalidSnapshots) {
      expect(() => snapshotFilePaths(".codevia/backups/invalid", snapshot)).toThrow(/Invalid backup:/);
    }

    const fx = freshDb();
    cleanup = fx.cleanup;
    const records = new DocumentRepository<{ id: string; preserved: boolean }>("example", fx.db);
    records.upsert({ id: "keep-me", preserved: true });
    expect(() => restoreSnapshot(fx.db, invalidSnapshots[0])).toThrow(/records\[0\]\.data/);
    expect(records.findById("keep-me")?.data).toEqual({ id: "keep-me", preserved: true });
  });
});
