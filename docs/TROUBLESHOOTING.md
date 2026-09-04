# Troubleshooting Guide

## The platform won't start

- **`Invalid environment configuration`** — a required env var is missing/invalid. Check `.env.example` against your `.env`.
- **Port already in use** — change `PORT` or stop the other process.
- **`node:sqlite`** — requires Node ≥ 22. Ensure your runtime uses Node 22+ (`docker` image uses `node:22-slim`).

## No API key — what happens?

The platform runs in **Mock AI** mode. Providers, models and skills are seeded; tasks run with deterministic, zero-cost responses. Set a real key to enable live models. See [PROVIDER_SETUP.md](PROVIDER_SETUP.md).

## GitHub queries return empty / errors

- Local dev uses **MockGitHubService** unless `GITHUB_ENABLED=true` (production auto-uses the real adapter when `NODE_ENV=production` and a token is set).
- Set `GITHUB_TOKEN` (or App/OAuth credentials) and `GITHUB_ENABLED=true` to hit real repos.
- The context/memory engine degrades gracefully when a repo is missing — a missing repo won't crash agent runs.

## Blank page / `GET /app.js 401 (Unauthorized)` / "Authentication required (GitHub login)"

Strict login mode (`REQUIRE_AUTH`) is on, but no GitHub session exists.

- The SPA shell (`/`, `/app.js`, `/app.css`, `/socket.io/*`) and the OAuth
  handshake (`/auth/github/login|callback|status`) are always public, so the UI
  loads and shows a **Sign in required** screen with a **Login with GitHub** button.
- If you did **not** intend strict mode: remove `REQUIRE_AUTH` (or set it to
  `false`) in Railway Variables and redeploy. Older builds parsed *any* value —
  even `REQUIRE_AUTH=false` — as `true`; this is fixed (`true/false`, `1/0`,
  `yes/no`, `on/off` are understood).
- If GitHub login is **not configured** (no Client ID / `GITHUB_CLIENT_SECRET`),
  strict mode cannot be enforced (nobody could ever sign in); the platform logs a
  warning and stays in demo mode until login is configured.
- Strict mode can also be toggled from `#/admin` → **GitHub Login** → *Require
  GitHub login for API* (stored in the runtime DB, overrides the env value).

## GitHub login fails with `redirect_uri_mismatch` — or the browser "never comes back"

The OAuth App's **Authorization callback URL** must match the platform's
callback **exactly**: `https://<your-app>.up.railway.app/auth/github/callback`.
Check `GET /auth/github/status` → `redirectUri` and compare it with the value
in GitHub → Settings → Developer settings → OAuth Apps. Set
`PUBLIC_WEB_BASE_URL=https://<your-app>.up.railway.app` (or
`GITHUB_OAUTH_CALLBACK_URL`) so the platform derives the same URL.

Symptoms when the two URLs disagree:

- **`redirect_uri_mismatch` page / `#/github?login=error`** — the app sends a
  `redirect_uri` (derived from env) that differs from what is registered on
  GitHub.
- **Login works on GitHub but the app never returns, and `/auth/me` / the API
  answer `401 (Unauthorized)`** — the OAuth App has a *local* callback URL
  registered (e.g. `http://localhost:8080/auth/github/callback`, or the
  production env still has `PUBLIC_WEB_BASE_URL=http://localhost:8080`). After
  authorizing, GitHub redirects the browser to `localhost:8080` (your own
  machine), so the session cookie (`cv_session`) is never set on the deployed
  app. Fix: point **both** — `PUBLIC_WEB_BASE_URL` on Railway **and** the
  OAuth App callback — at the public URL, redeploy, log in again.

The platform logs a loud startup warning (`GitHub OAuth callback resolves to a
local address: …`) in production when it detects this, so check the service
logs after each deploy.

## Webhook signature invalid (`401`)

- Set `GITHUB_WEBHOOK_SECRET` and use it as the GitHub App "Webhook secret".
- The `X-Hub-Signature-256` header must be present on every request.

## Telegram messages not sending

- Without `TELEGRAM_BOT_TOKEN`, the **mock** bot logs messages instead of sending. Set `TELEGRAM_BOT_TOKEN` and point the webhook at `/integrations/telegram/webhook`.

## A run fails at a step

- Use the **AI Run Console** (`GET /runs/:id/console`) to see the exact failing step + detail.
- Common causes: model/fallback exhausted (configure models), repo not reachable (GitHub), or a tool denied permissions (check the agent's `permissions`).

## "Mock repo not found"

Happens if a task runs against a repo the mock hasn't seen. Creating a project via the API/UI seeds a starter `.ai-engineering/` repo automatically; re-onboard via `POST /projects/:id/onboard`.

## Tests fail to run (Vite can't resolve `node:sqlite`)

`node:sqlite` is experimental. Vitest is configured to externalize it. If you add a new test importing the DB, ensure `vitest.config.ts` keeps `node:sqlite` external.

## Cost/usage shows zero

The Mock provider returns zero cost. Real providers populate `CostRecord` with token/cost data; see `/costs/summary`.

## I want to reset state

- Delete the runtime DB: `rm -f data/codevia.db*` (then restart). GitHub remains the source of truth for project config/memory.
