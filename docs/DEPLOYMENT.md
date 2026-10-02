# Deployment Guide (Docker + Railway)

CodeVia is containerized and Railway-ready. The build uses a multi-stage Dockerfile and exposes standard health endpoints.

---

## 1. Local Docker

```bash
docker build -t codevia-platform .
docker run -p 8080:8080 -v $(pwd)/data:/app/data codevia-platform
# or
docker compose up --build
```

Open `http://localhost:8080`.

---

## 2. Environment

Copy `.env.example` → `.env` and set the values you want (see [ENVIRONMENT.md](ENVIRONMENT.md)). For container deployment set `DATABASE_PATH=/app/data/codevia.db` and bind `HOST=0.0.0.0`, `PORT=8080`.

---

## 3. Railway

### Option A — single service (simplest)

1. Push the repository to GitHub and connect it to Railway.
2. Railway detects `railway.json` (Dockerfile builder, `/health` healthcheck).
   The start command is
   `"/usr/local/bin/docker-entrypoint.sh node dist/index.js"` — deliberately the
   **entrypoint first**: `ENTRYPOINT` prepares the volume mount and drops to the
   `codevia` user, `CMD`/`startCommand` only says *what* to run. A bare
   `node dist/index.js` here (or in Service → Settings → Build → Start Command)
   skips the volume fix-up and crash-loops with `unable to open database file`.
3. Set **Railway Variables / Secrets**:
   - `NODE_ENV=production`
   - `PORT=8080`, `HOST=0.0.0.0`
   - `DATABASE_PATH=/app/data/codevia.db` (or use the volume / a referenced volume)
   - `GITHUB_ENABLED=true`, `GITHUB_TOKEN=…`, `GITHUB_WEBHOOK_SECRET=…`
   - `OPENAI_API_KEY=…` (and/or others)
   - `TELEGRAM_BOT_TOKEN=…`
   - `PUBLIC_WEB_BASE_URL=https://<your-app>.up.railway.app`
4. Add a Volume with mount path `/app/data` to persist the runtime DB. The
   entrypoint reads `DATABASE_PATH`, creates/chowns that directory while it is
   still root (`chown -R codevia`), then re-execs the app as `codevia`
   (`setpriv`, with a `su` fallback) so the container never runs Node as root.
   Ownership is repaired on *every* boot, because Railway re-mounts the volume
   root-owned after each rebuild.
5. Deploy. If the previous deploy crash-looped, trigger a redeploy from the
   latest commit (an old build has no `ENTRYPOINT` and no storage pre-flight).

Health: Railway polls `/health`.

> `docker-compose.yml` and plain `docker run` need no `command:` override — the
> image declares the entrypoint itself, so the volume is always prepared.

### Option B — split services (web + worker)

Run two services from the same image:
- **Web/API** service: `CMD node dist/index.js` (starts the HTTP server **and** an in-process worker). Single-node deployments are fine.
- **Worker** service: to run only the worker, add an env flag (e.g. `WORKER_ONLY=true`) and start `node dist/index.js` with the worker-only branch. (This is the extension point for horizontal scaling; the queue is the shared runtime store.)

### Option C — persistent storage (REQUIRED on Railway to keep settings)

The runtime SQLite DB (`DATABASE_PATH=/app/data/codevia.db`) stores the
admin-managed **GitHub login settings**, the user table and cached platform
data. On Railway the container filesystem is **ephemeral**: every deploy
starts a fresh container, so anything in `/app/data` is **wiped** — the
symptom is "I have to re-enter the GitHub settings after every deploy" and
users getting logged out on every deploy.

**Attach a volume (one time, permanent fix):**

1. Railway dashboard → your project → **CodeVia service** → **Settings** (or the **Storage** tab).
2. **Add Volume** → Name: `data` → **Mount Path: `/app/data`** → Add.
3. Trigger a **Redeploy** so the service picks up the volume.
4. Verify: open the web UI → `#/admin` — the amber "ephemeral storage"
   warning card must be gone (`/admin/health` → `storage.onPersistentVolume: true`).

> Until a volume is attached, `#/admin` shows an amber warning with the exact
> steps, and `#/settings` offers **System Backup / Restore Backup** (includes
> the non-secret GitHub login settings) as a manual fallback: download a
> backup before a deploy, restore it afterwards.
>
> Alternative without a volume: set the login config as **Railway Variables**
> (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL`,
> `AUTH_SECRET`, `REQUIRE_AUTH`) — env values persist across deploys and take
> precedence over the admin panel.

---

## 4. Health / Readiness / Liveness

| Endpoint | Meaning |
|----------|---------|
| `/health` | General process health |
| `/ready` | Readiness (DB reachable) |
| `/live` | Liveness (alive) |

The Docker `HEALTHCHECK` uses `/health`.

---

## 5. Moving to another server (or rebuilding one)

A full backup is a single self-contained file: every runtime row plus the
environment and the credentials. See [SYSTEM_BACKUP.md](SYSTEM_BACKUP.md) for what
it contains and every way to take one.

```bash
# 1. On the old server — Settings → ⬇ Full system backup (JSON)
#    (or without the UI: npm run backup:export -- --out /secure/backup.json)

# 2. On the new server
git clone <your fork> && cd CodeVia
npm ci && npm run build
npm run backup:restore -- /secure/backup.json   # writes the DB + <db dir>/.env
DATABASE_PATH=/app/data/codevia.db npm start    # or: docker compose up -d
```

The restore re-encrypts every credential with the **new** server's `AUTH_SECRET`,
fills in the environment variables that are not already set, and persists them to
`<dirname(DATABASE_PATH)>/.env`, which the server reads at boot — so the keys are
still there after the first restart. Variables the platform injects (`PORT`,
`DATABASE_PATH`, Railway variables…) always win over the backup.

In Docker, mount the volume that holds the database — the local backup copies and
the restored `.env` live next to it:

```bash
docker run -d --name codevia-web --env-file .env \
  -v codevia-data:/app/data -p 8080:8080 codevia-platform:latest
```

If the new server must come up *before* anyone can sign in (`REQUIRE_AUTH=true` on
an empty database answers 401 to everyone), the CLI restore above is the way in —
it needs no session.

## 6. Scaling notes

- The runtime store (SQLite) and queue are the shared state. For scale-out, swap `Db` for Postgres (the repository abstraction isolates the change) and the in-process queue for Redis. The domain, agents, providers, and tools layers are unchanged.
- Agent workers, the model gateway, GitHub service, Telegram service, and execution workers are designed to be separately scalable (module boundaries in `agents/`, `ai/`, `github/`, `integrations/`, `workers/`).
