import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { getEnvFresh } from "../config/env.js";
import { DocumentRepository } from "../db/repository.js";
import { snapshotFilePaths, type BackupSnapshot } from "../backup/snapshot.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";

let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;
let previousAuthSecret: string | undefined;

beforeEach(() => {
  previousAuthSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "test-auth-secret-for-backup-restore-012345";
  getEnvFresh();
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  container?.githubAutomation.stop();
  if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = previousAuthSecret;
  getEnvFresh();
  cleanup?.();
  cleanup = undefined;
});

async function boot(): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  const built = await buildServer(container);
  app = built.app;
  await app.ready();
  return app;
}

describe("full backup restore API", () => {
  it("accepts a standalone snapshot larger than the default 5 MiB JSON body limit", async () => {
    const server = await boot();
    const largeText = "x".repeat(6 * 1024 * 1024);
    const response = await server.inject({
      method: "POST",
      url: "/admin/backup/restore",
      payload: {
        snapshotData: {
          version: 1,
          type: "codevia-runtime-backup",
          createdAt: "2026-10-02T12:00:00.000Z",
          records: [
            {
              id: "large-record",
              type: "example",
              data: { text: largeText },
              createdAt: "2026-10-02T12:00:00.000Z",
              updatedAt: "2026-10-02T12:00:00.000Z",
            },
          ],
          jobs: [],
          kv: [{ key: "restore.string", value: "saved as JSON string", updatedAt: "2026-10-02T12:00:00.000Z" }],
        },
        replace: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, records: 1, jobs: 0, kv: 1, replace: true });
    const records = new DocumentRepository<{ id: string; text: string }>("example", container.db);
    expect(records.findById("large-record")?.data.text).toHaveLength(6 * 1024 * 1024);
    expect(container.kv.get("restore.string")).toBe("saved as JSON string");
  });

  it("does not delete current data when a selected split backup is incomplete", async () => {
    const server = await boot();
    const records = new DocumentRepository<{ id: string; value: string }>("example", container.db);
    records.upsert({ id: "keep-me", value: "existing" });

    const response = await server.inject({
      method: "POST",
      url: "/admin/backup/restore",
      payload: {
        snapshotFiles: [
          {
            path: "manifest.json",
            content: JSON.stringify({
              version: 1,
              type: "codevia-runtime-backup",
              summary: { records: 1, jobs: 0, kv: 0 },
              files: {
                records: [{ path: "records.json", count: 1, sha256: "expected-hash" }],
                jobs: [{ path: "jobs.json", count: 0, sha256: "empty-hash" }],
                kv: [{ path: "kv.json", count: 0, sha256: "empty-hash" }],
              },
            }),
          },
          { path: "records.json", content: "[]" },
          { path: "jobs.json", content: "[]" },
          { path: "kv.json", content: "[]" },
        ],
        replace: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/SHA-256 integrity check/);
    expect(records.findById("keep-me")?.data.value).toBe("existing");
  });

  it("round-trips an exported snapshot through standalone and selected-part uploads", async () => {
    const server = await boot();
    const records = new DocumentRepository<{ id: string; value: string }>("example", container.db);
    records.upsert({ id: "backup-round-trip", value: "complete record" });
    const job = container.queue.enqueue("notify", { message: "complete job payload" });
    container.kv.set("backup.round-trip.string", "JSON string value");

    const exported = await server.inject({ method: "GET", url: "/admin/backup/export" });
    expect(exported.statusCode).toBe(200);
    const snapshot = exported.json() as BackupSnapshot;
    expect(snapshot.records.some((record) => record.id === "backup-round-trip")).toBe(true);
    expect(snapshot.jobs.some((row) => row.id === job.id)).toBe(true);
    expect(snapshot.kv.some((item) => item.key === "backup.round-trip.string")).toBe(true);

    const wipeRuntime = () => {
      container.db.run("DELETE FROM records");
      container.db.run("DELETE FROM jobs");
      container.db.run("DELETE FROM kv");
    };
    wipeRuntime();

    const standalone = await server.inject({
      method: "POST",
      url: "/admin/backup/restore",
      payload: { snapshotData: snapshot, replace: true },
    });
    expect(standalone.statusCode).toBe(200);
    expect(standalone.json()).toMatchObject({
      ok: true,
      records: snapshot.records.length,
      jobs: snapshot.jobs.length,
      kv: snapshot.kv.length,
      replace: true,
    });
    expect(records.findById("backup-round-trip")?.data.value).toBe("complete record");
    expect(container.queue.getById(job.id)?.payload).toEqual({ message: "complete job payload" });
    expect(container.kv.get("backup.round-trip.string")).toBe("JSON string value");

    wipeRuntime();
    const selectedParts = snapshotFilePaths("download/snapshot", snapshot).map((file) => ({
      path: `selected-folder/${file.path}`,
      content: file.content,
    }));
    const multipart = await server.inject({
      method: "POST",
      url: "/admin/backup/restore",
      payload: { snapshotFiles: selectedParts, replace: true },
    });
    expect(multipart.statusCode).toBe(200);
    expect(multipart.json()).toMatchObject({
      ok: true,
      records: snapshot.records.length,
      jobs: snapshot.jobs.length,
      kv: snapshot.kv.length,
      replace: true,
    });
    expect(records.findById("backup-round-trip")?.data.value).toBe("complete record");
    expect(container.queue.getById(job.id)?.payload).toEqual({ message: "complete job payload" });
    expect(container.kv.get("backup.round-trip.string")).toBe("JSON string value");
  });

  it("rejects rows missing required data without replacing the current runtime", async () => {
    const server = await boot();
    const records = new DocumentRepository<{ id: string; value: string }>("example", container.db);
    records.upsert({ id: "keep-me", value: "existing" });

    const response = await server.inject({
      method: "POST",
      url: "/admin/backup/restore",
      payload: {
        snapshotData: {
          version: 1,
          type: "codevia-runtime-backup",
          records: [{ id: "invalid-record", type: "example" }],
          jobs: [],
          kv: [],
        },
        replace: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/records\[0\]\.data is missing/);
    expect(records.findById("keep-me")?.data.value).toBe("existing");
  });
});
