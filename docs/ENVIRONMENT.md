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
| `DATABASE_PATH` | `./data/codevia.db` | Runtime SQLite path (volume in Docker) |

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
| `GITHUB_OAUTH_SCOPE` | OAuth scope, default `read:user user:email` (overridable in `#/admin` → GitHub Login) |
| `GITHUB_OAUTH_CALLBACK_URL` | Overrides `<base>/auth/github/callback` for the OAuth flow (overridable in `#/admin` → GitHub Login) |
| `AUTH_SECRET` | Signs login sessions + OAuth state (**required in production** for login) |
| `REQUIRE_AUTH` | `true` → unauthenticated API calls get 401 (default `false` = demo mode locally) |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | GitHub App (installation) |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for `/webhooks/github` signature validation |
| `GITHUB_ENABLED` | Set `true` to use the real adapter; otherwise the mock is used for local dev/test (even if a token is present) |

> In production (`NODE_ENV=production`) with a token, the real adapter is used automatically.

---

## Telegram

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Optional webhook secret |
| `ENABLE_TELEGRAM` | `true` to enable the bot interactions |

Without a token, a **MockTelegramService** is used (messages are recorded/logged), so local development needs no credentials.

---

## Platform behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_SIMULATION_MODE` | `true` | When on, agents preview actions instead of making real changes where applicable |
| `MOCK_AI_DEFAULT` | `true` | Prefer the offline mock provider by default |
| `WEB_BASE_URL` | `http://localhost:8080` | Base URL for the web UI |
| `PUBLIC_WEB_BASE_URL` | (empty) | Public URL (Railway) used for absolute links/notifications |

---

## Secret hygiene rules

1. Only **secret references** are stored in project/repo config and exports.
2. Never commit `.env`, `*.db`, or any API key.
3. Use Railway Secrets (or your secret manager) for production.
4. Rotate keys; the platform reads them fresh from the environment at runtime.
