# Environment Variables & Secrets Guide

All configuration and secrets come from environment variables / secret management (Railway Variables, Railway Secrets, Secret Manager, `.env`). **No secret is ever committed to Git or included in an export.**

Copy `.env.example` to `.env` and set the values you need.

---

## Core

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | `development` \| `staging` \| `production` |
| `HOST` | `0.0.0.0` | Bind address (must stay `0.0.0.0` for container deployments) |
| `PORT` | `8080` | HTTP port |
| `LOG_LEVEL` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `RATE_LIMIT_PER_MINUTE` | `600` | Per-IP API rate limit (0 disables). Health, webhooks, docs and static assets are exempt |
| `SECURITY_HEADERS` | `true` | Adds `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS (prod + https) |
| `DATABASE_PATH` | `./data/codevia.db` | Runtime SQLite path. In Docker/Railway set it inside the volume (`/app/data/codevia.db`); the entrypoint prepares that directory and the app pre-checks it is writable at boot |

---

## AI Model Providers (Secret References)

Each provider's API key is an environment variable. **Leave empty to run offline with the Mock AI provider.**

| Variable | Provider |
|----------|----------|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GEMINI_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |
| `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` | Azure OpenAI |
| `OLLAMA_BASE_URL` | Ollama (default `http://127.0.0.1:11434`) |

The stored `Provider` config stores only `secretRef` (e.g. `OPENAI_API_KEY`) — never the literal key.

---

## GitHub

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | Personal access token / OAuth token for the real REST adapter (the ONLY API token — `GITHUB_CLIENT_SECRET` is not a token) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth App (user login via `/auth/github/*`). The Client ID can instead be set in `#/admin` → GitHub Login (env wins when both are set) |
| `GITHUB_OAUTH_SCOPE` | OAuth scope, default `repo read:user user:email` (`repo` = list/read private repositories for the picker; overridable in `#/admin` → GitHub Login) |
| `GITHUB_OAUTH_CALLBACK_URL` | Overrides `<base>/auth/github/callback` for the OAuth flow (overridable in `#/admin` → GitHub Login) |
| `AUTH_SECRET` | Signs login sessions + OAuth state (**required in production** for login) |
| `REQUIRE_AUTH` | `true` → unauthenticated API calls get 401 (default `false` = demo mode locally) |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | GitHub App (installation) |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for `/webhooks/github` signature validation |
| `GITHUB_ENABLED` | Set `true` to use the real adapter; otherwise the mock is used for local dev/test (even if a token is present) |
| `REPO_BRIEF_TTL_MS` | `120000` — how long the repository brief (file tree + README + manifests) that feeds the project chat is cached per account+repository+branch. `0` disables caching. A chat message re-reads GitHub only after the TTL, a `?refresh=1` health check, or a restart |
| `REPO_MIRROR_ENABLED` | `true` — keep a **read-only bare clone** of connected repositories and read repository evidence from disk with git plumbing (`ls-tree` / `cat-file` / `grep`). Any mirror problem falls back to the GitHub API; repository code is never executed. `false` disables the whole path |
| `REPO_MIRROR_DIR` | `<dirname(DATABASE_PATH)>/mirrors` — where mirrors live, stored **per acting account** (`<acct-…>/<owner>/<name>.git`) so readability and content never leak across accounts. Keep it on the persistent volume |
| `REPO_MIRROR_REFRESH_MS` | `300000` — re-fetch at most this often; a fresh mirror answers without any network. `POST /projects/:id/repo-mirror/refresh` forces a fetch |
| `REPO_MIRROR_TIMEOUT_MS` / `REPO_MIRROR_READ_TIMEOUT_MS` | `120000` / `20000` — clone/fetch budget, and the budget for a single plumbing read |
| `REPO_MIRROR_MAX_MB` / `REPO_MIRROR_MAX_FILES` / `REPO_MIRROR_MAX_READ_BYTES` | `2000` / `20000` / `524288` — refuse a repository bigger than this (evidence then comes from the API), cap the listed paths, cap one file read |
| `REPO_MIRROR_MAX_SEARCH_HITS` | `60` — bound on `git grep` results returned to a tool |
| `REPO_MIRROR_URL_TEMPLATE` | `https://github.com/{repo}.git` — clone URL template; change it for GitHub Enterprise or another git host |
| `REPO_MIRROR_GIT_PATH` | `git` — explicit git binary when it is not on `PATH` |

> In production (`NODE_ENV=production`) with a token, the real adapter is used automatically.

---

## Telegram

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | The **operator's** bot token. Optional: each user can instead paste their own token in Settings → Telegram (encrypted at rest, chat-paired), which is the multi-user path |
| `TELEGRAM_MODE` | `auto` (default) · `polling` · `webhook` · `off` — how updates are received |
| `TELEGRAM_POLL_TIMEOUT` | Long-poll hold seconds (default 25) |
| `TELEGRAM_WEBHOOK_SECRET` | Optional webhook secret (`X-Telegram-Bot-Api-Secret-Token`, enforced on the webhook route when set) |
| `TELEGRAM_WEBHOOK_URL` | Explicit public webhook URL override |
| `TELEGRAM_WEBHOOK_INSECURE` | `true` keeps an `http://` webhook URL for a public host (behind a proxy that only forwards `x-forwarded-proto: http`). Never use it with `localhost` — Telegram cannot reach that anyway |
| `TELEGRAM_WEBHOOK_ALLOW_LOOPBACK` | `true` skips both the https and the localhost rule so the webhook round-trip can be tested locally or through a tunnel. Off by default; never set it in production |
| `TELEGRAM_API_BASE` | Bot API base; only change for a proxy/mirror or offline testing. While it is set, the UI marks the bot "not Telegram" and the connection test fails on purpose — a token verified against a mock is not verified |
| `ENABLE_TELEGRAM` | Legacy "I want Telegram" flag — a token is enough; `TELEGRAM_MODE=off` is the opt-out |

Without a token, a **MockTelegramService** is used (messages are recorded/logged), so local development needs no credentials.

---

## Model routing / load distribution

Which model answers *now* — see [MODEL_ROUTING.md](MODEL_ROUTING.md) for the algorithms. The policy can also be changed at runtime in **Models → Benchmark → Load distribution** (persisted, and it wins over these defaults after the first change).

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL_ROUTING_POLICY` | `adaptive` | `adaptive` \| `round-robin` \| `weighted-round-robin` \| `least-loaded` \| `sticky`. Everything except `sticky` spreads the traffic over every eligible model instead of hammering the best-scored one |
| `MODEL_ROUTING_MAX_CONCURRENCY_PER_MODEL` | `0` (unlimited) | Live calls one model may carry before the router prefers a peer. A per-model `maxConcurrency` overrides it |
| `MODEL_ROUTING_FAILURE_THRESHOLD` | `3` | Consecutive failures that demote a model to the back of the queue. `0` disables the circuit breaker |
| `MODEL_ROUTING_COOLDOWN_MS` | `60000` | How long a demoted model stays last (doubles per trip, capped at 8×); it is never removed from the pool |
| `MODEL_ROUTING_SESSION_STICKY_MS` | `0` | How long one conversation keeps its model. `0` = rotate every message (best spread); raise it for one-voice-per-thread |
| `MODEL_ROUTING_RUN_STICKY_MS` | `900000` | How long one agent run keeps its model, so a run never changes style mid-task while different runs still spread |
| `PATCH_FULL_REWRITE_MAX_BYTES` | `8192` | Existing files at or below this many bytes may be replaced by a full model rewrite instead of an `{"edits":[…]}` patch (or a unified diff). Larger files require a patch. `0` disables full rewrites |

---

## Platform behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_SIMULATION_MODE` | `true` | When on, agents preview actions instead of making real changes where applicable |
| `MOCK_AI_DEFAULT` | `true` | Prefer the offline mock provider by default |
| `STATE_COMMIT_SKIP_CI` | `true` | CodeVia's project-state commits only touch `CodeVia/**` (never code) and carry GitHub's `[skip ci]` marker, so a project's CI does not run — and does not email "all jobs have failed" — for every task/run/chat save. Set `false` to run CI on state commits too |
| `WEB_BASE_URL` | `http://localhost:8080` | Base URL for the web UI |
| `PUBLIC_WEB_BASE_URL` | (empty) | Public URL (Railway) used for absolute links/notifications |

---

## Full system backup

A backup captures the environment above **and** the credentials, so one file can
rebuild the installation on another server. See [SYSTEM_BACKUP.md](SYSTEM_BACKUP.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_INCLUDE_ENV` | `true` | Capture every variable of this contract that is set (plus each provider's `secretRef` name) into the snapshot |
| `BACKUP_INCLUDE_SECRETS` | `true` | Capture credentials in plaintext — API keys, `GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, `AUTH_SECRET`, per-user GitHub OAuth tokens, provider keys. A restore re-encrypts them with the target server's `AUTH_SECRET`. `false` = database rows only (the pre-2026-10 behaviour) |
| `BACKUP_LOCAL_COPY` | `true` | Also write each snapshot to `<dirname(DATABASE_PATH)>/backups/<ts>/` (the mounted volume), so a backup exists with no GitHub configured |
| `BACKUP_LOCAL_DIR` | `<dirname(DATABASE_PATH)>/backups` | Where local copies go |
| `BACKUP_LOCAL_RETAIN` | `30` | Local snapshots kept; older ones are pruned after each run |
| `BACKUP_PASSPHRASE` | (empty) | Encrypt the **stored** bundle (scrypt + AES-256-GCM) as `secrets.enc.json`; a restore then needs the same passphrase. Never stored in the database and never captured into a backup |
| `BACKUP_EXTRA_ENV` | (empty) | Comma-separated extra variable names to capture (e.g. a corporate proxy key) |

`BACKUP_INCLUDE_ENV`, `BACKUP_INCLUDE_SECRETS`, `BACKUP_LOCAL_COPY` and
`BACKUP_LOCAL_DIR` are also switches in Admin → System Backup; the panel value
wins over the environment.

### `.env` is read at boot

The server loads `<dirname(DATABASE_PATH)>/.env` and then `./.env` before parsing
this contract — that is how the environment a restore recovered survives a
restart. **Already-set process variables always win**, so Railway/Docker variables
keep their precedence and the file only fills the gaps. Machine-local variables
(`PATH`, `HOME`, `npm_*`, `NODE_*`, …) are never read from or written to a `.env`
file.

---

## Secret hygiene rules

1. Only **secret references** are stored in project/repo config and exports.
2. Never commit `.env`, `*.db`, a backup snapshot, or any API key. `data/`
   (which holds the database, the local backups and the restored `.env`) is
   git-ignored — keep it that way.
3. Use Railway Secrets (or your secret manager) for production.
4. Rotate keys; the platform reads them fresh from the environment at runtime.
5. **The one deliberate exception** is the full system backup, which carries
   credentials so a restore works on any server. Control it with
   `BACKUP_INCLUDE_SECRETS`, protect stored copies with `BACKUP_PASSPHRASE`, keep
   the backup repository private, and treat a downloaded snapshot like a key ring:
   transfer it over an encrypted channel and delete it when the restore is done.
6. Rotating `AUTH_SECRET` invalidates every credential stored before the
   rotation — restore a backup (which re-wraps them) or re-enter the keys.
