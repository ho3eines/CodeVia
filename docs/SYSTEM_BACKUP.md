# System Backup — a complete, portable copy of the installation

> **خلاصهٔ فارسی:** دکمهٔ **⬇ Full system backup (JSON)** در `Settings` (و در `Admin → System Backup`) یک فایل
> JSON می‌سازد و دانلود می‌کند که **همه‌چیز** در آن است: تمام ردیف‌های دیتابیس (پروژه‌ها، ایجنت‌ها، مدل‌ها،
> پرووایدرها، ورک‌فلوها، تسک/ران‌ها، کانورسیشن‌ها، مموری، کاربران، تلگرام، لاگ‌ها، همهٔ تنظیمات) **به‌همراه
> کلیدهای API و توکن‌ها و کل متغیرهای محیطی**. روی سرور جدید همان فایل را با **⬆ Restore backup file(s)**
> آپلود کنید — یا اگر هنوز نمی‌توانید وارد شوید، `npm run backup:restore -- backup.json` را بزنید. کلیدها با
> `AUTH_SECRET` سرور جدید دوباره رمز می‌شوند و متغیرهای محیطی در `<مسیر دیتابیس>/.env` نوشته می‌شوند، پس بعد از
> restart هم باقی می‌مانند.

CodeVia runs on Railway/Docker where the container filesystem is **ephemeral**: every
deploy starts from a fresh image and the SQLite runtime store at `DATABASE_PATH` is
wiped. A backup therefore has to answer two questions, not one:

1. *What was in the database?* — projects, agents, models, providers, skills,
   workflows, tasks/runs, conversations, memory, users, Telegram accounts, audit
   log, cost records, notifications and every kv setting.
2. *What made it work?* — the API keys and tokens, and the environment they were
   read from. Without this half, a restore on another machine brings back a
   platform whose providers, bots and GitHub connections are all dead.

Both halves are captured in one snapshot.

---

## 1. What is included

| Part | Content | Where it comes from |
|------|---------|---------------------|
| `records` | every entity row (projects, agents, models, providers, skills, workflows, tasks, runs, conversations, memory, users, Telegram accounts, audit, cost, notifications…) | SQLite `records` |
| `jobs` | the whole queue (pending/running/finished/dead-letter) | SQLite `jobs` |
| `kv` | every setting, including admin GitHub login settings and per-user GitHub tokens | SQLite `kv` |
| `environment.env` | every variable of the platform contract that was set (`OPENAI_API_KEY`, `GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, `AUTH_SECRET`, routing policy, URLs, …) plus each provider's custom `secretRef` name | `process.env` |
| `environment.dbSecrets` | provider API keys, Telegram bot tokens and per-user GitHub OAuth tokens — **decrypted** | AES-GCM fields in `records`/`kv` |

### Credentials are plaintext by default — on purpose

A stored ciphertext is only readable with the `AUTH_SECRET` that produced it, so
copying it to another server restores *unreadable* keys. The backup therefore
carries the values themselves and the restore re-encrypts them with the **target
server's** `AUTH_SECRET`.

That makes a backup file equivalent to a key ring:

- The file an admin **downloads** is always plaintext — it is a direct response to
  an explicit admin action, and it is what makes "restore this on another server"
  a one-click operation.
- Copies **stored** by the platform (GitHub repository, local volume) are
  encrypted with `BACKUP_PASSPHRASE` when that variable is set
  (`secrets.enc.json`, scrypt + AES-256-GCM). Without a passphrase they are
  written as `secrets.json` in plaintext — keep the backup repository private.
- A bundle that carries only non-secret configuration is named
  `environment.json` so it is never mistaken for a credential file.
- Local files are written with mode `0600`.
- Set `BACKUP_INCLUDE_SECRETS=false` (or uncheck **Include API keys & tokens** in
  Admin → System Backup) to go back to a database-only backup. Then a restore on
  a server with a different `AUTH_SECRET` recovers the data but not the keys.

Nothing secret is ever written to a log, an audit record or an API response
except the download itself: the UI, `/admin/backup`, `/admin/backup/run` and the
audit log only ever report **counts, variable names and masks**
(`sk-L••••••••c123`).

---

## 2. Where backups are written

Every run writes to both destinations that are enabled:

| Destination | Default | Notes |
|-------------|---------|-------|
| **GitHub repository** | `.codevia/backups/<ISO-timestamp>/` in `repo`/`branch` from Admin → System Backup | Off-machine copy; split into hashed JSON parts below GitHub's 1 MiB small-file limit |
| **Local volume** | `<dirname(DATABASE_PATH)>/backups/<ISO-timestamp>/` | Always available, no network needed; also holds a single self-contained `snapshot.json`; pruned to `retain` (default 30) |

A run with no GitHub repository configured is **not** a failure: the local copy is
written and the result says so (`"written to disk only"`).

```
<backup-path>/
├── latest.json           # pointer to the most recent snapshot (+ what it can restore)
└── <ISO-timestamp>/
    ├── manifest.json     # summary, counts, per-file SHA-256 and part list
    ├── records.json      # or records-0001.json, records-0002.json, …
    ├── jobs.json         # or jobs-0001.json, …
    ├── kv.json           # or kv-0001.json, …
    ├── secrets.json      # environment + credentials (secrets.enc.json with a passphrase,
    │                     # environment.json when no credential was captured)
    ├── README.md         # human-readable summary, incl. the plaintext warning
    └── snapshot.json     # local copies only: the whole snapshot in one file
```

Restore verifies every part's SHA-256 and the manifest counts **before** opening
the database transaction, so a missing, truncated or edited file can never
silently produce a half-restored server — including a half-configured one.

---

## 3. Taking a backup

**UI**

- `Settings → Backup & Import/Export → ⬇ Full system backup (JSON)` — creates the
  file and downloads it immediately. This is the "take everything with me" button.
- `Admin → System Backup → ▶ Run backup now` — writes to GitHub and/or the volume
  without downloading.
- `Admin → System Backup → 📋 List backups` — every snapshot from both
  destinations, newest first, each marked `github`/`local` and 🔑 (keys included /
  encrypted / none), with per-entry **Restore** and **⬇** download.

**Schedule** — a classic five-field cron (`minute hour day-of-month month day-of-week`):

| Cron | Meaning |
|------|---------|
| `* * * * *` | every minute |
| `*/5 * * * *` | every 5 minutes |
| `0 * * * *` | every hour on the hour (default) |
| `30 3 * * *` | every day at 03:30 |
| `0 0 * * 1` | every Monday at midnight |

The scheduler polls every ~15 s and runs only when the minute matches and no
backup has already run in that minute. For a real repository the platform needs an
active GitHub credential (`GITHUB_TOKEN` + `GITHUB_ENABLED=true`, or the OAuth
token of the account that configured the backup).

**CLI** (no server needed — useful when the app will not start)

```bash
npm run backup            # → data/codevia-backup.json
npm run backup:export -- --out /secure/place/backup.json
npm run backup:list
BACKUP_PASSPHRASE="…" npm run backup:export -- --out backup.enc.json   # encrypted bundle
```

---

## 4. Restoring — bringing the same installation up on another server

### A. From the UI (the platform is running and you can sign in)

1. `Settings → Backup & Import/Export → ⬆ Restore backup file(s)` and pick the
   downloaded JSON (or every JSON file of one snapshot directory, including
   `secrets.json`).
2. Confirm. The restore replaces the runtime tables, then:
   - fills in the environment variables this server does not already have,
   - re-encrypts every credential with **this** server's `AUTH_SECRET`,
   - writes the effective environment to `<dirname(DATABASE_PATH)>/.env`.
3. The response reports exactly what came back, e.g.
   `Restored 4 environment value(s) and re-encrypted 3 credential(s) · wrote /app/data/.env`.
   Caches are rebuilt and Telegram pollers re-synced in the same request — no
   restart needed for providers, models, projects or per-user bots.

`Admin → System Backup → ↺ Restore latest` does the same from the newest GitHub
snapshot, and each row of **List backups** can restore that one entry (local
snapshots included, which is how you recover when GitHub is unreachable).

### B. From the CLI (a brand-new server, before the first start)

A fresh machine has an empty database, so there is nobody to sign in as — and with
`REQUIRE_AUTH=true` every API call answers 401. The CLI removes that chicken-and-egg:

```bash
git clone <your fork> && cd CodeVia
npm ci && npm run build
npm run backup:restore -- /path/to/codevia-full-backup.json   # or: -- --local
npm start
```

`npm start` then reads `<dirname(DATABASE_PATH)>/.env` at boot, so the restored
keys are still there after the first restart. Useful flags:

| Flag | Effect |
|------|--------|
| `--dry-run` | validate the file and print what it contains (masked); write nothing |
| `--passphrase P` | unlock a bundle stored as `secrets.enc.json` |
| `--overwrite-env` | let backup values replace variables this server already has |
| `--no-env-file` | restore the database and credentials without writing `.env` |
| `--no-secrets` | (export) leave every credential out of the file |

### Precedence — what wins when both sides have a value

| Variable | On restore | At boot |
|----------|-----------|---------|
| Deployment-local: `DATABASE_PATH`, `HOST`, `PORT`, `NODE_ENV`, `LOG_LEVEL`, `DATA_DIR`, `REPO_MIRROR_DIR`, `BACKUP_LOCAL_DIR` | never taken from the backup (reported as `hostBound`) | platform value, else `.env` |
| Everything else, already set on this server | kept (reported as `envKept`) | platform value wins |
| Everything else, not set here | applied from the backup (reported as `envApplied`) | read from `.env` |

So a Railway service keeps its own `PORT`/volume path and its own explicitly-set
variables, while a bare VPS gets the whole configuration from the backup.

> **Telegram server bot:** `TELEGRAM_BOT_TOKEN` is read once when the container is
> built. A restore applies it to the process and writes it to `.env`, and per-user
> bots are re-synced immediately, but the *server-level* bot starts on the next
> restart.

---

## 5. API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/backup` | Config + status + GitHub/storage readiness + what the next snapshot will carry (`secrets`, `local`) |
| PUT | `/admin/backup` | Save config: `enabled`, `repo`, `branch`, `path`, `schedule`, `retain`, `includeEnv`, `includeSecrets`, `localCopy`, `localDir` |
| POST | `/admin/backup/run` | Take a snapshot now (GitHub + local copy) |
| GET | `/admin/backup/list` | List snapshots; `?source=github\|local`, `?limit=` |
| GET | `/admin/backup/export` | The current full snapshot as inline JSON |
| GET | `/admin/backup/download` | The same as an **attachment** (`codevia-full-backup-<ts>.json`, `Cache-Control: no-store`) |
| GET | `/admin/backup/local/:id/download` | Download one snapshot stored on this machine |
| POST | `/admin/backup/restore` | Restore from GitHub (`{snapshot?}`), from a local snapshot (`{source:"local", snapshot?}`), from a full JSON body (`{snapshotData}` or the raw snapshot), or from selected parts (`{snapshotFiles:[{path,content}]}`). Optional: `replace`, `passphrase`, `overwriteEnv`, `repo`, `branch`, `path`. Uploads are limited to 128 MiB |

All of them are owner/admin only. A successful restore answers with an
`environment` report (`envApplied`, `envKept`, `hostBound`, `providers`,
`telegramAccounts`, `githubTokens`, `envFile`) — names and counts, never values.

---

## 6. Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `BACKUP_INCLUDE_ENV` | `true` | capture the environment contract into every backup |
| `BACKUP_INCLUDE_SECRETS` | `true` | capture API keys/tokens (plaintext) so a restore works on any server |
| `BACKUP_LOCAL_COPY` | `true` | also write each snapshot next to the database |
| `BACKUP_LOCAL_DIR` | `<dirname(DATABASE_PATH)>/backups` | where local copies go |
| `BACKUP_LOCAL_RETAIN` | `30` | how many local snapshots to keep |
| `BACKUP_PASSPHRASE` | unset | encrypt the **stored** bundle; required again to restore it |
| `BACKUP_EXTRA_ENV` | unset | comma-separated extra variable names to capture |

Each of these (except the passphrase and `retain`) is also an admin-panel switch,
which wins over the environment. `BACKUP_PASSPHRASE` is deliberately never stored
in the database and never captured into a backup.

---

## 7. Verification

```bash
npm test                                     # includes src/tests/backup-secrets.test.ts (15 tests)
                                             # and src/tests/env-file.test.ts (9 tests)
```

Covered explicitly: capture of environment keys and all three credential kinds;
restore under a **different `AUTH_SECRET`**; custom provider `secretRef` names;
`.env` written and re-read at boot; platform variables never overridden;
host-bound variables never imported; hashed round-trip through the stored file
layout; passphrase encryption (and refusal without it); `includeSecrets=false`
leaving no credential anywhere; local copy without GitHub; retention pruning;
merged GitHub+local listing; the download endpoint; the CLI export/restore loop.
