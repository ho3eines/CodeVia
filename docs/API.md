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
| POST | `/projects/:id/onboard` | Re-run onboarding (re-detects stack **and re-discovers project rules**) |
| GET | `/projects/:id/rules` | Project rules injected into every agent prompt: `{index, category, discovered, text}` — `discovered` blocks come from README / CONTRIBUTING / CODEOWNERS / `.editorconfig` / `Directory.Build.*` / `*.csproj` / `package.json` / Dockerfile / CI / `.ai-engineering/rules/*.md` |
| PUT | `/projects/:id/rules` | Replace the **manual** rules (`rules: string[]`); discovered rules are kept unless `keepDiscovered:false` |
| POST | `/projects/:id/dry-run` | **Simulation / Dry Run** — preview what an agent would do (`title`, `description`, `agentType?`): chosen agent + model, step plan, repository writes, approvals needed, context size, budget. Creates **no** task/run |
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
| PATCH | `/agents/:id` | Update agent (a prompt change creates a new immutable prompt version) |
| POST | `/agents/:id/enable` / `disable` | Toggle |
| GET | `/agents/:id/history` | Run history |
| GET | `/agents/:id/prompt-versions` | Prompt version history (`version`, `source`, `note`, `derivedFrom`, `current`) |
| GET | `/agents/:id/prompt-versions/diff?from=1&to=current` | Line diff between two versions (`to` = number or `current`) with `summary {added, removed, unchanged}` |
| POST | `/agents/:id/prompt-versions/:version/restore` | Restore a version — history is never rewritten, a new version (`derivedFrom`) is appended |
| POST | `/agents/:id/prompt-versions/:version/clone` | Clone a version onto `targetAgentId` (default: same agent) |
| DELETE | `/agents/:id` | Delete |

## Models & Providers

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/models` | Model Registry (`POST` validates `providerId` exists and `modelId` is set → `400`). `modelId` may be typed **manually** — it is never validated against the provider catalog (free/preview models are often unlisted); a leading `models/` prefix is stripped. Re-adding an existing `providerId`+`modelId` is idempotent and returns the stored model with `duplicate: true`. Capabilities are **auto-detected** from the model id when omitted; the response includes `detectedCapabilities` |
| GET/PATCH/DELETE | `/models/:id` | Model detail / update / delete |
| POST | `/models/test` | Pre-registration model test (before saving) — never persists. With `{providerId, modelId, message}` it **sends ONE real chat message** and returns the exact chat `url`, the HTTP `status`/`latencyMs`, and the model's `responseText`. Without `message` it is cheap detection-only (auto capabilities + catalog lookup, no completion call) |
| POST | `/models/:id/activate` / `deactivate` | Toggle a model for routing |
| POST | `/models/bulk` | Bulk multi-select action: `{action: "delete"｜"activate"｜"deactivate", ids: [...]}` → `{ok, action, affected, ids, missing}`. Unknown action or empty `ids` → `400` |
| POST | `/models/:id/stream` | **Streaming chat** (`text/event-stream`) for a saved model. Body `{message}` or a full `{messages: [{role, content}]}` history, optional `temperature` / `maxTokens`. Emits SSE frames `{"type":"meta", url, modelId, transport}` → `{"type":"delta", text}`* → `{"type":"done", text, latencyMs, status?}`, or `{"type":"error", message, hint?}`. Works for OpenAI, Anthropic, Gemini (`:streamGenerateContent?alt=sse`), Ollama (NDJSON) and the mock provider (simulated locally). Closing the connection aborts the upstream request |
| POST | `/models/:id/test` | Live chat test for a saved model — **sends ONE real message** (optional `{message}`, else a short default prompt) and returns `{ok, url, method, status?, latencyMs?, responseText, transport, ...}`. `transport` is `http` or `mock`; `url` is the exact chat endpoint (secrets masked) |
| GET | `/providers/presets` | Provider types + per-type defaults (`baseUrl`, `secretRef`, `authType`, `apiFormat`) used by the Add Provider form. Anthropic default omits `/v1` (the platform appends it) |
| GET | `/providers` | Providers, each with `readiness {ready, reason?, hint?}` and `keyPresent` (is the env var behind `secretRef` set?) |
| POST | `/providers` | Create (secret **references** only — a literal key in `secretRef` is rejected with `400`; duplicate name → `409`). Auto-activates only when immediately usable; auto-discovers models via the live catalog |
| POST | `/providers/test` | Pre-registration connectivity test (before saving): verifies **the exact values currently in the form**, returns `{url, catalogUrl, chatUrl, urls, models, modelInfos, ...}` — the `message` always states the destination (`GET <url> → ...` or where it *would* go). Pass `providerId` in edit mode and the stored key is reused when no new key is typed. Never persists |
| GET/PATCH | `/providers/:id` | Detail / update (drops the cached adapter so new config is used) |
| POST | `/providers/:id/activate` | Approve/enable. `422` + `hint` when the key is missing; `?force=true` overrides |
| POST | `/providers/:id/deactivate` | Disable (the runner skips inactive providers even if their models are active) |
| POST | `/providers/:id/test` | Live connectivity test → `{ok, keyPresent, checked, status?, latencyMs?, message, hint?, url, catalogUrl, chatUrl, urls, models?, modelInfos?}`. The `message` always names the requested endpoint; the mock provider reports no URLs (it makes no external request) |
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
| POST | `/tasks/:id/cancel` | Cancel — queued jobs are dropped, running plans stop between steps; final tasks return `alreadyFinal` |
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
| GET/POST/PATCH/DELETE | `/integrations/telegram/accounts[/:id]` | Per-user bots: token from Settings (encrypted, never returned). POST with no `chatId` returns `pairing.code`; the bot answers no chat until its owner sends `/pair CODE`. `PATCH {pair:true}` un-links and issues a fresh code |
| POST | `/integrations/telegram/accounts/:id/connect` | Verify token + choose receive path (webhook, else polling) |
| POST | `/integrations/telegram/accounts/:id/transport` | Force one account onto polling/webhook |
| POST | `/integrations/telegram/command` | Drive a telegram-style command (UI preview; `deliver:true` to actually send) |
| POST | `/integrations/telegram/send` | Send a message |

## Conversations

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/conversations`, `/conversations/:id` | Conversations |
| POST | `/conversations/:id/messages` | Add message (re-summarizes every 20 messages via the model router) |
| POST | `/conversations/:id/summarize` | AI summary → `{ summary, method: "ai"|"heuristic", modelId? }` |

## Settings & Import/Export

| Method | Path | Description |
|--------|------|-------------|
| GET | `/settings` | Platform settings |
| GET | `/settings/approval` | Approval policy: `autoApprove`, `timeoutMs`, `pending` |
| POST | `/settings/approval` | Set the policy (`autoApprove:false` = dangerous steps wait for a human in web/Telegram; `timeoutMs` = how long before an unanswered request expires as rejected) |
| GET | `/settings/backup` | System backup (config metadata only, no secrets) |
| POST | `/settings/import` | Import an export blob. Body extras: `dryRun` (preview plan + conflicts), `mode` = `create` (default, new project, ids remapped) \| `merge` (into `targetProjectId`), `conflict` = `skip` (default) \| `overwrite`. Imports agents, workflows, memory, skills |

## Approvals (human-in-the-loop)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/approvals` | Approval requests (`?status=pending|approved|rejected|expired`, `?projectId=`) |
| GET | `/approvals/:id` | One request (`action`, `detail`, `taskId`, `runId`, `workflowId`, `correlationId`, `status`, `decidedBy`, `decisionSource`) |
| POST | `/approvals/:id/approve` | Approve (`note?`). The blocked agent/workflow step continues; `409` if already decided |
| POST | `/approvals/:id/reject` | Reject — the gated step is skipped and the run stops |

Pending requests are also pushed to Telegram (project chat + paired per-user bots) with ✅/❌ inline buttons and are listed by `/approvals` in the bot. Live updates arrive on the `notification` socket event with `data.kind = approval.required|approved|rejected|expired`.

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
| GET | `/admin/backup` | Admin System Backup config + status + GitHub/storage readiness (owner/admin only) |
| PUT | `/admin/backup` | Save backup config: `enabled`, `repo` (`owner/name`), `branch`, `path`, `schedule` (cron), `retain` (owner/admin only) |
| POST | `/admin/backup/run` | Push a full runtime snapshot to the configured GitHub repo now (owner/admin only) |
| GET | `/admin/backup/list` | List committed snapshots in the configured repository (`?limit=`) |
| GET | `/admin/backup/export` | Download the current full runtime snapshot as JSON |
| POST | `/admin/backup/restore` | Restore from GitHub (`{snapshot?, replace?}`) or from a full snapshot body (`{snapshotData, replace?}`). Replaces the runtime DB by default |

---

## Real-time (Socket.io)

Channels emitted by the server: `run.updated`, `step.updated`, `task.updated`, `notification`. The client receives **only** status/step/result — never chain-of-thought.
