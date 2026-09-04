# Implementation Roadmap

The platform is built to land each phase as a horizontally-functional baseline, with clear extension points for deeper implementation. Below is the phased plan mapped to the repository's current state.

| # | Phase | Status | Notes |
|---|-------|--------|-------|
| 1 | Architecture + Foundation | ✅ | Layered structure, DI container, config, logging, event bus, SQLite adapter, document repositories, queue |
| 2 | Authentication + Projects | ✅ | User/RBAC middleware (default owner), multi-project CRUD, per-project resources |
| 3 | GitHub Integration | ✅ | `IGitHubService` (real + mock), webhook signature validation, repo ops, mock seeds `.ai-engineering/` |
| 4 | AI Provider + Model Registry | ✅ | `IModelProvider` adapters (OpenAI/Anthropic/Gemini/mock), Provider Registry, Model Registry, Model Router |
| 5 | Agent Engine | ✅ | Agent registry/router/plan/runner/generator, Agent Manager (orchestrator), autonomous error routing |
| 6 | Memory + Skill Engine | ✅ | GitHub-backed memory store (+ local), multi-level memory, Context Engine, Skill registry/marketplace |
| 7 | Workflow Engine | ✅ | DAG of agent/tool/condition/approval/parallel/trigger nodes |
| 8 | Telegram Integration | ✅ | `ITelegramService` (real + mock), project-aware bot with inline keyboards + commands + NL |
| 9 | QA + Testing Automation | ✅ | QA agent, test failure classification, self-healing re-route (QA→Debug→Backend) |
| 10 | Advanced UI | ✅ | SPA: dashboard, projects, agents, models, providers, skills, workflows, runs console, settings, admin, search, command palette, dark/light, RTL |
| 11 | Observability + Cost Tracking | ✅ | Run console, cost tracking + summary, agent observability, audit log, notifications |
| 12 | Security Hardening | ✅ | RBAC, webhook signature validation, secret refs, dangerous-tool approval gating, no-CoT policy |
| 13 | Docker + Railway Deployment | ✅ | Multi-stage Dockerfile, docker-compose, railway.json, health/ready/live, `.env.example` |
| 14 | Production Testing | ✅ | 24 unit/integration/e2e tests (router, webhook, context, repo, agent e2e) |
| 15 | Documentation | ✅ | README + full docs (architecture, deployment, env, github, telegram, provider, api, roadmap, troubleshooting) |

## Extension points (next)

- **Visual Workflow Builder UI** — nodes/edges drag-&-drop on top of the existing engine.
- **Postgres adapter** — swap `Db` (repository abstraction already isolates the change).
- **Redis-backed queue** for multi-worker scale-out.
- **Scheduler service** for periodic jobs (checks, budget resets, memory rehydration).
- **GitHub App installation-token exchange** for per-install auth.
- **Deeper repository intelligence** (language/framework detection, change-impact mapping).
- **Multi-turn agent loops with real providers** (the runner already supports provider-driven planning).
- **Simulation/Dry Mode UI toggle** for previewing agent plans before writing code.
- **Budget guardrails at runtime** (already wired) surfaced in the UI.
- **Observe rate limits / circuit breakers** per provider.
