#!/usr/bin/env node
/**
 * CodeVia — Plaintext Secrets Export
 * ===================================
 *
 * Exports a full runtime backup with every encrypted secret decrypted to
 * plaintext, so the resulting JSON can be moved to a different host (e.g. an
 * AI agent sandbox) without needing the same AUTH_SECRET to read it back.
 *
 * Run this on the production / source host:
 *   AUTH_SECRET="..." node scripts/export-plaintext.mjs > backup-plaintext.json
 *
 * The script:
 *   1. Opens the same SQLite DB the platform uses (DATABASE_PATH).
 *   2. Reads every row from `records`, `jobs`, `kv`.
 *   3. For each `provider` record, replaces `secretValueEnc` with `secretValue`
 *      (decrypted) when AUTH_SECRET is available.
 *   4. For each `telegram_account` record, replaces `tokenEnc` with `token`
 *      (decrypted).
 *   5. For each `github_user` (or any record with `accessTokenEnc` /
 *      `refreshTokenEnc`), replaces those with plaintext `accessToken` /
 *      `refreshToken`.
 *   6. Keeps the original `*Enc` field for traceability (so you can still
 *      see what was originally encrypted).
 *
 * The output IS sensitive — handle accordingly. Do not paste it into a
 * public channel; this script is meant to be piped to a file you control.
 */
import { DatabaseSync } from "node:sqlite";
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync } from "node:fs";

const DB_PATH = process.env.DATABASE_PATH ?? "./data/codevia.db";
const AUTH_SECRET = process.env.AUTH_SECRET;
const OUT_PATH = process.argv[2] ?? "-"; // "-" = stdout

if (!existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`);
  process.exit(1);
}

const keyFor = (context) =>
  createHash("sha256")
    .update(`${AUTH_SECRET ?? ""}:${context}`)
    .digest();

function decrypt(rec, context) {
  if (!rec) return undefined;
  let parsed = rec;
  if (typeof rec === "string") {
    try {
      parsed = JSON.parse(rec);
    } catch {
      return undefined;
    }
  }
  if (!parsed || parsed.v !== 1 || !AUTH_SECRET) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(context), Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parsed.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

const db = new DatabaseSync(DB_PATH);

const recordRows = db.prepare("SELECT * FROM records ORDER BY created_at ASC").all();
const jobRows = db.prepare("SELECT * FROM jobs ORDER BY created_at ASC").all();
const kvRows = db.prepare("SELECT * FROM kv ORDER BY key ASC").all();

const records = recordRows.map((r) => {
  let data;
  try {
    data = JSON.parse(r.data);
  } catch {
    data = r.data;
  }
  if (!data || typeof data !== "object")
    return {
      id: r.id,
      type: r.type,
      projectId: r.project_id,
      parentId: r.parent_id,
      key: r.key,
      data,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };

  // Decrypt known secret fields per record type
  if (r.type === "provider" && data.secretValueEnc) {
    const plain = decrypt(data.secretValueEnc, "provider-secret");
    if (plain !== undefined) {
      data.secretValue = plain;
      data._originalSecretValueEnc = data.secretValueEnc; // keep for traceability
    }
  }
  if (r.type === "telegram_account" && data.tokenEnc) {
    const plain = decrypt(data.tokenEnc, "telegram-token");
    if (plain !== undefined) {
      data.token = plain;
      data._originalTokenEnc = data.tokenEnc;
    }
  }
  if (data.accessTokenEnc) {
    const plain = decrypt(data.accessTokenEnc, "github-token");
    if (plain !== undefined) {
      data.accessToken = plain;
      data._originalAccessTokenEnc = data.accessTokenEnc;
    }
  }
  if (data.refreshTokenEnc) {
    const plain = decrypt(data.refreshTokenEnc, "github-token");
    if (plain !== undefined) {
      data.refreshToken = plain;
      data._originalRefreshTokenEnc = data.refreshTokenEnc;
    }
  }

  return {
    id: r.id,
    type: r.type,
    projectId: r.project_id,
    parentId: r.parent_id,
    key: r.key,
    data,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
});

const jobs = jobRows.map((j) => {
  let payload;
  try {
    payload = JSON.parse(j.payload);
  } catch {
    payload = j.payload;
  }
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    payload,
    attempts: Number(j.attempts),
    maxAttempts: Number(j.max_attempts),
    correlationId: j.correlation_id ?? undefined,
    scheduledAt: j.scheduled_at ?? undefined,
    startedAt: j.started_at ?? undefined,
    finishedAt: j.finished_at ?? undefined,
    error: j.error ?? undefined,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
});

const kv = kvRows.map((k) => {
  let value;
  try {
    value = JSON.parse(k.value);
  } catch {
    value = k.value;
  }
  // Decrypt any encrypted values in KV (e.g. session tokens)
  if (value && typeof value === "object") {
    for (const f of ["accessTokenEnc", "refreshTokenEnc", "tokenEnc", "secretValueEnc"]) {
      if (value[f]) {
        const plain = decrypt(
          value[f],
          f === "tokenEnc" ? "telegram-token" : f === "secretValueEnc" ? "provider-secret" : "github-token",
        );
        if (plain !== undefined) {
          value[f.replace("Enc", "")] = plain;
        }
      }
    }
  }
  return { key: k.key, value, updatedAt: k.updated_at };
});

const snapshot = {
  type: "codevia-runtime-backup-plaintext",
  version: 1,
  createdAt: new Date().toISOString(),
  databasePath: DB_PATH,
  authSecretPresent: !!AUTH_SECRET,
  note: AUTH_SECRET
    ? "Secrets decrypted with the provided AUTH_SECRET. The original encrypted values are kept as _original*Enc fields for traceability."
    : "AUTH_SECRET not provided — secretValueEnc / tokenEnc / accessTokenEnc left as-is (no plaintext available).",
  summary: { records: records.length, jobs: jobs.length, kv: kv.length, bytes: 0 },
  records,
  jobs,
  kv,
};

snapshot.summary.bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");

if (OUT_PATH === "-") {
  process.stdout.write(JSON.stringify(snapshot, null, 2));
} else {
  const fs = await import("node:fs");
  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.error(
    `Wrote ${OUT_PATH} (${snapshot.summary.bytes} bytes; ${records.length} records, ${jobs.length} jobs, ${kv.length} kv)`,
  );
}
