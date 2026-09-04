# CodeVia — AI Engineering Agent Platform

A **production-ready, multi-project, GitHub-centric, multi-agent, multi-model, Telegram-controlled** AI engineering platform. CodeVia acts as a real **AI Engineering Organization** for each of your software projects — with specialized agents for research, architecture, backend/frontend development, UI/UX, database, DevOps, QA, security, code review, documentation, debugging, refactoring, performance, and release.

> **GitHub is the source of truth.** Persistent project data (agents, prompts, skills, memory, workflows, tasks, decisions, rules) lives in the project repository under `.ai-engineering/`. The database is used only for runtime state, cache, index, search, queue, and cost/usage metrics.

---

## ✨ Highlights

- 🔀 **Multi-project / multi-tenant** — every project has its own agents, models, skills, memory, prompts, workflows, permissions and Telegram chat.
- 🤖 **18 built-in agent types** generated automatically from your project description (**AI Agent Generator**).
- 🧠 **Provider-agnostic model system** — OpenAI, Anthropic, Gemini, Azure OpenAI, OpenRouter, Ollama, custom OpenAI-compatible + a built-in **Mock AI provider** so the whole platform runs offline.
- 🎯 **Intelligent Model Router** — picks a model per task by capability, budget, cost, latency, context size; auto-falls back A → B → C on failure.
- 🗂️ **GitHub-backed Memory** — architecture, decisions, bugs, knowledge, lessons and conversation summaries versioned via commits.
- 🔀 **Workflow Engine** — visual DAG of agent / tool / condition / approval / parallel / trigger nodes.
- 🏃 **Background Worker + Queue** — agent executions never block the UI/API thread; retries, exponential backoff, dead-letter, idempotency.
- 📱 **Telegram bot** — project-aware inline keyboards, natural-language requests (فارسی included) and human approval via Telegram. It receives updates over a **webhook when one is reachable, long polling otherwise**, so a bot token alone is enough — no ngrok, no public URL, and `/ping` tells you exactly which path is live.
- 📊 **Observability** — AI Run Console (observable steps, never chain-of-thought), cost tracking, agent dashboards, audit log, notifications, system health.
- 🔐 **Security-first** — secrets are **references** (env vars / secret manager) only; RBAC, webhook signature validation, request-gated dangerous operations, audit trail.
- 🐳 **Dockerized + Railway-ready** — multi-stage Dockerfile, health/readiness/liveness endpoints, `railway.json`, `docker-compose.yml`, `.env.example`.

---

## 🚀 Quickstart (local, no API keys needed)

```bash
# Install dependencies
npm install

# Run the platform (Mock AI + Mock GitHub + Mock Telegram = fully offline)
npm run dev

# Open the UI
open http://localhost:8080
```

The platform seeds built-in **skills**, **providers** and **mock models** on boot. Create a project and it will automatically generate an agent roster, skills and a workflow.

### Seed a demo project (optional)

```bash
npm run seed
```

### Tests & build

```bash
npm test            # unit + integration + end-to-end (24 tests)
npm run typecheck   # strict TypeScript
npm run build       # compile + copy static UI into dist/
npm start           # run the production build
```

---

## 🧱 Architecture (top-level)

```
System
├── Users / RBAC
├── Providers  (provider-agnostic IModelProvider adapters)
├── Models     (Model Registry + Intelligent Model Router)
├── Skills     (Skill Marketplace, attachable to agents)
├── Agent Templates / Agent Generator
├── Global Settings
└── Projects
    ├── Repositories   (GitHub = source of truth)
    ├── Agents         (18 specialized types)
    ├── Models / Skills / Memory / Prompts
    ├── Workflows      (visual DAG engine)
    ├── Tasks / Runs / Tests / Issues
    └── Telegram Integration (project-aware bot)
```

Runtime topology:

```
Web/API (Fastify + Swagger + Socket.io)
        |
    Orchestrator (Agent Manager)
        |
       Queue
        |
      Worker(s)
        |
      Agents
        |
    Tools → GitHub / Model(s) / Telegram / Memory
```

Logical layers are split into `domain`, `application` (agents/workflow), `infrastruure` (db/github/telegram), `ai`, `tools`, `workers`, `http`.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full architecture document (domain model, database model, security model, deployment model).

---

## 📁 Project structure

```
src/
├── ai/           # providers, model registry, model router, context engine
├── agents/       # agent repo, router, plan, runner, generator, manager
├── db/           # runtime SQLite adapter, document repositories, queue, kv
├── domain/       # domain entities + repositories
├── github/       # GitHub service (real + mock), webhook signature validation
├── http/         # Fastify app + REST/v1 routes + auth
├── integrations/ # Telegram service (real + mock) + bot command handler
├── memory/       # GitHub-backed + local memory stores, resolver
├── observability/# run/cost/audit/notification repositories
├── realtime/     # Socket.io live bus (observable status only)
├── skills/       # skill marketplace catalog + registry
├── tools/        # tool registry + built-in tools (permissioned, dangerous gated)
├── workflow/     # DAG workflow engine
├── workers/      # background queue worker
├── events/       # event-driven bus + correlation ids
└── app/          # composition root (dependency injection)
public/           # SPA (vanilla JS, dark/light, RTL, command palette)
scripts/          # build helper
```

---

## 🌐 Web UI

A modern production-grade SPA (no build step) covering:
`/dashboard`, `/projects`, `/projects/:id`, `/agents`, `/agents/:id`, `/models`, `/providers`, `/skills`, `/workflows`, `/tasks`, `/runs`, `/runs/:id/console`, `/conversations`, `/memory`, `/github`, `/telegram`, `/settings`, `/admin`, `/search`.

Features: responsive, dark/light mode, **RTL/Persian-friendly**, command palette (`Ctrl+K`), toast notifications, skeleton loading, live status via Socket.io, tables, dialogs, empty/error states, AI Run Console (observable steps only), system health.

---

## 📚 Documentation

| Doc | Purpose |
|-----|---------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full architecture, domain model, DB model, security & deployment model |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker + Railway deployment guide |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | Environment variables / secret references guide |
| [docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md) | GitHub App + OAuth + webhook setup |
| [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md) | Telegram bot setup & commands |
| [docs/PROVIDER_SETUP.md](docs/PROVIDER_SETUP.md) | Configure AI providers (OpenAI, Anthropic, Gemini, Ollama…) |
| [docs/API.md](docs/API.md) | REST API reference (OpenAPI at `/docs`) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Implementation roadmap (Phases 1–15) |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues & fixes |
| [docs/SYSTEM_BACKUP.md](docs/SYSTEM_BACKUP.md) | Full runtime backup to GitHub, scheduling, restore |

---

## 🔑 Security principles

- **Secrets are references only.** The repo config stores `secretRef: OPENAI_API_KEY`, never the key. Real values come from Railway Variables / Secret Manager / env.
- **Webhook signature validation** (HMAC-SHA256) for GitHub.
- **RBAC** (Owner / Admin / Developer / Reviewer / Viewer) gating use of agents, models, providers, workflows, deployments, and secrets.
- **Dangerous tools** (`write`, `merge`, `deploy`, `migration`, `shell`) are flagged `dangerous` and require **human approval** (Telegram/UI).
- **No blind changes** — agents inspect the repo, plan, and open a PR; production merges/deploys need approval.
- **Never expose chain-of-thought** — the UI/Telegram show only action, tool, status, result.

---

## 🧩 Implementing a feature end-to-end

```
User (UI/Telegram)
  │  "در پروژه X Login را بررسی کن و تست Authentication را اجرا کن"
  ▼
Project detection → GitHub changes → Agent Router → Context Engine
  → Model Router → Agent → Tools → GitHub commit → QA → result
  → Telegram notification → human approval on merge
```

---

## ⚖️ License

MIT — see [LICENSE](LICENSE).
