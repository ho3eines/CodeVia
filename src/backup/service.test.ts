import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshDb } from "../tests/test-helpers.js";
import { BackupService } from "./service.js";
import { MockGitHubService } from "../github/mock-service.js";
import { ProviderRegistry } from "../ai/provider-registry.js";
import { MockProvider } from "../ai/mock-provider.js";
import { AuditRepository, NotificationRepository } from "../observability/repos.js";
import { logger } from "../logger.js";
import { KvStore } from "../db/kv.js";
import { saveBackupSettings, getBackupSettings } from "./settings.js";
import { DocumentRepository } from "../db/repository.js";
import type { Project } from "../domain/entities.js";

interface ProjectDoc {
  id: string;
  name: string;
  slug: string;
  configRepo: string;
  branch: string;
}

describe("BackupService", () => {
  let fx: ReturnType<typeof freshDb>;
  let kv: KvStore;
  let github: MockGitHubService;
  let service: BackupService;
  let projectRepo: DocumentRepository<ProjectDoc>;

  beforeEach(() => {
    fx = freshDb();
    kv = new KvStore();
    github = new MockGitHubService({ seedDemoRepos: false });
    github.seedRepo("acme", "codevia-backups", { files: [{ path: "README.md", content: "# backups\n" }] });
    const auditRepo = new AuditRepository();
    const notificationRepo = new NotificationRepository();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new MockProvider("provider-mock"));
    service = new BackupService({
      db: fx.db,
      kv,
      github,
      auditRepo,
      notificationRepo,
      providerRegistry,
      logger,
    });
    projectRepo = new DocumentRepository<ProjectDoc>("project");
  });

  afterEach(() => fx.cleanup());

  it("pushes a full snapshot to the configured GitHub repo and restores it", async () => {
    projectRepo.upsert({ id: "p1", name: "Demo", slug: "demo", configRepo: "acme/demo", branch: "main" });
    saveBackupSettings(kv, {
      enabled: true,
      repo: "acme/codevia-backups",
      branch: "main",
      path: ".codevia/backups",
      schedule: "0 * * * *",
      retain: 10,
    });

    const run = await service.runNow();
    expect(run.ok).toBe(true);
    expect(run.commit).toBeTruthy();
    expect(run.files).toBe(6);
    expect(run.counts).toMatchObject({ records: 1, jobs: 0, kv: 1 });

    const list = await service.listBackups();
    expect(list.length).toBe(1);
    expect(list[0].records).toBe(1);

    // Simulate a brand-new / wiped Railway runtime.
    fx.db.run("DELETE FROM records");
    fx.db.run("DELETE FROM jobs");
    fx.db.run("DELETE FROM kv");
    expect(projectRepo.findById("p1")).toBeUndefined();
    // On a fresh deploy the operator re-creates the backup target config.
    saveBackupSettings(kv, {
      repo: "acme/codevia-backups",
      branch: "main",
      path: ".codevia/backups",
      schedule: "0 * * * *",
    });

    const restored = await service.restoreFromGitHub({ replace: true });
    expect(restored.ok).toBe(true);
    expect(restored.from).toBe("github");
    expect(restored.records).toBe(1);
    expect(projectRepo.findById("p1")?.data.name).toBe("Demo");
  });

  it("restores from an in-memory snapshot object", () => {
    const snapshot = {
      version: 1,
      type: "codevia-runtime-backup",
      createdAt: new Date().toISOString(),
      databasePath: "test.db",
      platform: "host",
      records: [
        { id: "p2", type: "project", projectId: undefined, parentId: undefined, key: undefined, data: { id: "p2", name: "Restored" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ],
      jobs: [],
      kv: [{ key: "foo", value: { bar: 1 }, updatedAt: new Date().toISOString() }],
    };
    const result = service.restoreSnapshotObject(snapshot);
    expect(result.ok).toBe(true);
    expect(projectRepo.findById("p2")?.data.name).toBe("Restored");
    expect(kv.get("foo")).toEqual({ bar: 1 });
  });
});
