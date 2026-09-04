# GitHub Setup Guide

GitHub is the **source of truth** for persistent project data. It is also the
platform's **user login** (OAuth).

---

## 0. User login via GitHub OAuth (recommended)

Without this, the platform runs in **demo mode** (a built-in `Demo Owner`);
with it, users click **🐙 Login with GitHub** in the UI (`#/github`).

1. GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App.
2. **Homepage URL**: `https://<your-app>.up.railway.app` (local: `http://localhost:8080`).
3. **Authorization callback URL**: `https://<your-app>.up.railway.app/auth/github/callback`
   (local: `http://localhost:8080/auth/github/callback`).
4. Copy **Client ID** → `GITHUB_CLIENT_ID`, generate a **Client secret** → `GITHUB_CLIENT_SECRET`.
5. Set `AUTH_SECRET` to any random 32+ char string (signs sessions + OAuth state).
6. (Optional) `GITHUB_OAUTH_SCOPE` (default `read:user user:email`),
   `GITHUB_OAUTH_CALLBACK_URL` (overrides the callback URL),
   `REQUIRE_AUTH=true` (reject unauthenticated API calls with 401 instead of demo mode).
7. Restart. Open `#/github` → **Login with GitHub**.
   The **first user to log in becomes `owner`**; later users become `developer`.

> **Admin panel shortcut:** after the first login, open `#/admin` → **GitHub Login**.
> There you can set the Client ID, callback URL, scope and the "require login"
> toggle without touching env files or restarting. Precedence per field is
> **env → admin → default** (a field set via env shows an `env` badge and is
> locked in the UI). Secrets (`GITHUB_CLIENT_SECRET`, tokens, `AUTH_SECRET`)
> always stay in environment variables — the admin page only shows whether
> each one is set, never its value. User roles are managed in `#/admin` →
> **Users** (the last owner cannot be demoted).

How it works: `GET /auth/github/login` → 302 to `github.com/login/oauth/authorize`
(signed `state`, 10-min expiry) → `GET /auth/github/callback?code&state` exchanges
the code, fetches `GET /user` (+ `/user/emails`), upserts the user row, and sets
an HttpOnly `cv_session` cookie (7-day HMAC-signed token). The SPA also sends it
as `Authorization: Bearer …`. `GET /auth/me` reports the current user;
`POST /auth/logout` clears the session.

---

## 1. Choose a repo-access method

The platform supports a **GitHub App + OAuth** architecture. At minimum you need a token for the REST adapter.

### GitHub App (recommended for teams)

1. Create a GitHub App in your GitHub account/org settings (Settings → Developer settings → GitHub Apps → New GitHub App).
2. Set the **webhook URL** to `https://<your-app>.up.railway.app/webhooks/github`.
3. Set a **webhook secret** and copy it to `GITHUB_WEBHOOK_SECRET`.
4. Grant the permissions your agents need (Contents: Read/write, Pull requests: Read/write, Issues: Read/write, Metadata: Read).
5. Install the App on your repositories (or org).
6. Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in Railway Secrets. (This is the extension point for installation-token exchange; the `RealGitHubService` also accepts a `GITHUB_TOKEN`.)

### OAuth App / Personal token (simplest)

1. Create an OAuth App (Settings → Developer settings → OAuth Apps) or a classic PAT.
2. Set `GITHUB_TOKEN` (PAT or OAuth token) and optionally `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
3. Set `GITHUB_ENABLED=true`.
4. Set a webhook secret (`GITHUB_WEBHOOK_SECRET`) for `/webhooks/github`.

> Without any token, the platform uses an **in-memory mock** for local dev/tests. In production (`NODE_ENV=production`) with a token, the real adapter is used automatically.

---

## 2. Repository structure (source of truth)

When a project connects to a repo, the platform recognizes/creates the configuration tree:

```
.ai-engineering/
├── project.yaml
├── agents/            (agent definitions)
├── prompts/           (project/system/agent prompts)
├── skills/            (enabled + available)
├── memory/
│   ├── architecture/  ├── decisions/  ├── bugs/
│   ├── technical/     ├── business/   ├── lessons/  └── conversations/
├── knowledge/         ├── workflows/  ├── tasks/  ├── reports/
├── tests/             ├── rules/ (coding|architecture|git|security|testing).md
└── snapshots/
```

This tree is configurable; the database is cache/index/runtime only. If the database is wiped, re-connecting the repository reconstructs the project state.

---

## 3. Webhook events

`/webhooks/github` validates the `X-Hub-Signature-256` (HMAC-SHA256) and publishes onto the event bus:

- `push` → QA / change detection
- `pull_request` (opened/updated) → Code Review / QA
- `issues` → Research / Debugging
- `release` → Release Agent
- `workflow_completed` → DevOps / CI

These events can trigger agent workflows.

---

## 4. Connected capabilities

The API exposes repo listing, branches, commits, PRs, issues, releases, file reads, branch creation, commit/push, PR create/update, and issue/PR comments. Agents use these via the `GitHubTool` family (permission-gated).
