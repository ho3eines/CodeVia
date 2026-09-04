# API Reference

Interactive documentation (Swagger/OpenAPI) is served at **`/docs`**. The API is REST/JSON and supports **real-time updates** over **Socket.io**.

> Base URL in dev: `http://localhost:8080`. All protected routes are gated by a caller user context; unauth endpoints are `/health`, `/ready`, `/live`, `/docs`, webhooks, and the Telegram webhook.

---

## Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Process health |
| GET | `/ready` | Readiness (DB reachable) |
| GET | `/live` | Liveness |

## Dashboard

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard` | Global dashboard (projects, agents, running/failed tasks, approvals, model usage, recent activity) |
| GET | `/dashboard/project/:id` | Per-project dashboard |

## Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/projects` | List projects |
| POST | `/projects` | Create a project (**auto-onboard**: generate agents/skills/workflows/rules) |
| GET | `/projects/:id` | Project detail |
| PATCH | `/projects/:id` | Update project |
| POST | `/projects/:id/activate` / `deactivate` | Toggle project |
| DELETE | `/projects/:id` | Delete |
| GET | `/projects/:id/agents` / `skills` / `memory` / `workflows` / `tasks` / `runs` / `tests` / `issues` / `pull-requests` / `repositories` | Sub-resources |
| POST | `/projects/:id/ask` | Natural-language AI action → task + queued job |
| POST | `/projects/:id/onboard` | Re-run onboarding |
| GET | `/projects/:id/export` | Project export (config + agents + prompts + skills + workflows + rules; no secrets) |
| POST | `/projects/:id/repositories` | Attach/change a repository |

## Agents

| Method | Path | Description |
|--------|------|-------------|
| GET | `/agents` | List agents |
| POST | `/agents` | Create agent |
| GET | `/agents/:id` | Agent detail |
| PATCH | `/agents/:id` | Update agent (creates a new prompt version) |
| POST | `/agents/:id/enable` / `disable` | Toggle |
| GET | `/agents/:id/history` | Run history |
| DELETE | `/agents/:id` | Delete |

## Models & Providers

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/models`, `/models/:id` | Model Registry |
| GET/POST | `/providers`, `/providers/:id` | Providers (secret refs only) |

## Skills

| Method | Path | Description |
|--------|------|-------------|
| GET | `/skills?q=&category=&enabled=` | Skill marketplace (search/filter) |
| GET | `/skills/categories` | Categories |
| POST | `/skills`, `/skills/:id`, `/skills/:id/enable|disable`, `DELETE /skills/:id` | Manage skills |

## Workflows

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/workflows`, `/workflows/:id` | Workflow engine DAGs |
| POST | `/workflows/:id/run` | Execute a workflow via a task |

## Tasks & Runs

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/tasks`, `/tasks/:id` | Task queue |
| POST | `/tasks/:id/run` | Queue a run |
| POST | `/tasks/:id/cancel` | Cancel |
| GET | `/runs`, `/runs/:id` | Runs |
| GET | `/runs/:id/console` | **AI Run Console** (observable steps, results — never chain-of-thought) |

## Memory

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/memory`, `/memory/:id` | GitHub-backed memory entries |

## Auth (GitHub OAuth login)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/github/status` | Is OAuth configured? + current user (public) |
| GET | `/auth/github/login` | 302 redirect to `github.com` authorize (or `?format=json` → `{url, state}`) |
| GET | `/auth/github/callback?code&state` | Code exchange → session cookie → redirect to `#/github?login=success` |
| GET | `/auth/me` | Current user (`{authenticated, user}` — demo user when logged out) |
| POST | `/auth/logout` | Clear session cookie |

Sessions travel via the HttpOnly `cv_session` cookie or `Authorization: Bearer <token>`.
The first GitHub user to log in becomes `owner`; later users become `developer`.

## GitHub

| Method | Path | Description |
|--------|------|-------------|
| GET | `/integrations/github/status` | Connection status (now also `oauthConfigured`, `authenticated`, `user`) |
| GET | `/github/repositories` | List repos |
| GET | `/github/repositories/:owner/:name/branches` | Branches |
| GET | `/github/repositories/:owner/:name/commits` | Commits |
| POST | `/github/repositories/:owner/:name/branches` | Create branch |
| POST | `/github/repositories/:owner/:name/pull-requests` | Create PR |
| POST | `/webhooks/github` | Signed webhook → event bus |

## Telegram

| Method | Path | Description |
|--------|------|-------------|
| GET | `/integrations/telegram/status` | Bot status |
| POST | `/integrations/telegram/webhook` | Telegram update webhook |
| POST | `/integrations/telegram/command` | Drive a telegram-style command (UI preview) |
| POST | `/integrations/telegram/send` | Send a message |

## Conversations

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/conversations`, `/conversations/:id` | Conversations |
| POST | `/conversations/:id/messages` | Add message (auto-summarizes when long) |
| POST | `/conversations/:id/summarize` | Summarize |

## Settings & Import/Export

| Method | Path | Description |
|--------|------|-------------|
| GET | `/settings` | Platform settings |
| POST | `/settings/approval` | Configure approval policy |
| GET | `/settings/backup` | System backup (config metadata only, no secrets) |
| POST | `/settings/import` | Import a project config blob |

## Observability

| Method | Path | Description |
|--------|------|-------------|
| GET | `/notifications` | Notifications |
| POST | `/notifications/:id/read` | Mark read |
| GET | `/costs`, `/costs/summary` | Cost tracking + dashboard |
| GET | `/audit` | Audit log |
| GET | `/observability/agents` | Agent observability dashboard |
| GET | `/logs` | Run log summary |

## Search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/search?q=` | Global search (projects, agents, tasks, memory, skills) |

## Admin

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/health` | System health (api/db/queue/github/telegram/providers) |
| GET | `/admin/roles` | RBAC matrix |
| GET | `/admin/usage` | Usage/aggregates |
| GET | `/admin/provider-health` | Provider health |

---

## Real-time (Socket.io)

Channels emitted by the server: `run.updated`, `step.updated`, `task.updated`, `notification`. The client receives **only** status/step/result — never chain-of-thought.
