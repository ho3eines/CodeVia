import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ENV_CONTRACT_KEYS, getEnvFresh } from "../config/env.js";
import { projectArchiveLimitsFromEnv } from "../projects/project-archive.js";
import { sandboxConfigFromEnv } from "../projects/sandbox-runner.js";
import { capturedEnvKeys } from "../backup/secrets.js";

/* ------------------------------------------------------------------ *
 * Every setting that changes how *project code* is executed or imported must
 * be part of the validated environment contract:
 *   - a typo fails at boot instead of being silently ignored;
 *   - a portable backup captures it, so a restored server behaves the same.
 * ------------------------------------------------------------------ */

const KEYS = [
  "PROJECT_SANDBOX_ENABLED",
  "PROJECT_SANDBOX_DOCKER_BIN",
  "PROJECT_SANDBOX_IMAGE",
  "PROJECT_SANDBOX_TIMEOUT_MS",
  "PROJECT_SANDBOX_MEMORY_MB",
  "PROJECT_SANDBOX_CPUS",
  "PROJECT_SANDBOX_PIDS_LIMIT",
  "PROJECT_SANDBOX_LOG_TAIL_BYTES",
  "PROJECT_SANDBOX_DIR",
  "PROJECT_SANDBOX_IMAGE_PULL",
  "PROJECT_IMPORT_MAX_UPLOAD_BYTES",
  "PROJECT_IMPORT_MAX_FILES",
  "PROJECT_IMPORT_MAX_FILE_BYTES",
  "PROJECT_IMPORT_MAX_TOTAL_BYTES",
  "PROJECT_IMPORT_MAX_COMPRESSION_RATIO",
  "PROJECT_IMPORT_7Z_BIN",
  "LOCAL_GIT_MODE",
  "LOCAL_REPOS_DIR",
  "LOCAL_GIT_OWNER",
  "LOCAL_GIT_BIN",
  "LOCAL_GIT_AUTO_FETCH",
  "LOCAL_GIT_AUTO_PUSH",
  "LOCAL_GIT_REMOTE",
  "LOCAL_GIT_VERIFY_CMD",
  "LOCAL_GIT_STALE_LOCK_MS",
  "CODEVIA_ALLOWED_ROOTS",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  for (const key of KEYS) delete process.env[key];
  getEnvFresh();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  getEnvFresh();
});

describe("environment contract", () => {
  it("declares every sandbox, archive and local-git setting", () => {
    for (const key of KEYS) expect(ENV_CONTRACT_KEYS, key).toContain(key);
  });

  it("captures them in a portable backup (except the passphrase)", () => {
    const keys = capturedEnvKeys();
    for (const key of KEYS) expect(keys, key).toContain(key);
    expect(keys).not.toContain("BACKUP_PASSPHRASE");
  });

  it("treats blank optional strings as unset, not as empty values", () => {
    process.env.PROJECT_SANDBOX_IMAGE = "   ";
    process.env.LOCAL_GIT_OWNER = "";
    process.env.CODEVIA_ALLOWED_ROOTS = "";
    const env = getEnvFresh();
    expect(env.PROJECT_SANDBOX_IMAGE).toBeUndefined();
    expect(env.LOCAL_GIT_OWNER).toBeUndefined();
    expect(env.CODEVIA_ALLOWED_ROOTS).toBeUndefined();
  });

  it("parses numeric limits and rejects garbage at boot", () => {
    process.env.PROJECT_SANDBOX_MEMORY_MB = "2048";
    process.env.PROJECT_SANDBOX_CPUS = "2.5";
    process.env.PROJECT_IMPORT_MAX_FILES = "42";
    process.env.LOCAL_GIT_AUTO_PUSH = "yes";
    process.env.PROJECT_SANDBOX_ENABLED = "no";
    const env = getEnvFresh();
    expect(env.PROJECT_SANDBOX_MEMORY_MB).toBe(2048);
    expect(env.PROJECT_SANDBOX_CPUS).toBe(2.5);
    expect(env.PROJECT_IMPORT_MAX_FILES).toBe(42);
    expect(env.LOCAL_GIT_AUTO_PUSH).toBe(true);
    expect(env.PROJECT_SANDBOX_ENABLED).toBe(false);

    process.env.PROJECT_SANDBOX_MEMORY_MB = "not-a-number";
    expect(() => getEnvFresh()).toThrow(/Invalid environment configuration/);
  });

  it("feeds the sandbox configuration from the contract", () => {
    process.env.PROJECT_SANDBOX_DOCKER_BIN = "/usr/local/bin/docker";
    process.env.PROJECT_SANDBOX_IMAGE = "node:20-bookworm";
    process.env.PROJECT_SANDBOX_TIMEOUT_MS = "120000";
    process.env.PROJECT_SANDBOX_MEMORY_MB = "2048";
    process.env.PROJECT_SANDBOX_CPUS = "2";
    process.env.PROJECT_SANDBOX_PIDS_LIMIT = "64";
    process.env.PROJECT_SANDBOX_LOG_TAIL_BYTES = "4096";
    process.env.PROJECT_SANDBOX_DIR = "./tmp-sandbox";
    process.env.PROJECT_SANDBOX_IMAGE_PULL = "missing";
    getEnvFresh();

    const config = sandboxConfigFromEnv();
    expect(config.dockerBin).toBe("/usr/local/bin/docker");
    expect(config.image).toBe("node:20-bookworm");
    expect(config.timeoutMs).toBe(120_000);
    expect(config.memoryMb).toBe(2048);
    expect(config.cpus).toBe(2);
    expect(config.pidsLimit).toBe(64);
    expect(config.tailBytes).toBe(4096);
    expect(config.workspaceRoot).toBe(resolve("./tmp-sandbox"));
    expect(config.imagePull).toBe("missing");

    // Explicit options always win (tests / embedding).
    const overridden = sandboxConfigFromEnv({ dockerBin: "podman", memoryMb: 512, imagePull: "always" });
    expect(overridden.dockerBin).toBe("podman");
    expect(overridden.memoryMb).toBe(512);
    expect(overridden.imagePull).toBe("always");
  });

  it("feeds the archive limits from the contract", () => {
    process.env.PROJECT_IMPORT_MAX_UPLOAD_BYTES = String(8 * 1024 * 1024);
    process.env.PROJECT_IMPORT_MAX_FILES = "100";
    process.env.PROJECT_IMPORT_MAX_FILE_BYTES = String(1024 * 1024);
    process.env.PROJECT_IMPORT_MAX_TOTAL_BYTES = String(4 * 1024 * 1024);
    process.env.PROJECT_IMPORT_MAX_COMPRESSION_RATIO = "50";
    getEnvFresh();

    expect(projectArchiveLimitsFromEnv()).toEqual({
      maxUploadBytes: 8 * 1024 * 1024,
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
      maxCompressionRatio: 50,
    });
  });

  it("falls back to safe defaults when the variables are unset", () => {
    expect(projectArchiveLimitsFromEnv()).toMatchObject({
      maxUploadBytes: 25 * 1024 * 1024,
      maxFiles: 5000,
      maxCompressionRatio: 500,
    });
    expect(sandboxConfigFromEnv().dockerBin).toBe("docker");
    expect(sandboxConfigFromEnv().imagePull).toBe("never");
  });
});
