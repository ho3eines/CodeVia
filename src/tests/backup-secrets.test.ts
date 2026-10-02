import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { getEnvFresh } from "../config/env.js";
import { parseEnvFile } from "../config/env-file.js";
import { Db } from "../db/client.js";
import { KvStore } from "../db/kv.js";
import { DocumentRepository } from "../db/repository.js";
import { decryptSecret, encryptSecret } from "../auth/encrypted-secrets.js";
import { getUserGitHubToken, storeUserGitHubToken } from "../auth/github-tokens.js";
import { BackupService } from "../backup/service.js";
import { saveBackupSettings } from "../backup/settings.js";
import {
  createSnapshot,
  normalizeBackupSnapshot,
  snapshotFilePaths,
  snapshotFromFiles,
  type BackupSnapshot,
} from "../backup/snapshot.js";
import {
  applyEnvironmentBundle,
  collectEnvironmentBundle,
  decryptEnvironmentBundle,
  describeEnvironmentBundle,
  encryptEnvironmentBundle,
} from "../backup/secrets.js";
import {
  listLocalBackups,
  pruneLocalBackups,
  readLocalSnapshotFiles,
  resolveLocalBackupDir,
  writeLocalBackup,
} from "../backup/local.js";
import { MockGitHubService } from "../github/mock-service.js";
import { ProviderRegistry } from "../ai/provider-registry.js";
import { MockProvider } from "../ai/mock-provider.js";
import { AuditRepository, NotificationRepository } from "../observability/repos.js";
import { logger } from "../logger.js";
import { backupCli } from "../backup/cli.js";
import { freshDb } from "./test-helpers.js";
import type { ModelProvider } from "../domain/entities.js";
import type { TelegramAccount } from "../domain/telegram.js";

/* ------------------------------------------------------------------ *\
 * "Back up EVERYTHING, API keys included, so I can bring this exact
 * installation up on another server."
 *
 * These tests pin the two halves of that promise:
 *   1. a snapshot carries the environment and every credential in a form that
 *      does not depend on the exporting server's AUTH_SECRET;
 *   2. restoring that snapshot on a *different* server re-wraps the credentials
 *      with the new AUTH_SECRET, re-applies the environment and writes it to
 *      `<database dir>/.env` so a restart keeps it.
 * ------------------------------------------------------------------ */

const SOURCE_AUTH_SECRET = "source-server-auth-secret-0123456789abcdef";
const TARGET_AUTH_SECRET = "completely-different-target-auth-secret-xyz";
const PASSPHRASE = "correct horse battery staple";

const CONTROLLED_KEYS = [
  "AUTH_SECRET",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "DATABASE_PATH",
  "BACKUP_PASSPHRASE",
  "BACKUP_INCLUDE_SECRETS",
  "BACKUP_INCLUDE_ENV",
  "BACKUP_LOCAL_COPY",
  "BACKUP_LOCAL_DIR",
  "PUBLIC_WEB_BASE_URL",
];

interface Fixture {
  db: Db;
  kv: KvStore;
  providers: DocumentRepository<ModelProvider>;
  telegram: DocumentRepository<TelegramAccount>;
  cleanup: () => void;
}

let fx: Fixture | undefined;
let savedEnv: Record<string, string | undefined> = {};
let app: FastifyInstance | undefined;
let container: Container | undefined;

function setEnv(patch: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  getEnvFresh();
}

/** A runtime store holding one of each kind of credential the platform keeps. */
function seedInstallation(): Fixture {
  const base = freshDb();
  const kv = new KvStore(base.db);
  const providers = new DocumentRepository<ModelProvider>("provider", base.db);
  const telegram = new DocumentRepository<TelegramAccount>("telegram-account", base.db);
  const now = new Date().toISOString();

  providers.upsert({
    id: "provider-openai-real",
    name: "OpenAI (real key)",
    type: "openai",
    secretValueEnc: JSON.stringify(encryptSecret("sk-provider-key-from-ui", "provider-secret")),
    authType: "bearer",
    apiFormat: "openai",
    timeoutMs: 30000,
    maxTokensDefault: 4096,
    defaultTemperature: 0.2,
    rateLimitPerMinute: 60,
    active: true,
    createdAt: now,
    updatedAt: now,
  } as ModelProvider);

  telegram.upsert({
    id: "tg-account-1",
    userId: "user-1",
    name: "Ops bot",
    tokenEnc: JSON.stringify(encryptSecret("123456:telegram-bot-token", "telegram-token")),
    botUsername: "codevia_ops_bot",
    accountId: "99887766",
    connected: true,
    createdAt: now,
    updatedAt: now,
  } as TelegramAccount);

  storeUserGitHubToken(kv, "user-1", "ghu_user_oauth_token", { scopes: ["repo"], login: "alice" });
  new DocumentRepository<{ id: string; name: string }>("project", base.db).upsert({ id: "p1", name: "Demo" });

  return { db: base.db, kv, providers, telegram, cleanup: base.cleanup };
}

function makeService(fixture: Fixture, github = new MockGitHubService({ seedDemoRepos: false })): BackupService {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new MockProvider("provider-mock"));
  return new BackupService({
    db: fixture.db,
    kv: fixture.kv,
    github,
    auditRepo: new AuditRepository(),
    notificationRepo: new NotificationRepository(),
    providerRegistry,
    logger,
  });
}

function wipe(fixture: Fixture): void {
  fixture.db.run("DELETE FROM records");
  fixture.db.run("DELETE FROM jobs");
  fixture.db.run("DELETE FROM kv");
}

beforeEach(() => {
  savedEnv = {};
  for (const key of CONTROLLED_KEYS) savedEnv[key] = process.env[key];
  setEnv({
    AUTH_SECRET: SOURCE_AUTH_SECRET,
    OPENAI_API_KEY: "sk-env-openai-key",
    ANTHROPIC_API_KEY: "sk-ant-env-key",
    GITHUB_TOKEN: "ghp_server_token",
    TELEGRAM_BOT_TOKEN: "999:server-bot-token",
    BACKUP_PASSPHRASE: undefined,
    BACKUP_INCLUDE_SECRETS: undefined,
    BACKUP_INCLUDE_ENV: undefined,
    BACKUP_LOCAL_COPY: undefined,
    BACKUP_LOCAL_DIR: undefined,
    PUBLIC_WEB_BASE_URL: undefined,
  });
  fx = seedInstallation();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  container?.githubAutomation.stop();
  container = undefined;
  fx?.cleanup();
  fx = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  getEnvFresh();
});

describe("full backup — environment and credential bundle", () => {
  it("captures every API key from the environment and every credential from the database", () => {
    const bundle = collectEnvironmentBundle(fx!.db);

    // Environment-only keys: they exist in no table, so without this the new
    // server would come up with dead providers.
    expect(bundle.env.OPENAI_API_KEY).toBe("sk-env-openai-key");
    expect(bundle.env.ANTHROPIC_API_KEY).toBe("sk-ant-env-key");
    expect(bundle.env.GITHUB_TOKEN).toBe("ghp_server_token");
    expect(bundle.env.TELEGRAM_BOT_TOKEN).toBe("999:server-bot-token");
    expect(bundle.env.AUTH_SECRET).toBe(SOURCE_AUTH_SECRET);
    expect(bundle.secretKeys).toContain("OPENAI_API_KEY");
    expect(bundle.plaintextSecrets).toBe(true);

    // Database credentials, decrypted for transport.
    const provider = bundle.dbSecrets.find((s) => s.kind === "provider");
    expect(provider?.value).toBe("sk-provider-key-from-ui");
    expect(provider?.label).toBe("OpenAI (real key)");
    const bot = bundle.dbSecrets.find((s) => s.kind === "telegram-account");
    expect(bot?.value).toBe("123456:telegram-bot-token");
    const githubToken = bundle.dbSecrets.find((s) => s.kind === "github-user-token");
    expect(githubToken?.value).toBe("ghu_user_oauth_token");
    expect(githubToken?.meta).toMatchObject({ login: "alice", scopes: ["repo"] });

    // The description shown in the UI/audit log must never carry a usable value.
    const described = JSON.stringify(describeEnvironmentBundle(bundle));
    expect(described).not.toContain("sk-env-openai-key");
    expect(described).not.toContain("sk-provider-key-from-ui");
    expect(described).not.toContain("ghu_user_oauth_token");
    expect(described).toContain("sk-e");
  });

  it("captures a provider's custom secretRef variable even though it is not in the env contract", () => {
    fx!.providers.upsert({
      id: "provider-custom",
      name: "Custom",
      type: "openai-compatible",
      secretRef: "MY_CORP_LLM_KEY",
      authType: "bearer",
      apiFormat: "openai",
      timeoutMs: 1000,
      maxTokensDefault: 100,
      defaultTemperature: 0,
      rateLimitPerMinute: 10,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as ModelProvider);
    process.env.MY_CORP_LLM_KEY = "corp-secret-value";
    try {
      expect(collectEnvironmentBundle(fx!.db).env.MY_CORP_LLM_KEY).toBe("corp-secret-value");
    } finally {
      delete process.env.MY_CORP_LLM_KEY;
    }
  });

  it("leaves credentials out entirely when includeSecrets is off", async () => {
    process.env.PUBLIC_WEB_BASE_URL = "https://old-server.example.com";
    const snapshot = await createSnapshot(fx!.db, { includeSecrets: false });
    expect(snapshot.environment?.dbSecrets).toEqual([]);
    expect(snapshot.environment?.env.OPENAI_API_KEY).toBeUndefined();
    expect(snapshot.environment?.env.AUTH_SECRET).toBeUndefined();
    // Non-secret configuration still travels, so the new server behaves the same.
    expect(snapshot.environment?.env.PUBLIC_WEB_BASE_URL).toBe("https://old-server.example.com");

    // No credential file at all — the bundle that remains is plain configuration.
    const files = snapshotFilePaths(".codevia/backups/no-secrets", snapshot);
    expect(files.some((f) => f.path.endsWith("secrets.json"))).toBe(false);
    expect(files.some((f) => f.path.endsWith("environment.json"))).toBe(true);
    const joined = files.map((f) => f.content).join("\n");
    expect(joined).not.toContain("sk-env-openai-key");
    expect(joined).not.toContain("sk-provider-key-from-ui");
    expect(joined).not.toContain("ghu_user_oauth_token");
  });

  it("restores credentials on a server with a DIFFERENT AUTH_SECRET", async () => {
    const snapshot = await createSnapshot(fx!.db);

    // Prove the premise: with another AUTH_SECRET the stored ciphertext is dead.
    setEnv({ AUTH_SECRET: TARGET_AUTH_SECRET });
    const storedProvider = snapshot.records.find((r) => r.id === "provider-openai-real")?.data as ModelProvider;
    expect(decryptSecret(storedProvider.secretValueEnc, "provider-secret")).toBeUndefined();

    wipe(fx!);
    const service = makeService(fx!);
    const result = service.restoreSnapshotObject(snapshot);

    expect(result.ok).toBe(true);
    expect(result.environment).toMatchObject({ providers: 1, telegramAccounts: 1, githubTokens: 1 });
    // The rows came back readable under the NEW secret — this is the whole point.
    const provider = fx!.providers.findById("provider-openai-real")?.data;
    expect(decryptSecret(provider?.secretValueEnc, "provider-secret")).toBe("sk-provider-key-from-ui");
    const account = fx!.telegram.findById("tg-account-1")?.data;
    expect(decryptSecret(account?.tokenEnc, "telegram-token")).toBe("123456:telegram-bot-token");
    expect(getUserGitHubToken(fx!.kv, "user-1")).toMatchObject({ token: "ghu_user_oauth_token", login: "alice" });
  });

  it("applies the environment to the running process and writes <db dir>/.env", async () => {
    process.env.DATABASE_PATH = "/var/lib/source-server/codevia.db";
    const snapshot = await createSnapshot(fx!.db);
    // A brand-new server: none of the keys exist yet, and it runs from its own
    // database path (which the backup must NOT overwrite).
    setEnv({
      AUTH_SECRET: TARGET_AUTH_SECRET,
      OPENAI_API_KEY: undefined,
      GITHUB_TOKEN: undefined,
      DATABASE_PATH: "/srv/new-server/codevia.db",
    });
    wipe(fx!);

    const result = makeService(fx!).restoreSnapshotObject(snapshot);
    expect(result.ok).toBe(true);
    expect(result.environment?.envApplied).toContain("OPENAI_API_KEY");
    expect(result.environment?.envApplied).toContain("GITHUB_TOKEN");
    expect(process.env.OPENAI_API_KEY).toBe("sk-env-openai-key");
    expect(process.env.GITHUB_TOKEN).toBe("ghp_server_token");

    const envPath = join(dirname(fx!.db.path), ".env");
    expect(result.environment?.envFile).toMatchObject({ ok: true, path: envPath });
    expect(existsSync(envPath)).toBe(true);
    const written = parseEnvFile(readFileSync(envPath, "utf8"));
    expect(written.OPENAI_API_KEY).toBe("sk-env-openai-key");
    expect(written.GITHUB_TOKEN).toBe("ghp_server_token");
    // Deployment-local values are recorded for reference…
    expect(snapshot.environment?.env.DATABASE_PATH).toBe("/var/lib/source-server/codevia.db");
    expect(result.environment?.hostBound).toContain("DATABASE_PATH");
    // …but never forced onto the running server: the new host keeps its own.
    expect(process.env.DATABASE_PATH).toBe("/srv/new-server/codevia.db");
    expect(written.DATABASE_PATH).toBe("/srv/new-server/codevia.db");
  });

  it("never overwrites a variable the target server already provides (unless asked)", () => {
    const bundle = collectEnvironmentBundle(fx!.db);
    process.env.OPENAI_API_KEY = "sk-this-server-has-its-own";

    const applied = applyEnvironmentBundle(fx!.db, bundle, { skipEnvFile: true });
    expect(process.env.OPENAI_API_KEY).toBe("sk-this-server-has-its-own");
    expect(applied.envKept).toContain("OPENAI_API_KEY");
    expect(applied.envApplied).not.toContain("OPENAI_API_KEY");

    const forced = applyEnvironmentBundle(fx!.db, bundle, { skipEnvFile: true, overwriteEnv: true });
    expect(process.env.OPENAI_API_KEY).toBe("sk-env-openai-key");
    expect(forced.envApplied).toContain("OPENAI_API_KEY");
  });

  it("round-trips the bundle through the stored file layout with integrity checks", async () => {
    const snapshot = await createSnapshot(fx!.db);
    const files = snapshotFilePaths(".codevia/backups/2026-10-02", snapshot);
    // A bundle with credentials in it is named `secrets.json`, not `environment.json`.
    const secretsFile = files.find((f) => f.path.endsWith("secrets.json"));
    expect(secretsFile).toBeTruthy();
    expect(secretsFile!.content).toContain("sk-provider-key-from-ui");

    const manifest = JSON.parse(files.find((f) => f.path.endsWith("manifest.json"))!.content);
    expect(manifest.files.environment[0].path).toBe("secrets.json");
    expect(manifest.environment.providers).toBe(1);

    const restored = snapshotFromFiles(files);
    expect(restored.environment?.dbSecrets.map((s) => s.value)).toContain("ghu_user_oauth_token");
    expect(restored.environment?.env.OPENAI_API_KEY).toBe("sk-env-openai-key");

    // A truncated or edited credential file must fail loudly, not restore half a server.
    const tampered = files.map((f) => (f.path === secretsFile!.path ? { ...f, content: `${f.content} ` } : f));
    expect(() => snapshotFromFiles(tampered)).toThrow(/SHA-256 integrity check/);
    expect(() => snapshotFromFiles(files.filter((f) => f.path !== secretsFile!.path))).toThrow(/missing secrets\.json/);
  });

  it("stores the bundle encrypted when BACKUP_PASSPHRASE is set, and needs it to restore", async () => {
    const snapshot = await createSnapshot(fx!.db);
    setEnv({ BACKUP_PASSPHRASE: PASSPHRASE });

    const files = snapshotFilePaths(".codevia/backups/encrypted", snapshot);
    expect(files.some((f) => f.path.endsWith("secrets.json"))).toBe(false);
    const encryptedFile = files.find((f) => f.path.endsWith("secrets.enc.json"));
    expect(encryptedFile).toBeTruthy();
    // No credential survives in any stored file.
    const joined = files.map((f) => f.content).join("\n");
    for (const secret of ["sk-env-openai-key", "sk-provider-key-from-ui", "ghu_user_oauth_token", PASSPHRASE]) {
      expect(joined).not.toContain(secret);
    }

    // The server has the passphrase in its environment → restore just works.
    const unlocked = snapshotFromFiles(files);
    expect(unlocked.environment?.env.OPENAI_API_KEY).toBe("sk-env-openai-key");

    // Without it, the restore refuses instead of silently dropping every key.
    setEnv({ BACKUP_PASSPHRASE: undefined });
    const locked = normalizeBackupSnapshot(snapshotFromFiles(files));
    expect(locked.environment).toBeUndefined();
    expect(locked.environmentEnc).toBeTruthy();
    const refused = makeService(fx!).restoreSnapshotObject(locked);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/passphrase/i);

    const withPassphrase = makeService(fx!).restoreSnapshotObject(locked, { passphrase: PASSPHRASE });
    expect(withPassphrase.ok).toBe(true);
    expect(decryptSecret(fx!.providers.findById("provider-openai-real")?.data.secretValueEnc, "provider-secret")).toBe(
      "sk-provider-key-from-ui",
    );

    expect(
      decryptEnvironmentBundle(encryptEnvironmentBundle(snapshot.environment!, PASSPHRASE), "wrong"),
    ).toBeUndefined();
  });

  it("writes a local copy next to the database even with no GitHub repository", async () => {
    const service = makeService(fx!);
    saveBackupSettings(fx!.kv, { schedule: "0 * * * *", retain: 2 });

    const first = await service.runNow();
    expect(first.ok).toBe(true);
    expect(first.configured).toBe(false);
    expect(first.local?.ok).toBe(true);
    expect(first.warning).toMatch(/disk only/);

    const dir = resolveLocalBackupDir(fx!.db);
    const entries = await listLocalBackups(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("local");
    expect(entries[0].secrets).toBe(true);
    expect(entries[0].latest).toBe(true);

    // The stored copy is a complete snapshot: wipe the runtime and come back.
    const files = await readLocalSnapshotFiles(dir, entries[0].id);
    expect(files.some((f) => f.path === "manifest.json")).toBe(true);
    wipe(fx!);
    expect(fx!.providers.findById("provider-openai-real")).toBeUndefined();

    const restored = await service.restoreFromLocal({ replace: true });
    expect(restored.ok).toBe(true);
    expect(restored.from).toBe("local");
    expect(restored.records).toBeGreaterThan(0);
    expect(fx!.providers.findById("provider-openai-real")?.data.name).toBe("OpenAI (real key)");
    expect(decryptSecret(fx!.providers.findById("provider-openai-real")?.data.secretValueEnc, "provider-secret")).toBe(
      "sk-provider-key-from-ui",
    );
  });

  it("prunes local snapshots beyond the retention limit, keeping the newest", async () => {
    const dir = resolveLocalBackupDir(fx!.db);
    const snapshot = await createSnapshot(fx!.db);
    const ids = ["2026-10-01T00-00-00-000Z", "2026-10-02T00-00-00-000Z", "2026-10-03T00-00-00-000Z"];
    for (const id of ids) {
      const written = await writeLocalBackup(dir, id, snapshotFilePaths(`b/${id}`, snapshot), snapshot);
      expect(written.ok).toBe(true);
    }
    expect(await listLocalBackups(dir)).toHaveLength(3);

    const removed = await pruneLocalBackups(dir, 2);
    expect(removed).toEqual([ids[0]]);
    const left = await listLocalBackups(dir);
    expect(left.map((entry) => entry.id)).toEqual([ids[2], ids[1]]);
    expect(left[0].latest).toBe(true);
  });

  it("lists GitHub and local snapshots together, newest first", async () => {
    const github = new MockGitHubService({ seedDemoRepos: false });
    github.seedRepo("acme", "codevia-backups", { files: [{ path: "README.md", content: "# backups\n" }] });
    const service = makeService(fx!, github);
    saveBackupSettings(fx!.kv, { repo: "acme/codevia-backups", branch: "main", schedule: "0 * * * *" });

    const run = await service.runNow();
    expect(run.ok).toBe(true);
    expect(run.commit).toBeTruthy();

    const all = await service.listAll();
    expect(all.length).toBe(2);
    expect(all.map((entry) => entry.source).sort()).toEqual(["github", "local"]);
    expect(all[0].latest).toBe(true);
    expect(all[1].latest).toBe(false);
  });
});

describe("backup CLI (the no-UI path for a brand-new server)", () => {
  it("exports one file and rebuilds a wiped installation from it", async () => {
    const file = join(dirname(fx!.db.path), "cli-backup.json");
    const lines: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    console.error = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      expect(await backupCli(["export", "--out", file])).toBe(0);
      expect(existsSync(file)).toBe(true);
      // The printed summary describes credentials without revealing them.
      expect(lines.join("\n")).toMatch(/3 credential\(s\)/);
      expect(lines.join("\n")).not.toContain("sk-provider-key-from-ui");

      wipe(fx!);
      expect(fx!.providers.findById("provider-openai-real")).toBeUndefined();
      lines.length = 0;
      expect(await backupCli(["restore", file])).toBe(0);

      expect(fx!.providers.findById("provider-openai-real")?.data.name).toBe("OpenAI (real key)");
      expect(
        decryptSecret(fx!.providers.findById("provider-openai-real")?.data.secretValueEnc, "provider-secret"),
      ).toBe("sk-provider-key-from-ui");
      expect(getUserGitHubToken(fx!.kv, "user-1")?.token).toBe("ghu_user_oauth_token");
      expect(existsSync(join(dirname(fx!.db.path), ".env"))).toBe(true);

      // A missing file exits non-zero instead of wiping anything.
      expect(await backupCli(["restore", "does-not-exist.json"])).toBe(1);
      expect(await backupCli(["list"])).toBe(0);
      expect(await backupCli(["help"])).toBe(0);
      expect(await backupCli(["bogus"])).toBe(1);
    } finally {
      console.log = log;
      console.error = error;
    }
  });
});

describe("full backup HTTP surface", () => {
  async function boot(): Promise<FastifyInstance> {
    container = new Container();
    await container.ensureSeed();
    const built = await buildServer(container);
    app = built.app;
    await app.ready();
    return app;
  }

  it("downloads one self-contained file that carries the whole installation", async () => {
    const server = await boot();
    const response = await server.inject({ method: "GET", url: "/admin/backup/download" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/attachment; filename="codevia-full-backup-.*\.json"/);
    expect(response.headers["cache-control"]).toBe("no-store");

    const snapshot = JSON.parse(response.payload) as BackupSnapshot;
    expect(snapshot.type).toBe("codevia-runtime-backup");
    expect(snapshot.version).toBe(2);
    expect(Array.isArray(snapshot.records)).toBe(true);
    expect(snapshot.environment?.env.OPENAI_API_KEY).toBe("sk-env-openai-key");
    expect(snapshot.environment?.dbSecrets.map((s) => s.value)).toContain("sk-provider-key-from-ui");
    expect(Number(response.headers["x-codevia-backup-credentials"])).toBeGreaterThan(0);
  });

  it("reports what a restore brought back, credentials included", async () => {
    const server = await boot();
    const exported = await server.inject({ method: "GET", url: "/admin/backup/export" });
    const snapshot = JSON.parse(exported.payload) as BackupSnapshot;

    setEnv({ AUTH_SECRET: TARGET_AUTH_SECRET, OPENAI_API_KEY: undefined });
    const response = await server.inject({
      method: "POST",
      url: "/admin/backup/restore",
      payload: { snapshotData: snapshot, replace: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.environment.providers).toBe(1);
    expect(body.environment.telegramAccounts).toBe(1);
    expect(body.environment.githubTokens).toBe(1);
    expect(body.environment.envFile.ok).toBe(true);
    expect(body.warning).toMatch(/credential/i);
    expect(process.env.OPENAI_API_KEY).toBe("sk-env-openai-key");
  });

  it("describes the backup policy on the admin config endpoint", async () => {
    const server = await boot();
    const response = await server.inject({ method: "GET", url: "/admin/backup" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.effective).toMatchObject({ includeEnv: true, includeSecrets: true, localCopy: true });
    expect(body.secrets.includeSecrets).toBe(true);
    expect(body.secrets.hint).toMatch(/plaintext/i);
    expect(body.local.dir).toBeTruthy();

    const saved = await server.inject({
      method: "PUT",
      url: "/admin/backup",
      payload: { includeSecrets: false, localCopy: false, schedule: "0 * * * *" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().effective).toMatchObject({ includeSecrets: false, localCopy: false });
  });
});
