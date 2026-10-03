import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { Db } from "../db/client.js";
import { ENV_CONTRACT_KEYS, getEnv, getEnvFresh } from "../config/env.js";
import { renderEnvFile, writeEnvFile } from "../config/env-file.js";
import { decryptSecret, encryptSecret, maskSecret } from "../auth/encrypted-secrets.js";
import { GITHUB_TOKEN_KV_PREFIX, decryptToken, encryptToken } from "../auth/github-tokens.js";
import { getAuthSecret } from "../auth/github-oauth.js";

/* ------------------------------------------------------------------ *
 * Portable environment + credential bundle.
 *
 * A database snapshot alone cannot rebuild an installation on a *different*
 * server:
 *
 *   1. API keys that only ever lived in the environment (OPENAI_API_KEY,
 *      GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, …) are not in any table.
 *   2. Secrets that ARE in tables (provider keys, Telegram bot tokens,
 *      per-user GitHub OAuth tokens) are stored AES-GCM encrypted with a key
 *      derived from AUTH_SECRET — so on a server with another AUTH_SECRET they
 *      come back unreadable and every integration silently dies.
 *
 * This module captures both, in plaintext, as one bundle that travels inside
 * the backup. On restore the bundle is applied to the new server: environment
 * variables are filled in, a `.env` file is written next to the database so a
 * restart keeps them, and every database secret is **re-encrypted with the
 * restoring server's AUTH_SECRET** so it is readable again immediately.
 *
 * ⚠ The bundle contains live credentials. Treat a backup file like a key:
 *   - the copy an admin downloads is plaintext by design;
 *   - copies stored in the backup repo / on the volume are encrypted when
 *     BACKUP_PASSPHRASE is set (`secrets.enc.json` instead of `secrets.json`).
 * ------------------------------------------------------------------ */

export const ENVIRONMENT_BUNDLE_VERSION = 1;

/** Environment variables that carry a credential. */
export const SECRET_ENV_KEYS: readonly string[] = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "AUTH_SECRET",
];

/**
 * Deployment-local variables. They are captured (so the `.env` file describes
 * the source installation) but never injected into a *running* process: the new
 * host decides its own port, database location and log level.
 */
export const HOST_BOUND_ENV_KEYS: readonly string[] = [
  "DATABASE_PATH",
  "HOST",
  "PORT",
  "NODE_ENV",
  "LOG_LEVEL",
  "DATA_DIR",
  "REPO_MIRROR_DIR",
  "BACKUP_LOCAL_DIR",
];

/** Variables read straight from `process.env` (outside the zod contract). */
const EXTRA_KNOWN_ENV_KEYS: readonly string[] = [
  "CODEVIA_HTTP_LOG",
  "GITHUB_API_BASE_URL",
  "MOCK_GITHUB_PATH",
  "REPO_BRIEF_TTL_MS",
  "REPO_MIRROR_ENABLED",
  "REPO_MIRROR_GIT_PATH",
  "REPO_MIRROR_MAX_FILES",
  "REPO_MIRROR_MAX_MB",
  "REPO_MIRROR_MAX_READ_BYTES",
  "REPO_MIRROR_MAX_SEARCH_HITS",
  "REPO_MIRROR_READ_TIMEOUT_MS",
  "REPO_MIRROR_REFRESH_MS",
  "REPO_MIRROR_TIMEOUT_MS",
  "REPO_MIRROR_URL_TEMPLATE",
  "SECURITY_HEADERS",
  "STATE_COMMIT_SKIP_CI",
];

/** Never captured — the passphrase protects the bundle it would sit inside. */
const NEVER_CAPTURE: readonly string[] = ["BACKUP_PASSPHRASE"];

/** Runtime/test noise that must never enter a portable backup. */
const NEVER_RESTORE: readonly string[] = [...NEVER_CAPTURE, "VITEST", "CODEVIA_HTTP_LOG"];

export type DbSecretKind = "provider" | "telegram-account" | "github-user-token";

export interface DbSecret {
  kind: DbSecretKind;
  /** Record id, or the platform user id for a kv-stored GitHub token. */
  id: string;
  /** Plaintext credential. */
  value: string;
  /** Non-secret display name (provider name, bot username, GitHub login). */
  label?: string;
  /** Extra fields needed to rebuild a kv token record. */
  meta?: { scopes?: string[]; login?: string; updatedAt?: string };
}

export interface EnvironmentBundle {
  version: number;
  exportedAt: string;
  /** True when the exporting server allowed plaintext credentials in backups. */
  plaintextSecrets: boolean;
  /** sha256(AUTH_SECRET) prefix — tells an operator whether keys were re-wrapped. */
  authSecretFingerprint?: string;
  source?: { hostname?: string; platform?: string; databasePath?: string; nodeEnv?: string };
  /** Every captured environment variable, credentials included. */
  env: Record<string, string>;
  /** Names of credential-carrying variables present in `env`. */
  secretKeys: string[];
  /** Database secrets, decrypted for transport and re-encrypted on restore. */
  dbSecrets: DbSecret[];
}

export interface EncryptedBundle {
  v: 1;
  type: "codevia-backup-secrets";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ct: string;
  /** Non-secret description, so a restore can say what it is about to unlock. */
  summary?: BundleSummary;
}

export interface BundleSummary {
  envKeys: number;
  secretKeys: string[];
  dbSecrets: number;
  providers: number;
  telegramAccounts: number;
  githubTokens: number;
  /** Masked preview of the captured credentials (never a usable value). */
  masked: Record<string, string>;
}

export interface CollectOptions {
  includeEnv?: boolean;
  includeSecrets?: boolean;
  /** Extra variable names to capture (BACKUP_EXTRA_ENV). */
  extraKeys?: string[];
  platform?: string;
}

export interface ApplyOptions {
  /** Overwrite variables this server already has set (default: keep them). */
  overwriteEnv?: boolean;
  /** Where to persist the effective environment (default: `<db dir>/.env`). */
  envFilePath?: string;
  /** Skip writing the `.env` file entirely. */
  skipEnvFile?: boolean;
}

export interface ApplyResult {
  /** Variables newly set from the backup. */
  envApplied: string[];
  /** Variables this server already had (backup value not applied). */
  envKept: string[];
  /** Captured but deployment-local — recorded in `.env`, not injected. */
  hostBound: string[];
  authSecretApplied: boolean;
  secretsReEncrypted: { providers: number; telegramAccounts: number; githubTokens: number };
  /** Bundle secrets that had no matching row after the restore. */
  secretsSkipped: number;
  envFile?: { ok: boolean; path: string; error?: string };
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Drop `undefined`-valued keys. A snapshot is validated as strict JSON before it
 * is written, and `JSON.stringify` would silently omit these anyway — keeping
 * them out makes the stored bundle byte-identical to the in-memory one.
 */
function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as T;
}

function fingerprintSecret(secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

/** AUTH_SECRET is required in production; a backup must never crash on it. */
function currentAuthSecret(): string | undefined {
  try {
    return getAuthSecret();
  } catch {
    return undefined;
  }
}

/** Every variable name a backup should look at. */
export function capturedEnvKeys(db?: Db, extraKeys: string[] = []): string[] {
  const keys = new Set<string>([...ENV_CONTRACT_KEYS, ...EXTRA_KNOWN_ENV_KEYS, ...extraKeys]);
  // A provider may reference a custom variable name (secretRef) — capture it too,
  // otherwise a restored server has the provider row but not its key.
  if (db) {
    try {
      const rows = db.all<{ data: string }>("SELECT data FROM records WHERE type = 'provider'");
      for (const row of rows) {
        const data = safeParse(row.data);
        const ref = isObject(data) && typeof data.secretRef === "string" ? data.secretRef.trim() : "";
        if (ref && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) keys.add(ref);
      }
    } catch {
      /* a provider scan is an optimisation, never a blocker */
    }
  }
  for (const key of NEVER_CAPTURE) keys.delete(key);
  return [...keys].sort();
}

function safeParse(raw: string | undefined | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function secretKeyNames(env: Record<string, string>, dbSecrets: DbSecret[]): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(env)) {
    if (SECRET_ENV_KEYS.includes(key) || /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY)$/.test(key)) names.add(key);
  }
  if (dbSecrets.length) names.add("DATABASE_SECRETS");
  return [...names].sort();
}

/** Build the bundle that makes a backup self-sufficient on another server. */
export function collectEnvironmentBundle(db: Db, options: CollectOptions = {}): EnvironmentBundle {
  const env = getEnv();
  const includeEnv = options.includeEnv ?? env.BACKUP_INCLUDE_ENV;
  const includeSecrets = options.includeSecrets ?? env.BACKUP_INCLUDE_SECRETS;
  const extraKeys = (options.extraKeys ?? [])
    .concat(
      (env.BACKUP_EXTRA_ENV ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .filter(Boolean);

  const captured: Record<string, string> = {};
  if (includeEnv) {
    for (const key of capturedEnvKeys(db, extraKeys)) {
      const value = process.env[key];
      if (value === undefined || value === "") continue;
      if (!includeSecrets && isSecretEnvKey(key)) continue;
      captured[key] = value;
    }
  } else if (includeSecrets) {
    // Environment config is not captured, but the credentials still are — that
    // is the combination that keeps a restore working without copying the whole
    // deployment configuration.
    for (const key of SECRET_ENV_KEYS) {
      const value = process.env[key];
      if (value) captured[key] = value;
    }
  }

  const dbSecrets = includeSecrets ? collectDbSecrets(db) : [];
  return compact({
    version: ENVIRONMENT_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    plaintextSecrets: includeSecrets,
    authSecretFingerprint: includeSecrets ? fingerprintSecret(currentAuthSecret()) : undefined,
    source: compact({
      hostname: hostname(),
      platform: options.platform,
      databasePath: env.DATABASE_PATH,
      nodeEnv: env.NODE_ENV,
    }),
    env: captured,
    secretKeys: secretKeyNames(captured, dbSecrets),
    dbSecrets,
  });
}

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEYS.includes(key) || /(?:_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(key);
}

/** Decrypt every credential the runtime store holds, for transport. */
export function collectDbSecrets(db: Db): DbSecret[] {
  const out: DbSecret[] = [];
  const providers = db.all<{ id: string; data: string }>("SELECT id, data FROM records WHERE type = 'provider'");
  for (const row of providers) {
    const data = safeParse(row.data);
    if (!isObject(data) || typeof data.secretValueEnc !== "string") continue;
    const value = decryptSecret(data.secretValueEnc, "provider-secret");
    if (!value) continue;
    out.push(
      compact({
        kind: "provider" as const,
        id: row.id,
        value,
        label: typeof data.name === "string" ? data.name : undefined,
      }),
    );
  }

  const accounts = db.all<{ id: string; data: string }>("SELECT id, data FROM records WHERE type = 'telegram-account'");
  for (const row of accounts) {
    const data = safeParse(row.data);
    if (!isObject(data) || typeof data.tokenEnc !== "string") continue;
    const value = decryptSecret(data.tokenEnc, "telegram-token");
    if (!value) continue;
    out.push(
      compact({
        kind: "telegram-account" as const,
        id: row.id,
        value,
        label: typeof data.botUsername === "string" ? data.botUsername : (data.name as string | undefined),
      }),
    );
  }

  const tokens = db.all<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE :prefix", {
    prefix: `${GITHUB_TOKEN_KV_PREFIX}%`,
  });
  for (const row of tokens) {
    const record = safeParse(row.value);
    if (!isObject(record)) continue;
    const rec = record as { iv?: unknown; tag?: unknown; ct?: unknown; scopes?: unknown; login?: unknown };
    if (typeof rec.iv !== "string" || typeof rec.tag !== "string" || typeof rec.ct !== "string") continue;
    const value = decryptToken({ iv: rec.iv, tag: rec.tag, ct: rec.ct });
    if (!value) continue;
    out.push(
      compact({
        kind: "github-user-token" as const,
        id: row.key.slice(GITHUB_TOKEN_KV_PREFIX.length),
        value,
        label: typeof rec.login === "string" ? rec.login : undefined,
        meta: compact({
          scopes: Array.isArray(rec.scopes) ? rec.scopes.filter((s): s is string => typeof s === "string") : [],
          login: typeof rec.login === "string" ? rec.login : undefined,
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
        }),
      }),
    );
  }
  return out;
}

/** Non-secret description of a bundle — safe for API responses and the UI. */
export function describeEnvironmentBundle(bundle: EnvironmentBundle | undefined): BundleSummary | undefined {
  if (!bundle) return undefined;
  const providers = bundle.dbSecrets.filter((s) => s.kind === "provider").length;
  const telegramAccounts = bundle.dbSecrets.filter((s) => s.kind === "telegram-account").length;
  const githubTokens = bundle.dbSecrets.filter((s) => s.kind === "github-user-token").length;
  const masked: Record<string, string> = {};
  for (const key of Object.keys(bundle.env)) {
    if (isSecretEnvKey(key)) masked[key] = maskSecret(bundle.env[key]);
  }
  for (const secret of bundle.dbSecrets)
    masked[`${secret.kind}:${secret.label ?? secret.id}`] = maskSecret(secret.value);
  return {
    envKeys: Object.keys(bundle.env).length,
    secretKeys: bundle.secretKeys,
    dbSecrets: bundle.dbSecrets.length,
    providers,
    telegramAccounts,
    githubTokens,
    masked,
  };
}

/** Validate a loose bundle object (from a backup file) into a strict one. */
export function normalizeEnvironmentBundle(input: unknown): EnvironmentBundle | undefined {
  if (!isObject(input)) return undefined;
  const env: Record<string, string> = {};
  if (isObject(input.env)) {
    for (const [key, value] of Object.entries(input.env)) {
      if (NEVER_CAPTURE.includes(key)) continue;
      if (typeof value === "string") env[key] = value;
      else if (typeof value === "number" || typeof value === "boolean") env[key] = String(value);
    }
  }
  const dbSecrets: DbSecret[] = [];
  if (Array.isArray(input.dbSecrets)) {
    for (const raw of input.dbSecrets) {
      if (!isObject(raw)) continue;
      const kind = raw.kind;
      if (kind !== "provider" && kind !== "telegram-account" && kind !== "github-user-token") continue;
      if (typeof raw.id !== "string" || typeof raw.value !== "string" || !raw.value) continue;
      const meta = isObject(raw.meta) ? raw.meta : {};
      dbSecrets.push(
        compact({
          kind,
          id: raw.id,
          value: raw.value,
          label: typeof raw.label === "string" ? raw.label : undefined,
          meta: compact({
            scopes: Array.isArray(meta.scopes) ? meta.scopes.filter((s): s is string => typeof s === "string") : [],
            login: typeof meta.login === "string" ? meta.login : undefined,
            updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : undefined,
          }),
        }),
      );
    }
  }
  if (!Object.keys(env).length && !dbSecrets.length) return undefined;
  return compact({
    version: Number(input.version) || ENVIRONMENT_BUNDLE_VERSION,
    exportedAt: typeof input.exportedAt === "string" ? input.exportedAt : new Date().toISOString(),
    plaintextSecrets: input.plaintextSecrets !== false,
    authSecretFingerprint: typeof input.authSecretFingerprint === "string" ? input.authSecretFingerprint : undefined,
    source: isObject(input.source)
      ? compact({
          hostname: typeof input.source.hostname === "string" ? input.source.hostname : undefined,
          platform: typeof input.source.platform === "string" ? input.source.platform : undefined,
          databasePath: typeof input.source.databasePath === "string" ? input.source.databasePath : undefined,
          nodeEnv: typeof input.source.nodeEnv === "string" ? input.source.nodeEnv : undefined,
        })
      : undefined,
    env,
    secretKeys: Array.isArray(input.secretKeys)
      ? input.secretKeys.filter((k): k is string => typeof k === "string")
      : secretKeyNames(env, dbSecrets),
    dbSecrets,
  });
}

/* ------------------------- at-rest protection ------------------------- */

export function isEncryptedBundle(value: unknown): value is EncryptedBundle {
  return (
    isObject(value) &&
    value.type === "codevia-backup-secrets" &&
    typeof value.ct === "string" &&
    typeof value.iv === "string" &&
    typeof value.tag === "string" &&
    typeof value.salt === "string"
  );
}

function bundleKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/** Protect a stored bundle with BACKUP_PASSPHRASE (scrypt + AES-256-GCM). */
export function encryptEnvironmentBundle(bundle: EnvironmentBundle, passphrase: string): EncryptedBundle {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", bundleKey(passphrase, salt), iv);
  const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    type: "codevia-backup-secrets",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
    summary: describeEnvironmentBundle(bundle),
  };
}

/** Decrypt a stored bundle. Returns undefined when the passphrase is wrong. */
export function decryptEnvironmentBundle(
  encrypted: EncryptedBundle,
  passphrase: string | undefined,
): EnvironmentBundle | undefined {
  if (!passphrase) return undefined;
  try {
    const salt = Buffer.from(encrypted.salt, "base64");
    const decipher = createDecipheriv("aes-256-gcm", bundleKey(passphrase, salt), Buffer.from(encrypted.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.ct, "base64")), decipher.final()]).toString(
      "utf8",
    );
    return normalizeEnvironmentBundle(JSON.parse(plaintext) as unknown);
  } catch {
    return undefined;
  }
}

/* ------------------------------- restore ------------------------------- */

/** Default `.env` location: next to the database, i.e. on the persistent volume. */
export function envFileForDatabase(db: Db): string {
  return `${dirname(db.path)}/.env`;
}

/**
 * Apply a restored bundle to this server:
 *   1. fill in the environment (existing platform variables win by default),
 *   2. re-encrypt every database credential with THIS server's AUTH_SECRET,
 *   3. persist the effective environment to `<db dir>/.env` so it survives a restart.
 */
export function applyEnvironmentBundle(db: Db, bundle: EnvironmentBundle, options: ApplyOptions = {}): ApplyResult {
  const warnings: string[] = [];
  const overwrite = options.overwriteEnv ?? false;

  // AUTH_SECRET first: every database credential below is wrapped with it, and
  // the value written to `.env` must match what the process ends up using.
  const injected = new Set<string>();
  const kept: string[] = [];
  const hostBound: string[] = [];
  for (const key of Object.keys(bundle.env).sort()) {
    if (NEVER_RESTORE.includes(key)) continue;
    const value = bundle.env[key];
    if (HOST_BOUND_ENV_KEYS.includes(key)) {
      hostBound.push(key);
      continue;
    }
    const current = process.env[key];
    if (!overwrite && current !== undefined && current !== "") {
      kept.push(key);
      continue;
    }
    process.env[key] = value;
    injected.add(key);
  }
  // Re-read the zod contract so every consumer sees the restored values.
  getEnvFresh();
  const authSecretApplied = injected.has("AUTH_SECRET");

  const secretsReEncrypted = { providers: 0, telegramAccounts: 0, githubTokens: 0 };
  let secretsSkipped = 0;
  for (const secret of bundle.dbSecrets) {
    if (secret.kind === "github-user-token") {
      const wrapped = encryptToken(secret.value);
      const record = {
        v: 1 as const,
        ...wrapped,
        scopes: secret.meta?.scopes ?? [],
        login: secret.meta?.login,
        updatedAt: secret.meta?.updatedAt ?? new Date().toISOString(),
      };
      db.run(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (:key, :value, :updated_at)`, {
        key: GITHUB_TOKEN_KV_PREFIX + secret.id,
        value: JSON.stringify(record),
        updated_at: new Date().toISOString(),
      });
      secretsReEncrypted.githubTokens += 1;
      continue;
    }

    const field = secret.kind === "provider" ? "secretValueEnc" : "tokenEnc";
    const context = secret.kind === "provider" ? "provider-secret" : "telegram-token";
    const row = db.get<{ data: string }>("SELECT data FROM records WHERE id = :id", { id: secret.id });
    if (!row) {
      secretsSkipped += 1;
      continue;
    }
    const data = safeParse(row.data);
    if (!isObject(data)) {
      secretsSkipped += 1;
      continue;
    }
    data[field] = JSON.stringify(encryptSecret(secret.value, context));
    db.run("UPDATE records SET data = :data, updated_at = :updated_at WHERE id = :id", {
      id: secret.id,
      data: JSON.stringify(data),
      updated_at: new Date().toISOString(),
    });
    if (secret.kind === "provider") secretsReEncrypted.providers += 1;
    else secretsReEncrypted.telegramAccounts += 1;
  }

  // Write the environment this process now actually runs with, so a restart on
  // the new server keeps every restored key.
  let envFileResult: ApplyResult["envFile"];
  if (!options.skipEnvFile) {
    const envPath = options.envFilePath ?? envFileForDatabase(db);
    const effective: Record<string, string> = {};
    for (const key of Object.keys(bundle.env)) {
      if (NEVER_CAPTURE.includes(key)) continue;
      const live = process.env[key];
      effective[key] = live === undefined || live === "" ? bundle.env[key] : live;
    }
    const content = renderEnvFile(effective, {
      secretKeys: bundle.secretKeys.filter((key) => key !== "DATABASE_SECRETS"),
      header: [
        "# CodeVia environment — written by a full system backup restore.",
        `# Restored at ${new Date().toISOString()} from a backup created ${bundle.exportedAt}.`,
        "# Platform-provided variables always take precedence over this file.",
        "# This file contains live credentials — keep it out of Git and restrict access.",
      ],
    });
    envFileResult = writeEnvFile(envPath, content);
    if (!envFileResult.ok) {
      warnings.push(
        `Environment restored in memory, but ${envFileResult.path} could not be written: ${envFileResult.error}`,
      );
    }
  }

  if (bundle.plaintextSecrets && !bundle.dbSecrets.length && !Object.keys(bundle.env).length) {
    warnings.push("The backup carried no environment values or credentials to restore.");
  }
  if (authSecretApplied) {
    warnings.push(
      "AUTH_SECRET was restored from the backup, so existing login sessions on this server were invalidated.",
    );
  }

  return {
    envApplied: [...injected].sort(),
    envKept: kept.sort(),
    hostBound: hostBound.sort(),
    authSecretApplied,
    secretsReEncrypted,
    secretsSkipped,
    envFile: envFileResult,
    warnings,
  };
}
