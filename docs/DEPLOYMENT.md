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
2. Railway detects `railway.json` (Dockerfile builder, `/health` healthcheck, `node dist/index.js`).
3. Set **Railway Variables / Secrets**:
   - `NODE_ENV=production`
   - `PORT=8080`, `HOST=0.0.0.0`
   - `DATABASE_PATH=/app/data/codevia.db` (or use the volume / a referenced volume)
   - `GITHUB_ENABLED=true`, `GITHUB_TOKEN=…`, `GITHUB_WEBHOOK_SECRET=…`
   - `OPENAI_API_KEY=…` (and/or others)
   - `TELEGRAM_BOT_TOKEN=…`
   - `PUBLIC_WEB_BASE_URL=https://<your-app>.up.railway.app`
4. Add a Volume with mount path `/app/data` to persist the runtime DB. Railway
   mounts volumes as root; this image intentionally runs as the `codevia` user,
   so also add the Railway variable `RAILWAY_RUN_UID=0` (or use an entrypoint
   that changes the mounted volume ownership). Without it SQLite can fail at
   startup with `permission denied`.
5. Deploy.

Health: Railway polls `/health`.

### Option B — split services (web + worker)

Run two services from the same image:
- **Web/API** service: `CMD node dist/index.js` (starts the HTTP server **and** an in-process worker). Single-node deployments are fine.
- **Worker** service: to run only the worker, add an env flag (e.g. `WORKER_ONLY=true`) and start `node dist/index.js` with the worker-only branch. (This is the extension point for horizontal scaling; the queue is the shared runtime store.)

---

## 4. Health / Readiness / Liveness

| Endpoint | Meaning |
|----------|---------|
| `/health` | General process health |
| `/ready` | Readiness (DB reachable) |
| `/live` | Liveness (alive) |

The Docker `HEALTHCHECK` uses `/health`.

---

## 5. Scaling notes

- The runtime store (SQLite) and queue are the shared state. For scale-out, swap `Db` for Postgres (the repository abstraction isolates the change) and the in-process queue for Redis. The domain, agents, providers, and tools layers are unchanged.
- Agent workers, the model gateway, GitHub service, Telegram service, and execution workers are designed to be separately scalable (module boundaries in `agents/`, `ai/`, `github/`, `integrations/`, `workers/`).
