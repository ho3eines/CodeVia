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
| GET | `/projects/options` | Option catalog for the project form: `platforms`, `languages`, `frameworks`, `databases`, `deploymentTargets`, `features`, `integrations`, `agentTypes`, `repositoryRoles`, `coreAgentTypes` (all **multi-select**) |
| GET | `/projects` | List projects (documents are upgraded to the multi-repo shape on read) |
| POST | `/projects` | Create a project (**auto-onboard**: generate agents/skills/workflows/rules). Body: `name`, `description`, `repositories[]` (`{repo:"owner/name", branch?, role?, isConfigRepo?}` — exactly one config repo holds `.ai-engineering`), `capabilities{}` (arrays per dimension; `agentTypes` empty = derive roster from the stack). Legacy `configRepo`/`branch`/`framework`/`database` strings are still accepted. Errors: `400` no/invalid repo, `409` duplicate slug |
| GET | `/projects/:id` | Project detail (`404` when missing) |
| PATCH | `/projects/:id` | Update project. `capabilities{}` (merged, re-runs onboarding — agents outside the roster are disabled, never deleted), `repositories[]`, `name`, `description`, `defaultModelId`, `active`, `settings{}`, `reonboard:true` |
| POST | `/projects/:id/activate` / `deactivate` | Toggle project |
| DELETE | `/projects/:id` | Delete |
| GET | `/projects/:id/agents` / `skills` / `memory` / `workflows` / `tasks` / `runs` / `tests` | Sub-resources |
| GET | `/projects/:id/issues` / `pull-requests` | Issues / PRs across **all** linked repositories (`?repo=owner/name` to filter); each item carries `repo` |
| POST | `/projects/:id/ask` | Natural-language AI action → task + queued job (`agentType` optional) |
| POST | `/projects/:id/onboard` | Re-run onboarding |
| GET | `/projects/:id/export` | Project export (config + agents + prompts + skills + workflows + rules; no secrets) |
| GET | `/projects/:id/repositories` | Linked repositories (`repo`, `branch`, `role`, `isConfigRepo`, `private`, `htmlUrl`) |
| POST | `/projects/:id/repositories` | Link a repository (`repo`, `branch?`, `role?`, `isConfigRepo?`) — idempotent per repo |
| PATCH | `/projects/:id/repositories/:owner/:name` | Change `branch` / `role` / make it the config repo |
| DELETE | `/projects/:id/repositories/:owner/:name` | Unlink (the last repository cannot be removed) |

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
| GET/POST | `/models` | Model Registry (`POST` validates `providerId` exists and `modelId` is set → `400`). Capabilities are **auto-detected** from the model id when omitted; the response includes `detectedCapabilities` |
| GET/PATCH/DELETE | `/models/:id` | Model detail / update / delete |
| POST | `/models/test` | Pre-registration model test (before saving): `{providerId, modelId}` → `{found, url, capabilities, detectedCapabilities, ...test}` — never persists |
| POST | `/models/:id/activate` / `deactivate` | Toggle a model for routing |
| POST | `/models/:id/test` | Live check for a saved model → verifies the provider, surfaces the endpoint, reports `found` + detected capabilities |
| GET | `/providers/presets` | Provider types + per-type defaults (`baseUrl`, `secretRef`, `authType`, `apiFormat`) used by the Add Provider form. Anthropic default omits `/v1` (the platform appends it) |
| GET | `/providers` | Providers, each with `readiness {ready, reason?, hint?}` and `keyPresent` (is the env var behind `secretRef` set?) |
| POST | `/providers` | Create (secret **references** only — a literal key in `secretRef` is rejected with `400`; duplicate name → `409`). Auto-activates only when immediately usable; auto-discovers models via the live catalog |
| POST | `/providers/test` | Pre-registration connectivity test (before saving): verifies the draft config, returns `{url, models, modelInfos, ...}` — never persists |
| GET/PATCH | `/providers/:id` | Detail / update (drops the cached adapter so new config is used) |
| POST | `/providers/:id/activate` | Approve/enable. `422` + `hint` when the key is missing; `?force=true` overrides |
| POST | `/providers/:id/deactivate` | Disable (the runner skips inactive providers even if their models are active) |
| POST | `/providers/:id/test` | Live connectivity test → `{ok, keyPresent, checked, status?, latencyMs?, message, hint?, url, models?, modelInfos?}` |
| DELETE | `/providers/:id` | Delete; `409` if models reference it unless `?cascade=true` (mock provider cannot be deleted) |

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
| GET | `/auth/me` | Current user (`{authenticated, user, githubToken:{stored, scopes, canReadPrivateRepos, login}}` — demo user when logged out) |
| POST | `/auth/logout` | Clear session cookie and delete the stored (encrypted) GitHub token |

Sessions travel via the HttpOnly `cv_session` cookie or `Authorization: Bearer <token>`.
The first GitHub user to log in becomes `owner`; later users become `developer`.

## GitHub

| Method | Path | Description |
|--------|------|-------------|
| GET | `/integrations/github/status` | Connection status: `source` (`user-oauth` \| `server-token` \| `mock`), `sourceHint`, `repoCount`, `viewer {login, scopes}`, `userToken {stored, canReadPrivateRepos}`, `oauthConfigured`, `authenticated`, `user` |
| GET | `/github/repositories?q=&limit=` | Repositories visible to the **current session**: the logged-in user's own OAuth token first, then the server `GITHUB_TOKEN`, then demo data. Returns `{repositories[], source, scopes, hint, count}`; each repo has `fullName`, `private`, `defaultBranch`, `description`, `htmlUrl`, `language`, `updatedAt`, `archived`, `permissions`. GitHub auth failures → `401/403` with a `hint` |
| GET | `/github/repositories/:owner/:name/branches` | Branches |
| GET | `/github/repositories/:owner/:name/commits` | Commits |
| POST | `/github/repositories/:owner/:name/branches` | Create branch |
| POST | `/github/repositories/:owner/:name/pull-requests` | Create PR |
| POST | `/webhooks/github` | Signed webhook → event bus |

## Telegram

| Method | Path | Description |
|--------|------|-------------|
| GET | `/integrations/telegram/status` | Bot status: `transport` (polling/webhook/off), `receiving`, `fixes[]` |
| GET | `/integrations/telegram/diagnostics` | Live `getMe` + `getWebhookInfo` + poller state |
| GET | `/integrations/telegram/test` | Connection test: token → egress → webhook → endpoint → transport, each with the action that fixes it |
| POST | `/integrations/telegram/transport` | Switch receive mode `{mode:"auto"\|"polling"\|"webhook"\|"off"}` |
| POST | `/integrations/telegram/webhook/refresh` | Re-register the webhook now |
| POST | `/integrations/telegram/updates/skip` | Drain Telegram's queued backlog without replaying it |
| POST | `/integrations/telegram/webhook` | Telegram update webhook (public; honours `TELEGRAM_WEBHOOK_SECRET`) |
| POST | `/integrations/telegram/webhook/:accountId` | Per-user bot webhook (public) |
| GET/POST/PATCH/DELETE | `/integrations/telegram/accounts[/:id]` | Per-user bots (token encrypted, never returned) |
| POST | `/integrations/telegram/accounts/:id/connect` | Verify token + choose receive path (webhook, else polling) |
| POST | `/integrations/telegram/accounts/:id/transport` | Force one account onto polling/webhook |
| POST | `/integrations/telegram/command` | Drive a telegram-style command (UI preview; `deliver:true` to actually send) |
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
| GET | `/admin/settings` | Admin settings view: effective GitHub login config (with per-field source), secret presence flags, user counts (owner/admin only) |
| PUT | `/admin/settings/github` | Update GitHub login settings: `clientId`, `callbackUrl`, `scope`, `requireAuth` — empty string clears back to env/default (owner/admin only) |
| GET | `/admin/users` | List login users (owner/admin only) |
| PATCH | `/admin/users/:id/role` | Change a user's role; refuses to demote the last owner (owner/admin only) |

---

## Real-time (Socket.io)

Channels emitted by the server: `run.updated`, `step.updated`, `task.updated`, `notification`. The client receives **only** status/step/result — never chain-of-thought.
