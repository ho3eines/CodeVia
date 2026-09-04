# CodeVia — Architecture Document

This is the authoritative architecture reference. It covers the logical layers, domain model, data model, agent/provider/github/telegram/queue sub-architectures, security model, deployment model, UI sitemap, API design, and the implementation roadmap.

---

## 1. Product Requirements (summary)

CodeVia is an **AI Engineering Organization** that runs as a software team per project. It must be:

- **Multi-project / multi-tenant** — independent agents, models, skills, memory, prompts, workflows, permissions, and Telegram chats per project.
- **GitHub-centric** — GitHub is the **source of truth** for persistent project state (config, agents, prompts, skills, memory, workflows, tasks, decisions, rules, reports). The DB is runtime/cache/index/queue/usage only.
- **Provider-agnostic** — new model providers are added via an adapter, not by changing agents.
- **Multi-agent** — an Agent Router routes tasks/errors to the right specialist; Agent Manager chains them (QA → Debug → Backend).
- **Multi-model** — one agent can reference primary/secondary/fallback/specialized models; a central Model Router picks per task and auto-falls back.
- **Telegram-controlled** — project-aware bot with inline keyboards; bidirectional command + natural-language + approval.
- **Production-ready** — Dockerized, Railway-ready, health endpoints, background workers, queue with retry, observability, cost tracking, audit log, security hardening.
- **Non-deterministic-safe** — never exposes chain-of-thought; only action / tool / status / result.

---

## 2. Logical Layers

```
┌──────────────────────────────────────────────────────────┐
│ Web (SPA)                    Telegram Bot                │
└───────────────┬──────────────────────────┬───────────────┘
                ▼                          ▼
┌──────────────────────────────────────────────────────────┐
│ API / REST (Fastify)  ·  Swagger/OpenAPI  ·  Socket.io    │
│  auth/RBAC middleware                                     │
└───────────────┬──────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────┐
│ Application · Orchestrator (Agent Manager) · Workflow    │
│  Agent Registry / Router / Runner / Generator            │
└───────────────┬──────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────┐
│ Domain  ·  Projects · Agents · Models · Skills · Workflows│
│          · Tasks · Runs · Conversations · Memory          │
└───────────────┬──────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────┐
│ AI · Providers · Model Registry · Model Router           │
│      · Context Engine · Skills Compiler                  │
│ Tools · ToolRegistry · permission-gated tools            │
│ Memory · GitHub-backed store · local store · resolver    │
└───────────────┬──────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────┐
│ Infrastructure · GitHubService(real/mock) · Telegram     │
│   · DB adapter(node:sqlite / Postgres-ready) · Queue     │
│ Workers · Queue worker · scheduler                       │
└──────────────────────────────────────────────────────────┘
```

Each layer depends only on the one below it via interfaces (`IGitHubService`, `IModelProvider`, `ITelegramService`, `IMemoryStore`, `IToolRegistry`). This keeps the platform swappable and testable.

---

## 3. Domain Model (entities)

Key entities live in `src/domain/entities.ts`:

- **User** — identity + `role` (owner/admin/developer/reviewer/viewer).
- **ModelProvider** — `type`, `baseUrl`, `secretRef` (reference only), `authType`, `apiFormat`, timeout, rate limit, active.
- **Model** — `modelId`, provider, context window, costs, **capabilities** (vision/tools/structured output/code/reasoning/streaming), priority/fallback priority.
- **Skill** — slug, category, instructions, version, tools, dependencies, compatible agent types, enabled.
- **Project** — slug, description, `configRepo`, branch, languages/framework/db, default model/agent, Telegram chat, budget, permissions, environment, notifications.
- **Agent** — type, role, system prompt, project prompt, skills, tools, permissions, **model config** (primary/secondary/fallbacks/specialized), max iterations, timeout, token budget, memory sources, enabled, version.
- **Workflow** — DAG of nodes (`agent`, `tool`, `condition`, `approval`, `parallel`, `trigger`/`webhook`/`telegram`) + edges.
- **Task** — project, optional workflow, goal, status, agent type, correlation id, input/output.
- **Run** — task, agent, status, array of observable **steps**, token/cost/duration, correlation id.
- **Conversation** — project, user, source (web/telegram), messages, summary, active agent/model.
- **MemoryEntry** — scope (global/project/agent/task/conversation), type (architecture/business/technical/decision/bug/knowledge/lesson/conversation), key/content/tags/refs.
- **Job** — queue item with type, status (pending/running/waiting_for_approval/succeeded/failed/cancelled/retrying/dead), attempts, correlation id.
- **AuditLog / CostRecord / Notification** — observability records.

---

## 4. Database Model

The runtime DB is **SQLite** (`node:sqlite`), swappable for Postgres. It is **not** the source of truth.

`records` (generic documents)

| column | type | notes |
|--------|------|-------|
| id | TEXT PK | entity id |
| type | TEXT | entity kind (project/agent/model/provider/skill/workflow/task/run/… ) |
| project_id | TEXT | indexed for project scoping |
| parent_id | TEXT | parent (e.g. run→task, memory→project) |
| key | TEXT | indexed lookup (e.g. slug) |
| data | TEXT | JSON of the entity |
| created_at / updated_at | TEXT | audit time |

`jobs` (queue) — type, status, payload, attempts, max_attempts, correlation_id, scheduled_at, started_at, finished_at, error.

`kv` — system-level static config (non-secret).

Entity-specific repositories (`DocumentRepository<T>`) add typed `create/upsert/findById/findMany` helpers while persisting via the generic `records` table. **Memory is also persisted to GitHub** (`IGitHubMemoryStore`) so project knowledge survives a DB wipe.

---

## 5. Agent Architecture

```
AgentManager (Orchestrator)
   │  decide: which agent / model / skill / tool / memory / workflow / approval
   ├── AgentRouter       (task/error → agent type; autonomous error routing)
   ├── AgentGenerator    (description → agent roster; AI Agent Generator)
   ├── AgentRunner       (execute a plan through one agent → Run)
   │    ├── ContextEngine        (compose focused context, never whole repo)
   │    ├── ModelRouter + Provider
   │    └── ToolRegistry        (permission-gated, dangerous→approval)
   └── WorkflowEngine     (chain agents — QA→Debug→Backend→Review)
```

**AgentRunner** builds a `Run`, composes context, picks a model (with A→B→C fallback), executes a deterministic plan of steps (passed in or generated by `defaultPlanFor`; refined by a real model when configured), records each step's status on the live bus, and gates dangerous/PR steps on human approval.

---

## 6. Provider Architecture

`IModelProvider` interface (chat + listModels + health + resolveApiKey). Concrete adapters:

- `MockProvider` (offline, zero-cost) — default in dev/test.
- `OpenAICompatibleProvider` — OpenAI, OpenRouter, Azure OpenAI, Ollama, custom OpenAI-compatible.
- `AnthropicProvider`, `GeminiProvider`.

`ProviderRegistry` resolves a stored `ModelProvider` entity to a live adapter. Agents never touch a vendor SDK. `ModelRouter` orders candidates by capability/budget/preference; the runner iterates A→B→C on failure.

---

## 7. GitHub Architecture

`IGitHubService` interface + two implementations:

- `RealGitHubService` — REST API via `fetch` (GitHub App/OAuth/token). Used in production.
- `MockGitHubService` — in-memory, used for dev/test/Simulation Mode; also seeds the `.ai-engineering/` structure so workflows run end-to-end offline.

Operations: repos, branches, commits, PRs, issues, releases, files, create branch/commit/PR/issue, comment. Webhook endpoint (`/webhooks/github`) performs **HMAC-SHA256 signature validation** and publishes events (`push`, `pull_request`, `issue`, `release`, `workflow_completed`) onto the event bus, which can trigger workflows/agents.

**Configuration is written to the repo** (`project.yaml`, `agents/*.yaml`, `prompts/*.md`, `skills/`, `memory/`, `rules/`, `workflows/`, `tasks/`, `reports/`, `snapshots/`). On restore, the platform rebuilds the current configuration from GitHub — GitHub is the single source of truth.

---

## 8. Telegram Architecture

`ITelegramService` interface + `TelegramBotApiService` (REST via fetch) and `MockTelegramService` (records messages). `TelegramBot` is project-aware: it keeps the selected project/agent and builds inline keyboards. Commands + natural language are routed to the Agent Manager; approvals are surfaced in chat. Conversation summaries can be pushed to GitHub.

---

## 9. Queue / Worker Architecture

`JobQueue` (backed by `jobs` table) supports idempotent enqueue (correlation-keyed), claim (oldest first), retry, and stats. `Worker` polls and dispatches job types (`agent.run`, `workflow.run`, `telegram.send`, `notify`, `github.op`). Resilience: retry with exponential backoff, dead-letter after max attempts, idempotency, logging. The worker runs in a separate process on Railway and never blocks the UI thread.

---

## 10. Security Model

- **Secret management** — secrets referenced via `secretRef`/env, never stored in repo or exports.
- **RBAC** — `owner/admin/developer/reviewer/viewer` → permission matrix; middleware attaches current user.
- **Webhook signature validation** for GitHub.
- **Dangerous-tool gating** — `dangerous` tools require human approval via `requestApproval` (Telegram default; web UI hooked).
- **No blind changes** — inspect repo → plan → branch → commit → test → PR; production merge/deploy behind approval.
- **SSRF / command protection** — tools run in the isolated workspace; build/test workers are separate services; no arbitrary shell from untrusted input.
- **Audit log** — every sensitive action (agent/project/model/repo/PR/code/deploy/approval) is recorded.
- **Never expose chain-of-thought** — only aggregated action/status/result.

---

## 11. Deployment Architecture

- **Dockerfile** — multi-stage (`build` → `runtime`), non-root user, HEALTHCHECK, layer-cached `npm ci`.
- **`docker-compose.yml`** — single-service local/prod bundle with volume for the runtime DB.
- **`railway.json`** — Dockerfile builder, `/health` healthcheck path, restart policy, `node dist/index.js`.
- **Endpoints** — `/health` (health), `/ready` (readiness), `/live` (liveness).
- **Split services** — on Railway you can run separate `Web/API` and `Worker` services from the same image (a `WORKER_ONLY` env flag is the extension point); DB/queue are the only shared runtime stores.

---

## 12. UI Sitemap

```
/dashboard
/projects                 /projects/:id            /projects/:id/agents|skills|memory|repositories|workflows|tasks|runs|tests|issues|pull-requests
/agents                   /agents/:id
/models                   /providers
/skills                   /workflows               /workflows/:id
/tasks                    /runs                    /runs/:id/console
/conversations            /memory
/integrations/github      /integrations/telegram
/settings                 /settings/import-export
/admin
/search (Command Palette Ctrl+K)
```

The SPA is a single `public/index.html` + `app.css` + `app.js` (no build step), routing by hash. It is responsive, dark/light, RTL/Persian-friendly, with skeleton loading, toasts, tables, dialogs, empty/error states, charts, and live status via Socket.io.

---

## 13. API Design

REST under `/`. OpenAPI/Swagger at `/docs`. Key resource groups (see [API.md](API.md) and `/docs`):

| Resource | Endpoints |
|----------|-----------|
| Health | `/health`, `/ready`, `/live` |
| Dashboard | `/dashboard`, `/dashboard/project/:id` |
| Projects | `/projects*`, `/projects/:id/{agents,skills,memory,workflows,tasks,runs,tests,issues,pull-requests,repositories}`, `/projects/:id/ask`, `/projects/:id/onboard`, `/projects/:id/export` |
| Agents | `/agents*`, `/agents/:id/{enable,disable,history}` |
| Models/Providers | `/models*`, `/providers*` |
| Skills | `/skills*`, `/skills/categories` |
| Workflows | `/workflows*`, `/workflows/:id/run` |
| Tasks/Runs | `/tasks*`, `/runs*`, `/runs/:id/console` |
| Memory | `/memory*` |
| GitHub | `/github/repositories…`, `/webhooks/github` |
| Telegram | `/integrations/telegram/{status,webhook,command,send}` |
| Conversations | `/conversations*` |
| Settings | `/settings`, `/settings/backup`, `/settings/import`, `/settings/approval`, `/projects/:id/export` |
| Observability | `/notifications`, `/costs`, `/costs/summary`, `/audit`, `/observability/agents`, `/logs` |
| Search | `/search?q=` |
| Admin | `/admin/{health,roles,usage,provider-health}` |

Real-time: Socket.io channels `run.updated`, `step.updated`, `task.updated`, `notification`.

---

## 14. Folder Structure

See [README.md](../README.md#-project-structure).

---

## 15. Implementation Roadmap

See [ROADMAP.md](ROADMAP.md) (Phases 1–15). The repository currently implements the foundation and a horizontally-functional slice through all phases (Phase 1–15 as an integrated baseline), with clear extension points for deeper work in each area.
