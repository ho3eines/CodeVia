# CodeVia — AI Engineering Agent Platform

[![CI](https://github.com/ho3eines/CodeVia/actions/workflows/ci.yml/badge.svg)](https://github.com/ho3eines/CodeVia/actions/workflows/ci.yml)

A **multi-project, GitHub-centric (or 100% local — see [Local Git Mode](docs/LOCAL-GIT-MODE.md)), multi-agent, multi-model, Telegram-controlled** AI engineering platform under active development. CodeVia provides agent definitions and execution paths for research, architecture, backend/frontend development, UI/UX, database, DevOps, QA, security, code review, documentation, debugging, refactoring, performance, and release; not all roles have a complete autonomous implementation.

> **📖 [راهنمای کامل راه‌اندازی (فارسی)](docs/SETUP_GUIDE.md)** — از نصب محلی تا اتصال OpenAI، GitHub OAuth، Telegram، استقرار Railway/Docker و اجرای اولین Task خودکار.

> **Readiness note (2026-09-12):** the [historical completeness audit](docs/PIPELINE_AUDIT.md) reproduced 18 targeted gaps before the repository-first work; all 18 are closed. **Per-account isolation** covers GitHub credentials, projects, models/providers, and every by-id entity route (`/tasks/:id`, `/runs/:id`, `/conversations/:id`, `/approvals/:id`) is now gated directly at the handler, not just indirectly through a global hook — see [docs/MULTI_USER_ISOLATION.md](docs/MULTI_USER_ISOLATION.md). Operator-level admin feeds and settings stay account-independent **by design**. Review the [remaining gaps table](docs/MULTI_USER_ISOLATION.md#6-known-remaining-gaps-not-fixed-here) before a sensitive multi-user deployment.

> **Repository-backed project knowledge.** The platform stores full skills, agents/prompts and prompt history, rules, memory, workflows, tasks, runs and conversations under **`CodeVia/`**. The [repository-state audit](docs/REPOSITORY_STATE_AUDIT.md) previously reproduced 8 gaps (context consumption, terminal history, deletion/copy, legacy migration, error handling); **all 8 are now closed** and `scripts/audit-repository-state.mjs` exits `0`. Credentials, accounts and live queue state remain local by design and are **not** pushed into a project repository — they are covered by the [full system backup](docs/SYSTEM_BACKUP.md) instead. Take one before migrating legacy projects. See the [format and usage guide](docs/REPOSITORY_STATE.md).

### Gap status at a glance (2026-09-12)

| ID | Gap | Status |
|----|-----|--------|
| R01–R08 | Repository-state audit gaps (context consumption, terminal history, tombstones, legacy migration, sync retry, fail-closed schema) | ✅ Closed — `scripts/audit-repository-state.mjs` exits 0 |
| S01 | By-id routes gated only indirectly through the global hook | ✅ Closed — direct `canAccessEntity` gate in every by-id handler (tasks, runs, conversations, approvals, agents, workflows, memory, project-local skills) and the create routes; marketplace templates and platform memory stay shared by design. 10 regression tests |
| S02 | Runtime dependency advisories (npm audit high/moderate) | ✅ Closed — 0 vulnerabilities (`npm audit --omit=dev`), audited in CI |
| S03 | Admin-level feeds shared across accounts | ⚠️ Operator endpoints by design; project-scoped feeds are per-account |
| S04 | SPA without a build step | 🗺️ Roadmap — incremental React/Vite migration planned |
| S05 | SQLite for sensitive multi-user deployments | 🗺️ Roadmap — Postgres adapter behind the repository interface |
| S06 | Rate limiting + structured logging | ✅ Closed — per-IP limiter (`RATE_LIMIT_PER_MINUTE`), redacted JSON logs, HTTP access log with correlation ids |
| D01–D03 | Docs: CI badge owner, `infrastruure` typo, mixed FA/EN docs | ✅ Typo fixed; badge targets the canonical upstream repo; docs stay bilingual by design |

---

## ✨ Highlights

- 🔀 **Multi-project organization** — project-scoped agents, model assignments, skills, memory, prompts, workflows and Telegram chats. Projects, models and providers are isolated per account (a signed-in account sees only its own); see [docs/MULTI_USER_ISOLATION.md](docs/MULTI_USER_ISOLATION.md).
- 🤖 **18 built-in agent types** generated automatically from your project description (**AI Agent Generator**).
- 🧠 **Provider-agnostic model system** — OpenAI, Anthropic, Gemini, Azure OpenAI, OpenRouter, Ollama, custom OpenAI-compatible + a built-in **Mock AI provider** so the whole platform runs offline. Providers and models belong to the account that created them; routing never spends another account's key.
- 🎯 **Intelligent Model Router + load distribution** — picks a model per task by capability, budget, cost, latency and context size, then decides *which of those eligible models should answer now*: adaptive / round-robin / weighted / least-loaded, with a concurrency ceiling, a circuit breaker for models that keep failing and automatic fallback A → B → C. No single provider key carries the whole installation while the rest of the registry idles (a model the user explicitly picked is still pinned). See [docs/MODEL_ROUTING.md](docs/MODEL_ROUTING.md).
- 🖥️ **100% Local Git Mode** — flip one env flag and the GitHub service layer is replaced by the **system git binary**: every file write, PR, issue, comment and merge runs against repositories on your own disk — no `api.github.com`, no OAuth, no tokens. Pushing to a real remote stays **optional** and is performed by your own system git with its own Credential Manager / SSH keys (`LOCAL_GIT_AUTO_PUSH`). Agent/orchestrator logic is untouched — only the service layer is swapped behind the `IGitHubService` interface. See [docs/LOCAL-GIT-MODE.md](docs/LOCAL-GIT-MODE.md).
- 🗂️ **GitHub-backed Memory** — architecture, decisions, bugs, knowledge, lessons and conversation summaries versioned via commits.
- 🔀 **Workflow Engine** — visual DAG of agent / tool / condition / approval / parallel / trigger nodes.
- 🏃 **Background Worker + Queue** — agent executions never block the UI/API thread; retries, exponential backoff, dead-letter, idempotency.
- 📱 **Telegram bot** — project-aware inline keyboards, natural-language requests (فارسی included) and human approval via Telegram. It receives updates over a **webhook when one is reachable, long polling otherwise**, so a bot token alone is enough — no ngrok, no public URL, and `/ping` tells you exactly which path is live.
- 🔍 **Repository-aware chat** — the project chat is given real evidence (whole-repo file tree, README, manifests), cached per account+repo+branch, with a branch self-heal and a **repository health banner** (`GET /projects/:id/repo-status`) that states *why* a repository could not be read instead of letting the model invent a 404.
- 📚 **Read-only local mirror** — evidence is read from a per-account bare clone with git *plumbing* (`ls-tree` / `cat-file` / `grep`), so large repositories answer from disk and agents get real content search; every failure falls back to the Git Trees API path. **No repository code is ever executed on the host** — writes go through the GitHub API and verification runs either in the Docker sandbox below or in the repository's own CI (in [Local Git Mode](docs/LOCAL-GIT-MODE.md), writes go through the local git backend and the mirror is auto-disabled).
- 🧪 **Real test/build execution in a Docker sandbox** — per-project `install` / `build` / `test` / `lint` / `start` commands (editable in Project → Edit → Operations, auto-detected from the stack) run inside a disposable container with `--network=none`, `--read-only`, `--cap-drop=ALL`, `no-new-privileges`, PID/CPU/memory limits and no host shell. Results are recorded as `passed` / `failed` / `unverified` with exit code and output tails. A folder project created with `gitInit: false` has no repository, so the sandbox reads `project.localPath` directly (same file/size/symlink/secret guards) and says so; a missing image yields the exact `docker pull <image>` command (`PROJECT_SANDBOX_IMAGE_PULL=missing` can inspect/pull explicitly, while the run keeps `--pull=never`). GitHub-backed projects verify through their own CI checks (no container), and local projects never fall back to a host shell. See [docs/AGENT_EXECUTION.md](docs/AGENT_EXECUTION.md).
- 📦 **ZIP/RAR project import & local project creation** — upload a `.zip`/`.rar` (bounded in-memory parsing, traversal/symlink/zip-bomb/CRC checks) or start from nothing; CodeVia writes the files into a fresh `local/<slug>` Git repository with one atomic initial commit, so agents can branch, commit and open Draft PRs without GitHub. Secret-bearing files are excluded before anything is written. `.rar` works out of the box in the bundled image (`p7zip-full`, `PROJECT_IMPORT_7Z_BIN=/usr/bin/7z`). See [docs/LOCAL-FOLDER-PROJECTS.md](docs/LOCAL-FOLDER-PROJECTS.md).
- 📊 **Observability** — AI Run Console (observable steps, never chain-of-thought), cost tracking, agent dashboards, audit log, notifications, system health.
- 🔐 **Security building blocks** — secret references, OAuth login, per-account GitHub tokens (every project action runs with *your* token, not a server PAT), role definitions, webhook signature validation, approval controls and audit events. Some global admin feeds are still shared; see the [remaining gaps](docs/MULTI_USER_ISOLATION.md#6-known-remaining-gaps-not-fixed-here).
- 💾 **Full portable backup** — one JSON file holds *everything*: every runtime row **plus the environment and the API keys/tokens** that made it work. Download it from `Settings`, restore it on any other server (UI upload or `npm run backup:restore`), and the platform comes back complete — credentials are re-encrypted with the new server's `AUTH_SECRET` and the environment is written to `<db dir>/.env` so it survives a restart. Snapshots also go to a GitHub repo and/or the mounted volume on a cron schedule, with SHA-256-verified parts and optional `BACKUP_PASSPHRASE` protection. See [docs/SYSTEM_BACKUP.md](docs/SYSTEM_BACKUP.md).
- 🐳 **Dockerized + Railway-ready** — multi-stage Dockerfile (optional Docker CLI via `--build-arg INSTALL_DOCKER_CLI=true`, daemon never installed; socket/sidecar notes with a security warning in `docker-compose.yml`), health/readiness/liveness endpoints, `railway.json`, `docker-compose.yml`, `.env.example`.

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

The platform seeds built-in **skills**, **providers** and **mock models** on boot. Create a project and it first reads `CodeVia/` from its connected repository. Existing material is reused; only missing definitions are authored. Real repositories need an active model to generate missing material; offline Mock scaffolds are labelled simulation. In mock/demo mode the system is self-healing: a project that references a repository the simulation never created (restored database, lost mock snapshot) gets that repository auto-provisioned — with the project's branch — and its missing `CodeVia/` state initialized once, so no page or project option ever fails with "Mock repo not found" (see [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)).

> **📖 For a complete walkthrough (from local dev to your first autonomous task on a real repo), see the [راهنمای راه‌اندازی (Persian Setup Guide)](docs/SETUP_GUIDE.md).**

### Seed a demo project (optional)

```bash
npm run seed
```

### Tests & build

```bash
npm test            # unit + integration + end-to-end (1195 tests)
npm run smoke       # one-command live verification (33 checks, isolated port + temp DB)
npm run backup      # full portable backup (every row + API keys + env) → data/codevia-backup.json
npm run typecheck   # strict TypeScript
npm run build       # compile + copy static UI into dist/
npm start           # run the production build
```

> Testing guide (step-by-step, incl. manual UI scenarios): [`TESTING.md`](TESTING.md).
> Coding-agent execution, CI setup, draft PRs and simulation semantics: [`docs/AGENT_EXECUTION.md`](docs/AGENT_EXECUTION.md).

### 🧭 What works without Docker, a real model, or git

"Without git" means neither GitHub nor Local Git; "without a real model" means only the Mock AI provider; "without Docker" means no container is ever started. Every row is covered by repository tests.

| Capability | Without Docker | Without a real model (Mock) | Without git / GitHub |
|---|---|---|---|
| UI, login, folder scan (`POST /projects/scan`) | ✅ | ✅ | ✅ |
| Folder project, `gitInit: false` (`POST /projects/from-local`) | ✅ | ✅ | ✅ — `sourceType: "local"`, no `configRepo` |
| Folder project, `gitInit: true` | ✅ (system git only) | ✅ | ✅ — local-git repository |
| `POST /projects/new-local`, ZIP `POST /projects/import` | ✅ (system git only) | ✅ | ✅ — repository `local/<slug>` |
| RAR `POST /projects/import` | ✅ | ✅ | ✅ — needs `7z` (bundled in the image) |
| Analysis, file list, search, project `analysis` | ✅ | ✅ | ✅ |
| **`install/test/lint/build` for a git-less folder project** | ❌ → `unverified` / `sandbox: "unavailable"` | ✅ (the model is irrelevant) | ✅ — source read from `project.localPath` |
| Project commands for a local project with a repository | ❌ → `unverified` | ✅ | ✅ — local-git, no GitHub |
| GitHub-backed verification through CI checks | ✅ | ❌ → `simulated` | ❌ — needs GitHub |
| Simulation mode (`executionMode: "simulation"`) | ✅ | ✅ | ✅ — plan only, writes nothing |
| Autonomous/Agent/Workflow task that **really changes code** | depends on the path | ❌ → scaffold/TODO or `simulated`, no real edit | ❌ — needs a repository for commit/PR |
| Draft PR, merge and the QA loop | — | ❌ | needs GitHub or Local Git |
| Full backup / restore | ✅ | ✅ | ✅ |

A git-less folder project **can** verify (the sandbox reads `localPath` directly), but an implementation request is still refused with `409` / `repositoryRequired: true` because there is nowhere to commit. Re-create it with `gitInit: true` or import a ZIP/RAR for the full chain.

### Local project curl recipes

```bash
BASE=http://localhost:8080
# When REQUIRE_AUTH=true add the session cookie: -b "codevia_session=…"

# scan a server folder (no project created)
curl -s $BASE/projects/scan -H 'content-type: application/json' \
  -d '{"path":"/srv/repos/shop3"}' | jq .analysis.suggestions

# folder project without git (verification runs from localPath)
curl -s $BASE/projects/from-local -H 'content-type: application/json' \
  -d '{"path":"/srv/repos/shop3","overrides":{"name":"Shop 3"}}'

# same folder as a Local Git repository (agents can commit / open PRs)
curl -s $BASE/projects/from-local -H 'content-type: application/json' \
  -d '{"path":"/srv/repos/shop3","gitInit":true,"overrides":{"name":"Shop 3"}}'

# new empty project: README + one initial commit
curl -s $BASE/projects/new-local -H 'content-type: application/json' \
  -d '{"name":"Shop 3"}'

# ZIP/RAR import → repository local/<slug>
curl -s $BASE/projects/import -F name='Shop 3' -F file=@shop3.zip

# create a task, then run it (projectId comes from the responses above)
curl -s $BASE/tasks -H 'content-type: application/json' \
  -d '{"projectId":"proj-1a2b3c4d","title":"Add a login page","description":"Email + password"}' | jq .
TASK_ID=task-1234abcd
curl -s -X POST "$BASE/tasks/$TASK_ID/run" | jq .
```

---

## 🖥️ Run 100% locally — Local Git Mode (no GitHub, no OAuth, no tokens)

Flip one flag and the entire GitHub service layer is swapped for the **system git binary**:
every file write, PR, issue, comment and merge runs against repositories on your own disk
via git *plumbing* — `api.github.com` is never called, no OAuth, no server PAT. Pushing to
a real remote (GitHub, GitLab, anything) stays **optional** and is performed by your own
system git with its own credentials.

```bash
# 1) install
git clone https://github.com/ho3eines/CodeVia.git
cd CodeVia
npm install

# 2) configure .env
LOCAL_GIT_MODE=true
LOCAL_REPOS_DIR=D:/Hermes/repos     # repositories live as <dir>/<owner>/<repo>
LOCAL_GIT_OWNER=local               # default owner for repos without one

# optional — push every agent commit through your own git credentials
LOCAL_GIT_AUTO_PUSH=true
LOCAL_GIT_REMOTE=origin

# optional — real verification command instead of CI check runs
LOCAL_GIT_VERIFY_CMD="cmd /c build.cmd"

# 3) run
npm run dev                         # UI: http://localhost:8080
```

**Safety model** (each property is covered by tests):

- **Your working copy is never touched** — agent commits are built in a temporary index and
  only changed paths are synced back; dirty files are never overwritten.
- **Byte-exact storage** — blobs are hashed with `git hash-object --no-filters`, identical
  to the GitHub Contents API, so the EOL patch engine keeps working.
- **No worktrees, no fake checks** — merges use `git merge-tree --write-tree` (git ≥ 2.38);
  the only required check is a real `local-git-integrity` (commit exists in the object DB)
  plus your own `LOCAL_GIT_VERIFY_CMD` if configured.
- **Crash-safe** — stale-lock detection with auto-retry, a `.bak` before every metadata
  rewrite, and corrupt metadata never resets silently.
- **Stable error contract** — 11 local-git error codes with `statusCode` / `status` /
  `retryable` / `committed`, wired into routes, worker and repo-brief.
- **Concurrency-safe** — per-repository metadata locking and batched git argv so large
  commits never hit the Windows argv limit.

**Notes:**

- PRs and issues are stored in `<repo>/.git/codevia-local-meta.json` (inside `.git` —
  invisible to your IDE, never cloned with the repo).
- Repositories that already carry a valid `CodeVia/` state folder onboard with **no model
  at all**; fresh repositories need a real AI model (Ollama / OpenRouter / …) for the
  initial state generation — simulated state is never written to a real repository
  (a seeding workaround is documented).
- The read-only mirror is auto-disabled in local mode (path search still works); content
  search can be re-enabled with a `file://` mirror template.

Full guides: **[docs/LOCAL-GIT-MODE.md](docs/LOCAL-GIT-MODE.md)** (EN) ·
**[docs/LOCAL-GIT-MODE-FA.md](docs/LOCAL-GIT-MODE-FA.md)** (🇮🇷 فارسی)

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

Logical layers are split into `domain`, `application` (agents/workflow), `infrastructure` (db/github/telegram), `ai`, `tools`, `workers`, `http`.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full architecture document (domain model, database model, security model, deployment model).

---

## 📁 Project structure

```
src/
├── ai/           # providers, model registry, model router, context engine
├── agents/       # agent repo, router, plan, runner, generator, manager
├── db/           # runtime SQLite adapter, document repositories, queue, kv
├── domain/       # domain entities + repositories
├── github/       # GitHub service (real + mock), local git CLI backend, webhook signature validation
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
public/           # SPA runtime (vanilla JS, dark/light, RTL, command palette)
client/app/       # SPA source split into feature modules (assembled into public/app.js)
scripts/          # build/audit helpers (build-app.mjs assembles the SPA)
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
| [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md) | **🇲🇩 راهنمای کامل راه‌اندازی (فارسی)** — from install to first autonomous task |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full architecture, domain model, DB model, security & deployment model |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker + Railway deployment guide |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | Environment variables / secret references guide |
| [docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md) | GitHub App + OAuth + webhook setup |
| [docs/LOCAL-GIT-MODE.md](docs/LOCAL-GIT-MODE.md) | Run 100% locally — system git binary instead of GitHub (setup, safety model, tests) |
| [docs/LOCAL-GIT-MODE-FA.md](docs/LOCAL-GIT-MODE-FA.md) | 🇮🇷 راهنمای فارسی حالت لوکال |
| [docs/LOCAL-FOLDER-PROJECTS.md](docs/LOCAL-FOLDER-PROJECTS.md) | Create projects from server folders, ZIP/RAR uploads or scratch — filesystem scan + local Git repository, no GitHub required |
| [docs/AGENT_EXECUTION.md](docs/AGENT_EXECUTION.md) | Execution contract: branches, atomic commits, Draft PRs, Docker sandbox, QA/fix loop and verification semantics |
| [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md) | Telegram bot setup & commands |
| [docs/PROVIDER_SETUP.md](docs/PROVIDER_SETUP.md) | Configure AI providers (OpenAI, Anthropic, Gemini, Ollama…) |
| [docs/MODEL_ROUTING.md](docs/MODEL_ROUTING.md) | Model selection, load balancing policies, pins, circuit breaker, live distribution |
| [docs/API.md](docs/API.md) | REST API reference (OpenAPI at `/docs`) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Implementation roadmap (Phases 1–15) |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues & fixes |
| [docs/SYSTEM_BACKUP.md](docs/SYSTEM_BACKUP.md) | Full portable backup — every row **plus API keys & environment** — to GitHub/volume/one JSON file, scheduling, and restoring on a new server |

> Documentation is intentionally bilingual: user-facing guides and audits are written in Persian (فارسی), engineering/architecture references in English. Treat both languages as equally authoritative.

Governance: [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Issue templates & PR checklist](.github/)

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
