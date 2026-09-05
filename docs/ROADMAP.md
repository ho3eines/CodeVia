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

## Delivered after the baseline

- **Human-in-the-loop approvals** — `ApprovalService` (policy in KV, persisted requests, web + Telegram ✅/❌ buttons, expiry, audit); tasks show `waiting_for_approval`.
- **GitHub event automation** — push→QA, PR opened→Code Reviewer, PR sync→QA, issue→Research, release→Release, failed CI→Debugging; delivery-id idempotency.
- **Prompt versioning** — immutable versions per edit, LCS diff, restore/clone (history never rewritten).
- **Automatic rules discovery** — README/CONTRIBUTING/CODEOWNERS/.editorconfig/build files/CI → project rules injected by the Context Engine; manual rules preserved.
- **Budget control at runtime** — tokens / cost / duration / calls per run + agent budget; `BudgetExceededError` fails the run before repository writes.
- **Dry run / Simulation** — `POST /projects/:id/dry-run` previews agent, plan, writes and approvals.
- **Logs & Approvals pages** in the UI, `/approvals` + `/logs` Telegram commands.
- **Queue fix** — `claim()` no longer re-hands out jobs that are still running (previously a run blocked on approval was re-executed every poll).
- **Tool permission matrix enforced at runtime** — `ToolRegistry.execute` denies tools outside the agent's permissions, gates every `dangerous` tool through the approval channel, and applies per-tool timeouts.
- **New tools** — `search` (project memory + repository paths), `save_memory` (GitHub-backed memory), `create_branch`, `merge_pull_request` (dangerous); `create_pull_request` now writes a grounded Summary/Changes/Tests/Risks/Breaking-Changes body.
- **AI context compression** — conversation summaries go through the model router (`AiTextService`, cost tracked, automatic fallback) with a deterministic heuristic when no provider is active.
- **Full project import** — `/settings/import` handles agents, workflows, memory and skills with `dryRun` preview, `mode=create|merge`, `conflict=skip|overwrite` and id remapping.
- **Workflow builder page** — `#/workflows/:id`: DAG preview (SVG), node/edge editor, JSON view, run/enable/delete, recent executions.
- **Cooperative task cancellation** — `POST /tasks/:id/cancel` drops queued jobs and stops running plans between steps (`cancelled` run/task status).
- **Worker `github.op` jobs** — comment/issue/PR update/branch/merge (merge requires an approval id).
- **HTTP hardening** — security headers + per-IP rate limit (`RATE_LIMIT_PER_MINUTE`, `SECURITY_HEADERS`), health/webhooks exempt.
- **Memory bug fix** — local memory `search()` without `types` never matched (iterated `Object.keys([...])`).

## Extension points (next)

- **Drag-&-drop workflow canvas** — the builder page is form/graph based today; free-form dragging is the next step.
- **Postgres adapter** — swap `Db` (repository abstraction already isolates the change).
- **Redis-backed queue** for multi-worker scale-out.
- **Scheduler service** for periodic jobs (checks, budget resets, memory rehydration).
- **GitHub App installation-token exchange** for per-install auth.
- **Deeper repository intelligence** (language/framework detection, change-impact mapping).
- **Multi-turn agent loops with real providers** (the runner already supports provider-driven planning).
- **Observe rate limits / circuit breakers** per provider.
