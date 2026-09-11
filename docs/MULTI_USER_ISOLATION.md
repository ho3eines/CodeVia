# Per-account isolation — audit + design

**Status (2026-09-11):** implemented for **GitHub credentials**, **projects** and the
**model registry (models + providers)**. Read this before touching any of the three:
the rules are intentionally identical across them so HTTP, realtime, background
workers and Telegram behave the same way.

The short version of the problem this document fixes:

1. Several GitHub paths still fell back to the platform-wide `GITHUB_TOKEN` (or to the
   mock) even when the caller was logged in with GitHub.
2. A project with **no owner** (or owned by the pre-login `user-demo`) was visible to
   *every* account. That is the reported "I see other users' projects and then it
   errors": the row is visible, the repository is not, so the first GitHub call made
   with **this** account's token fails (404 / no access) and the project page dies.
3. Models and providers were one **global** table: every signed-in account saw — and
   could edit, delete, test and *spend* — every other account's providers.

---

## 1. The ownership rule (one rule, three resources)

`src/http/auth.ts` → `canAccessProject()` (projects) and `src/ai/ownership.ts` →
`rowVisibleTo()` (models/providers) implement the same predicate:

| Caller | Sees |
| --- | --- |
| **Demo / unauthenticated** (`user-demo`, auth off) | everything — a single-user or simulation install must not lose access to anything |
| **Signed-in account** | only rows it owns (`ownerId === user.id`) |
| **Shared / platform row** (`ownerId` absent) | visible to every account *until an account edits it* (see §3) — these are the seeded defaults (Mock AI, OpenAI, Anthropic, Gemini) and rows written before per-account ownership existed |

Writes are stricter than reads: mutating a shared row **hands it to the acting
account** (`adoptRowForMutation` for models/providers, `adoptStrandedProject` /
`adoptProjectConnection` for projects). A shared row is visible to everyone, so an
in-place edit would publish one account's API key — or its whole project — to
everyone else.

Exception: the **built-in offline fallback** (`provider-mock` + `model-mock-*`) is
protected. It carries no secret and every account needs it, so it is never adopted
and cannot be deleted by an account (deactivate it, or duplicate it to get a
personal copy).

---

## 2. GitHub: every path uses the account's own token

### Resolution order

1. **`resolveGitHubForUser()`** — interactive endpoints (repo picker, `/github/*`,
   GitHub page, admin, settings, project creation, backup settings). Prefers the
   signed-in user's stored OAuth token, then the server `GITHUB_TOKEN`, then the
   mock. Reports which one it used (`source` + `hint`) so the UI can explain itself.
2. **`resolveGitHubForProject()`** — anything project-scoped. The **request user
   acts as themselves** (`requestUserId`, or the AsyncLocalStorage actor bound by
   `src/http/app.ts` for chat/persist paths that have no request object), then the
   connection stored on the project, then the platform fallback.
3. **Background work** (workers, webhook automation, schedules) has no request user
   and uses the connection stored on the project — never another account's token.

### Call-site map (after this change)

| Where | Credential | Notes |
| --- | --- | --- |
| `/github/repositories*`, `/integrations/github/status`, admin, settings, `POST /projects` | `resolveGitHubForUser` | user token first |
| `/projects/:id/**` (files, commits, PRs, issues, branches, repositories, ask, dry-run) | `githubForProject(req, p)` | request user first |
| `project-state` (CodeVia sync), `project-files`, chat persist, `readProject` | `githubForProject` via request actor (ALS) | request user first |
| Definition sub-resources (agents, workflows, skills, memory, conversations, tasks, runs) | `registerProjectStateHook` → `adoptProjectConnection` | binds the acting owner before every write |
| Telegram bot | `githubForProject(project, userId)` for per-user bots; stored connection for the operator bot | |
| Workers / GitHub webhook automation | stored project connection | unattended — cannot borrow a session |
| **System backup** | **the admin's stored OAuth token** (`backup.settings.githubUserId`), falling back to the server `GITHUB_TOKEN` | *new* — backups are unattended, so the account that configured the repository lends its encrypted token instead of requiring a server PAT |

Anything that still ends on the platform-wide service reports it (`source`,
`githubKind`, `hint`) instead of silently pretending it is the user's account.

### Adoption / repair paths

* **At login** — `adoptStrandedProjects()` hands over projects whose connection is
  dead **and** that are owned by `user-demo` **or by nobody at all** (`ownerId`
  empty used to be skipped, which left them invisible to every signed-in account).
  A project with a live connection of another account is never touched.
* **On any project request** — `adoptStrandedProject()` (in the preHandler hook,
  *before* the ownership gate, and in the `/projects/:id` routes) hands a stranded
  project to the connected account that opens it. Adopting after the gate would be
  useless: the gate has already answered 404.
* **Before definition writes** — `adoptProjectConnection()` re-binds the connection
  to the acting owner without ever stealing a live foreign connection.

---

## 3. Models & providers

* `ModelProvider.ownerId` / `Model.ownerId` (`src/domain/entities.ts`); a model
  inherits its provider's owner.
* Repositories gained owner-scoped reads: `listForOwner()`, `listActiveForOwner()`,
  `findVisibleById()` (`src/ai/model-repo.ts`).
* **`/models` and `/providers`** (`src/http/routes/models-providers.ts`) — every
  list, read, patch, delete, activate/deactivate, test, stream, sync-models,
  duplicate and bulk action is now scoped. A foreign row reads as **404** (no
  existence leak); bulk actions report it in `missing`/`skipped` instead of acting.
  New rows are created with `ownerId = <acting account>`; models inherit the
  provider's owner; a duplicate is always the caller's own copy.
* **Runtime routing is scoped too** — this is what stops one account from spending
  another's key:
  * `realChatFor()` (agent runs, autonomous loop) → `ownerId: project.ownerId`
  * `AiTextService.complete()` → `ownerId` (project owner, else the signed-in user):
    chat, conversation summaries, PR text
  * conversation streaming (`resolveOrderedModels`) → project owner or request user
  * math benchmark (`/models/benchmark/*`) → the requesting account's models only
  * `AgentGenerator` (agent model assignment) and `ProjectStateGenerator` (AI
    authoring of missing CodeVia state) → the project owner's models
* **Backwards compatibility:** rows written before this change have no `ownerId`
  and stay visible to everyone (including the demo user), so an existing install
  keeps working; the first edit hands them to the account that made it.
* **UI:** the Models and Providers pages mark those shared rows with a
  `👥 shared` badge, and the Providers page explains that anything you add is
  yours alone.

---

## 4. Projects

* `canAccessProject()` is now strict for signed-in accounts (see §1). The demo
  identity still sees everything.
* Scoped to the same project set: `/dashboard` (+ `/dashboard/project/:id`),
  `/search`, `/tasks`, `/runs`, `/memory`, `/costs`, `/costs/summary`,
  `/observability/agents`, `/approvals`.
  (`accessibleProjectIds()` in `src/http/project-access.ts` is the single source of
  that set and is shared with the definition sub-resource routes.)
* Realtime: Socket.io room authorization calls the same `canAccessProject`, so an
  authenticated socket can no longer join a project it does not own.
* Migration: pre-login rows are handed over at login (§2) — nothing disappears for
  the installation that owns them, and a second account never sees them.

---

## 5. Verification

`src/tests/multi-user-ownership.test.ts` (new, 8 tests) covers:

* another account's provider/model is hidden from list, read and every mutation;
* bulk actions skip foreign rows instead of acting on them;
* editing a shared platform row adopts it (and its key) into the acting account;
* the built-in offline fallback stays shared and undeletable;
* the demo identity still sees every row;
* **model routing never calls another account's provider** (fake provider registry
  records which provider was used);
* dashboard counters, global search, tasks, runs and costs are per-account.

`src/tests/security-regressions.test.ts` (A02/A03) was updated to the stricter rule:
unowned projects are hidden from other accounts and handed over at login /
reclaimed by the account that owns the repository, and a reconnecting socket still
never receives another account's events.

Incidental fix: `getModelBenchmarkRepo()` cached its repository against the database
that happened to be active on first use, so after any database swap (every test, and
any runtime reconfiguration) the handle was closed and *every* model call failed with
`database is not open`. Re-binding it took the suite from **42 failing tests to 5**
(the 5 remaining failures — 4 Telegram-bot menu/auto-select tests and 1 Telegram
approval test — fail identically on the unmodified baseline and are unrelated to
isolation).

---

## 6. Known remaining gaps (not fixed here)

| Gap | Why it is still open |
| --- | --- |
| ~~`/notifications` and `/audit` are global feeds~~ | **Closed:** notifications are filtered to the account's projects (platform-wide ones with no project stay visible — that is what the bell expects), `/notifications/:id/read` answers 404 for a foreign id, and audit entries are visible when they belong to an accessible project, record your own action, or (for platform-level rows with neither) when your role has `admin.read`. |
| Skills marketplace (`/skills` without `projectId`) | Global template catalogue by design; project-local skills *are* scoped. |
| Telegram per-user bots still list **ownerless** projects | `ownedProjects()` keeps `!p.ownerId \|\| p.ownerId === userId` so an install with pre-login projects keeps working in the bot. It never exposes another account's owned projects. |
| Admin settings, import/export, `/admin/usage` | Operator-level endpoints, gated by `admin.write`/`admin.read` roles, not by account. |
| Background workers / webhooks | Unattended by definition: they use the project's stored connection. If the owning account's token is revoked, the next run fails with an actionable "reconnect" error instead of silently using another credential. |
| `/runs/:id`, `/tasks/:id`, `/conversations/:id` by id | Gated indirectly: the project-state hook resolves the entity's `projectId` and applies `canAccessProject`. Entities with no project attached are not gated. |
