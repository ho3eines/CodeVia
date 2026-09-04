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
