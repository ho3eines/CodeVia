#!/usr/bin/env -S npx tsx
/**
 * CodeVia backup CLI — the no-UI path to a complete backup / restore.
 *
 * Why this exists next to the admin UI: a *brand-new* server has an empty
 * database, so there is nobody to log in as and no settings page to press
 * "Restore" on (and with REQUIRE_AUTH=true the API answers 401 to everyone).
 * This CLI brings such a server up from one backup file before the platform is
 * started:
 *
 *   # on the old server (or use the UI's download button)
 *   npm run backup:export -- --out codevia-backup.json
 *
 *   # on the new server
 *   npm ci && npm run build
 *   npm run backup:restore -- codevia-backup.json
 *   npm start
 *
 * The restore writes the runtime database, re-encrypts every credential with
 * THIS machine's AUTH_SECRET, and persists the restored environment to
 * `<database dir>/.env` so the keys survive the next restart.
 *
 * Everything it prints is non-secret: counts, variable *names* and masks.
 */
// MUST stay the first import: reads `.env` before `../db/client.js` (via the
// logger) caches the environment contract.
import "../config/env-bootstrap.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/client.js";
import {
  bundleForStorage,
  createSnapshot,
  normalizeBackupSnapshot,
  resolveSnapshotBundle,
  restoreSnapshot,
  snapshotFromFiles,
  type BackupSnapshot,
} from "./snapshot.js";
import { describeEnvironmentBundle, type BundleSummary } from "./secrets.js";
import { applyEnvironmentBundle } from "./secrets.js";
import { listLocalBackups, readLocalSnapshotFiles, resolveLocalBackupDir } from "./local.js";

interface CliOptions {
  out?: string;
  passphrase?: string;
  overwriteEnv?: boolean;
  dryRun?: boolean;
  local?: boolean;
  noSecrets?: boolean;
  noEnvFile?: boolean;
  localDir?: string;
}

function parseArgs(argv: string[]): { command: string; positional: string[]; options: CliOptions } {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const options: CliOptions = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = (): string => rest[++i] ?? "";
    if (arg === "--out" || arg === "-o") options.out = next();
    else if (arg === "--passphrase" || arg === "-p") options.passphrase = next();
    else if (arg === "--local-dir") options.localDir = next();
    else if (arg === "--local") options.local = true;
    else if (arg === "--overwrite-env") options.overwriteEnv = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-secrets") options.noSecrets = true;
    else if (arg === "--no-env-file") options.noEnvFile = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  return { command, positional, options };
}

const USAGE = `
CodeVia full system backup

Usage:
  backup export  [--out FILE] [--no-secrets] [--passphrase P]
  backup restore <FILE | --local [SNAPSHOT_ID]> [--passphrase P] [--overwrite-env]
                 [--no-env-file] [--dry-run]
  backup list    [--local-dir DIR]

  export   Write one self-contained JSON snapshot: every runtime row PLUS the
           environment and the API keys/tokens (plaintext unless --passphrase).
           Without --out the snapshot is written to stdout.
  restore  Rebuild this server from a snapshot file or from a local copy stored
           next to the database. Credentials are re-encrypted with this
           machine's AUTH_SECRET and the environment is written to
           <database dir>/.env so it survives a restart.
  list     Show the snapshots stored on this machine.
`.trim();

/** The non-secret description of a bundle, encrypted ones included. */
function bundleSummaryOf(snapshot: BackupSnapshot): BundleSummary | undefined {
  if (snapshot.environment) return describeEnvironmentBundle(snapshot.environment);
  return snapshot.environmentEnc?.summary;
}

function printBundleSummary(snapshot: BackupSnapshot): void {
  const summary = bundleSummaryOf(snapshot);
  if (!summary) {
    console.log("Bundle: none (this backup carries no environment or credentials)");
    return;
  }
  console.log(`Bundle: ${summary.envKeys} environment value(s), ${summary.dbSecrets} credential(s)`);
  console.log(`  · provider API keys: ${summary.providers}`);
  console.log(`  · telegram bot tokens: ${summary.telegramAccounts}`);
  console.log(`  · github user tokens: ${summary.githubTokens}`);
  const masked = Object.entries(summary.masked);
  if (masked.length) {
    console.log("  · credentials (masked):");
    for (const [name, value] of masked) console.log(`      ${name} = ${value}`);
  }
}

async function exportBackup(options: CliOptions): Promise<number> {
  const snapshot = await createSnapshot(getDb(), { includeSecrets: options.noSecrets ? false : undefined });
  // With a passphrase the stored file holds the protected bundle instead.
  const stored = options.passphrase ? bundleForStorage(snapshot, options.passphrase) : snapshot;
  const payload = JSON.stringify(stored, null, 2);
  if (options.out) {
    const target = resolve(options.out);
    writeFileSync(target, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(`Wrote ${target}`);
  } else {
    process.stdout.write(payload);
  }
  console.error(
    `Snapshot: ${snapshot.records.length} records, ${snapshot.jobs.length} jobs, ${snapshot.kv.length} kv entries`,
  );
  printBundleSummary(snapshot);
  if (!options.noSecrets && !options.passphrase) {
    console.error("\n⚠ This file contains live API keys and tokens in plaintext. Keep it private.");
  }
  return 0;
}

async function restoreBackup(positional: string[], options: CliOptions): Promise<number> {
  const source = positional[0];
  let snapshotInput: unknown;

  if (options.local || !source) {
    const dir = resolveLocalBackupDir(getDb(), options.localDir);
    const id = source ?? (await listLocalBackups(dir, 1))[0]?.id;
    if (!id) {
      console.error(`No local backup found in ${dir}.`);
      return 1;
    }
    const files = await readLocalSnapshotFiles(dir, id);
    if (!files.length) {
      console.error(`Local snapshot ${id} holds no snapshot files.`);
      return 1;
    }
    console.log(`Restoring local snapshot ${id} from ${dir}`);
    snapshotInput = snapshotFromFiles(files, { passphrase: options.passphrase });
  } else {
    const file = resolve(source);
    if (!existsSync(file)) {
      console.error(`Backup file not found: ${file}`);
      return 1;
    }
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      console.error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    try {
      snapshotInput = JSON.parse(raw) as unknown;
    } catch {
      console.error(`${file} is not valid JSON`);
      return 1;
    }
    console.log(`Restoring from ${file}`);
  }

  const snapshot = normalizeBackupSnapshot(snapshotInput);
  const origin = snapshot.environment?.source;
  console.log(
    `Snapshot created ${snapshot.createdAt}` +
      `${origin?.hostname ? ` on ${origin.hostname}` : ""} — ` +
      `${snapshot.records.length} records, ${snapshot.jobs.length} jobs, ${snapshot.kv.length} kv entries`,
  );
  printBundleSummary(snapshot);

  // Resolve (and unlock) BEFORE anything is written: a locked bundle must stop
  // the restore instead of leaving a server without its API keys.
  let bundle;
  try {
    bundle = resolveSnapshotBundle(snapshot, options.passphrase);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (options.dryRun) {
    console.log("\n--dry-run: nothing was written.");
    return 0;
  }

  const db = getDb();
  const result = restoreSnapshot(db, snapshot, true);
  console.log(`\nDatabase restored: ${result.records} records, ${result.jobs} jobs, ${result.kv} kv entries`);

  if (bundle) {
    const applied = applyEnvironmentBundle(db, bundle, {
      overwriteEnv: options.overwriteEnv,
      skipEnvFile: options.noEnvFile,
    });
    console.log(
      `Environment: ${applied.envApplied.length} value(s) applied` +
        (applied.envKept.length
          ? `, ${applied.envKept.length} already set on this server and kept (${applied.envKept.join(", ")})`
          : ""),
    );
    console.log(
      `Credentials re-encrypted with this machine's AUTH_SECRET: ` +
        `${applied.secretsReEncrypted.providers} provider(s), ` +
        `${applied.secretsReEncrypted.telegramAccounts} telegram account(s), ` +
        `${applied.secretsReEncrypted.githubTokens} github token(s)`,
    );
    if (applied.envFile) {
      console.log(
        applied.envFile.ok
          ? `Environment file written: ${applied.envFile.path}`
          : `⚠ Could not write ${applied.envFile.path}: ${applied.envFile.error}`,
      );
    }
    for (const warning of applied.warnings) console.log(`· ${warning}`);
  } else {
    console.log("No credential bundle in this snapshot — API keys must come from this server's environment.");
  }
  console.log("\nStart the platform now: npm start   (or: node dist/index.js)");
  return 0;
}

async function listBackups(options: CliOptions): Promise<number> {
  const dir = resolveLocalBackupDir(getDb(), options.localDir);
  const entries = await listLocalBackups(dir, 200);
  console.log(`Local backups in ${dir}: ${entries.length}`);
  for (const entry of entries) {
    console.log(
      `  ${entry.latest ? "*" : " "} ${entry.id}  records=${entry.records} jobs=${entry.jobs} kv=${entry.kv}` +
        ` ${entry.secretsEncrypted ? "secrets=encrypted" : entry.secrets ? "secrets=plaintext" : "secrets=none"}`,
    );
  }
  return 0;
}

/** CLI entry point (exported so a test can drive it without a subprocess). */
export async function backupCli(argv: string[]): Promise<number> {
  const { command, positional, options } = parseArgs(argv);
  switch (command) {
    case "export":
      return await exportBackup(options);
    case "restore":
      return await restoreBackup(positional, options);
    case "list":
      return await listBackups(options);
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command "${command}"\n`);
      console.log(USAGE);
      return 1;
  }
}

const selfPath = fileURLToPath(import.meta.url);
const invokedDirectly =
  !!process.argv[1] && [selfPath, selfPath.replace(/\.ts$/, ".js")].includes(resolve(process.argv[1]));

if (invokedDirectly) {
  backupCli(process.argv.slice(2))
    .then((code) => {
      // Flush SQLite's WAL files before exiting.
      try {
        getDb().close();
      } catch {
        /* nothing open */
      }
      process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
