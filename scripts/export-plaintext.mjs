#!/usr/bin/env node
/**
 * CodeVia — Plaintext Secrets Export (legacy entry point)
 * ========================================================
 *
 * This used to be a standalone re-implementation of the backup export. It is now
 * a thin launcher around the real one (`src/backup/cli.ts`, compiled to
 * `dist/backup/cli.js`), so there is a single code path and — importantly — the
 * file it produces is a standard `codevia-runtime-backup` snapshot that the
 * platform can restore (Settings → Restore backup file, `POST /admin/backup/restore`,
 * or `npm run backup:restore`). The old format was rejected by the restore
 * validator, which made the "move to another host" script a dead end.
 *
 * Usage (unchanged):
 *   AUTH_SECRET="..." node scripts/export-plaintext.mjs > backup.json
 *   AUTH_SECRET="..." node scripts/export-plaintext.mjs backup.json
 *
 * The output contains live API keys and tokens in plaintext, plus the whole
 * environment of this installation. Treat it like a credential: keep it off
 * shared storage and out of Git. To store a protected copy instead, pass a
 * passphrase and the bundle is encrypted with it:
 *
 *   BACKUP_PASSPHRASE="..." node scripts/export-plaintext.mjs backup.enc.json
 *
 * Prefer the platform's own backup when the server is running — Admin →
 * System Backup writes to GitHub and to the volume on a schedule, and the
 * Settings page has a one-click download. See docs/SYSTEM_BACKUP.md.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = resolve(ROOT, "dist/backup/cli.js");
const source = resolve(ROOT, "src/backup/cli.ts");

const args = ["export"];
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
if (positional[0] && positional[0] !== "-") args.push("--out", positional[0]);
// Forward any extra flags (--no-secrets, --passphrase P, …) untouched.
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--") || arg === "--out" || arg === "-o") continue;
  args.push(arg);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("-") && arg !== "--no-secrets") {
    args.push(next);
    i++;
  }
}

const command = existsSync(compiled)
  ? { file: process.execPath, args: [compiled, ...args] }
  : { file: "npx", args: ["tsx", source, ...args] };

const result = spawnSync(command.file, command.args, { cwd: ROOT, stdio: "inherit" });
if (result.error) {
  console.error(`Could not run the backup CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
