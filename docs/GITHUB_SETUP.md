# GitHub Setup Guide

GitHub is the **source of truth** for persistent project data.

---

## 1. Choose an auth method

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
