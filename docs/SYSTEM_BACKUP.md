# System Backup (Railway → GitHub)

CodeVia runs on Railway/Docker where the container filesystem is **ephemeral**: every
deploy starts from a fresh image and the SQLite runtime store at `DATABASE_PATH` is
wiped. To make the platform survive redeploys, corruption, or a container loss, an
admin can configure a **full system backup** that pushes everything from the runtime
database into a dedicated GitHub repository.

The settings are admin-only (`owner` / `admin` role) and are stored in the runtime
`kv` store under `admin.settings.backup`. They are available from:

- **UI:** Admin → System Backup
- **API:** `/admin/backup` (see `docs/API.md`)

## What is included

Every backup is a full point-in-time snapshot of the database:

- **Users** and RBAC roles
- **Projects**, repositories, capabilities, settings
- **Agents** and their prompts/models/permissions
- **Providers** and **Models**
- **Skills**, **Workflows**, **Tasks**, **Runs**
- **Conversations** and **memory**
- **Telegram accounts** (tokens stay encrypted at rest)
- **Audit logs**, **cost records**, **notifications**
- Every **kv setting** (including admin GitHub login settings and per-user GitHub
  access tokens)

Secret values that the platform already encrypts (provider API keys, Telegram bot
tokens, GitHub user tokens) are stored in the snapshot in their **encrypted form
only** — the backup never decrypts them, so the existing `AUTH_SECRET` must be reused
after a restore to read them again.

## Repository layout

```
<backup-path>/
├── latest.json          # pointer to the most recent backup
└── <ISO-timestamp>/
    ├── manifest.json    # summary, counts, file hashes and part list
    ├── records.json     # or records-0001.json, records-0002.json, …
    ├── jobs.json        # or jobs-0001.json, …
    ├── kv.json          # or kv-0001.json, …
    └── README.md        # human-readable summary
```

Large tables are divided into JSON parts below GitHub's small-file limit. The
manifest contains each part's row count and SHA-256 hash. Restore verifies all
parts and manifest counts before opening the database transaction, so a missing,
truncated, or modified file cannot silently produce a partial restore.

Default path is `.codevia/backups`.

## Scheduling

The schedule is a classic **five-field cron**:

```
minute hour day-of-month month day-of-week
```

Examples:

| Cron                | Meaning                          |
|---------------------|----------------------------------|
| `* * * * *`         | every minute                     |
| `*/5 * * * *`       | every 5 minutes                  |
| `0 * * * *`         | every hour on the hour           |
| `30 3 * * *`        | every day at 03:30               |
| `0 0 * * 1`         | every Monday at midnight         |
| `0 */12 * * *`      | every 12 hours                   |

The scheduler polls every ~15 seconds and runs only when the current minute matches
and no backup has already run in that minute.

## Setup

1. Open **Admin → System Backup**.
2. Set the target repository (`owner/name`) and branch. The repository must be
   writable by the GitHub connection the platform uses.
3. Set the cron schedule and check **Enable scheduled backup**.
4. Click **Save settings**, then **Run backup now** to verify it works.

For a real repository the platform needs an active GitHub token (`GITHUB_TOKEN` +
`GITHUB_ENABLED=true`, or production mode). Otherwise the backup runs against the
in-memory **mock** GitHub and only works locally/tests.

## Restore

On a fresh Railway deploy (or after data loss):

1. Redeploy with the same GitHub credential (and, if encrypted secrets were stored,
   the same `AUTH_SECRET`).
2. Open **Admin → System Backup → List backups**.
3. Choose the snapshot (or click **Restore latest**).
4. The API validates every table part, restores `records`, `jobs` and `kv` in one
   transaction, then rebuilds provider/model caches and synchronizes Telegram
   account pollers.

You can also use **Export full snapshot** to download a standalone JSON file, then
select it with **Settings → Restore backup file(s)**. If you downloaded the
GitHub directory rather than the full JSON export, select every JSON file from
that one snapshot together (including `manifest.json`). The restore endpoint
accepts up to 128 MiB per upload. The older **Login settings only** export contains
only non-secret GitHub login configuration and cannot restore projects, run
history, users, or other runtime records.

## API

| Method | Endpoint                 | Description                                       |
|--------|--------------------------|---------------------------------------------------|
| GET    | `/admin/backup`          | Read current config + status + GitHub readiness   |
| PUT    | `/admin/backup`          | Save admin config                                  |
| POST   | `/admin/backup/run`      | Push a snapshot to GitHub now                      |
| GET    | `/admin/backup/list`     | List snapshots in the configured repo              |
| GET    | `/admin/backup/export`   | Download the current full snapshot as JSON         |
| POST   | `/admin/backup/restore`  | Restore from GitHub (`snapshot`) or from a full JSON body (`snapshotData`) |
