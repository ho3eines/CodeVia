# Security Policy

CodeVia is an AI engineering agent platform that can create branches, commits,
pull requests, run agents and merge code on your behalf. Security is a
first-class concern: the platform separates per-account credentials, gates
dangerous operations behind human approvals, and never treats a client-supplied
header as proof of identity. This document explains how to report a
vulnerability and what to expect.

## Supported versions

| Version | Supported |
| ------- | --------- |
| `main` (latest) | ✅ |

The project is under active development and has **not** yet reached a stable
production release. See the [readiness notes in the README](README.md) and the
[remaining gaps](docs/MULTI_USER_ISOLATION.md#6-known-remaining-gaps-not-fixed-here)
before a sensitive multi-user deployment.

## Reporting a vulnerability

Please **do not open a public issue** for a security vulnerability.

Instead, report it privately to the maintainers:

1. Open a [private security advisory](https://github.com/ho3eines/CodeVia/security/advisories/new)
   on GitHub, **or**
2. Email the maintainers (see the repository owner profile).

Include, where possible:

- A description of the issue and its impact,
- Steps to reproduce (ideally a minimal script or request sequence),
- The affected component/route (for example `src/http/auth.ts`, the
  Socket.io handshake, or the `github.op` worker),
- The version/commit you tested against.

We will acknowledge receipt within a few days, keep you informed of the
investigation, and credit you in the fix (unless you prefer to stay anonymous).

## What counts as a vulnerability

The following are treated as security issues and are prioritized:

- Authentication or authorization bypass (HTTP, realtime, Telegram, workers).
- Cross-account data leaks (projects, models, providers, credentials, events).
- Approval bypass for dangerous operations (merge, deploy, budget overruns).
- Secret/credential exposure (API keys, OAuth tokens, session material).
- Webhook signature-validation bypass or replay.
- Any path that lets one account spend or use another account's model/provider.

## Security model (high level)

- **Identity** — the only proof of identity is a valid signed GitHub-login
  session (`Authorization: Bearer <session>` / `cv_session` cookie). A caller
  header such as `x-user-id` is never accepted as identity (regression-tested,
  `src/tests/security-regressions.test.ts` A01).
- **Production is fail-closed** — with `REQUIRE_AUTH=true` and no GitHub OAuth
  configured, production answers **503** (not 401, not 200 with a demo owner) so
  a misconfigured server never hands out unauthenticated owner permissions.
  A narrow **bootstrap window** keeps `GET /admin/settings` and
  `PUT /admin/settings/github` reachable from loopback or with the one-time
  setup token printed at boot — the window closes the moment OAuth is configured.
  The demo fallback identity is downgraded to `viewer` (read-only; no `admin.*`,
  no `*.write`) in production; dev/test keeps the full demo owner.
- **Ownership** — projects, models and providers are owner-scoped; foreign rows
  read as `404` (no existence leak). Shared/legacy rows are adopted on first
  write, never published to everyone.
- **Realtime** — Socket.io handshakes authenticate like HTTP and events are
  delivered only to sockets subscribed to a project they may access
  (A03).
- **Dangerous operations** — merges are gated behind an `ApprovalRequest` that
  is validated for project, PR, repository, commit SHA, actor and expiry before
  the worker acts (A04, `src/workers/worker.ts`).
- **Untrusted project code** — a repository's own `install`/`build`/`test`
  commands are **never executed on the CodeVia host**. They run in a disposable
  Docker container with `--network=none` (unless the project opts in),
  `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
  `--pids-limit`, CPU/memory caps, a non-root user and `--pull=never` on
  `docker run`; an image is pulled only by the explicit preflight
  (`PROJECT_SANDBOX_IMAGE_PULL`, default `never`) before the container starts,
  never from inside it; the exported source tree is deleted afterwards.
  Sandbox runs are force-human approved for untrusted projects, and project
  trust only skips that approval while the network stays off. Nothing is
  approved when nothing can execute: a mock repository returns `simulated`, and
  `PROJECT_SANDBOX_ENABLED=false` never starts a container — GitHub-backed
  projects still read CI evidence, local projects report `unverified`
  (`src/projects/sandbox-runner.ts`, `src/tools/registry.ts`). Uploaded
  `.zip`/`.rar` archives are parsed in memory
  and rejected on traversal, links, CRC mismatch, oversized expansion or a bad
  compression ratio **before** a file is written; secret-bearing files are
  excluded from the initial commit (`src/projects/project-archive.ts`).
- **Secrets** — credentials, sessions and queue lease state are intentionally
  kept out of the `CodeVia/` repository state; a *project* repository is never a
  credential store. At rest in the runtime database they are AES-256-GCM
  encrypted with a key derived from `AUTH_SECRET`, and API responses only ever
  carry a mask.
- **Full system backup** — the deliberate exception, and an admin-only one. A
  backup snapshot carries every credential in plaintext so it can rebuild the
  installation on a server with a different `AUTH_SECRET`
  ([docs/SYSTEM_BACKUP.md](docs/SYSTEM_BACKUP.md)). The exposure is bounded on
  purpose: every endpoint is owner/admin gated, the download is `no-store` and
  audited, logs/audit rows/API status carry only counts, variable *names* and
  masks, local files are `0600`, `BACKUP_PASSPHRASE` encrypts the copies stored
  in a repository or on a volume, and `BACKUP_INCLUDE_SECRETS=false` turns the
  whole thing off. Treat a downloaded snapshot as a key ring: private backup
  repository, encrypted transfer, delete after the restore, rotate if it leaks.

## Known advisories (transitive, runtime)

Audit at the time of writing: `npm audit --omit=dev` reports **one moderate**
advisory, `GHSA-4mh8-r7rc-xpvc` (Fastify denial of service via an unhandled
exception on HTTP/2 trailer responses). This deployment does not enable HTTP/2
(it serves plain HTTP/1.1 behind a TLS-terminating proxy), so the affected path
is not reachable; track the upstream fix and upgrade Fastify when it lands.

The earlier `@fastify/static` advisory (`GHSA-8pvw-jcv7-9cmj`,
`GHSA-83w8-p2f5-377r`) is no longer present: the direct dependency is
`@fastify/static@^10.1.3` and `@fastify/swagger-ui` is on `6.1.1`.

`npm audit` also reports advisories for the **dev-only** Vitest toolchain
(`GHSA-82fw-gwwq-j7x9` and friends). These affect the Vitest UI dev server,
which is not exposed by this project (tests run headless in CI); they are not
part of the production bundle.

## Hardening regressions

The following tests must stay green — they are the executable form of this
policy:

- `src/tests/security-regressions.test.ts` (A01/A02/A03)
- `src/tests/merge-approval.test.ts` (A04)
- `src/tests/multi-user-ownership.test.ts` (per-account isolation)
- `src/tests/auth-guard.test.ts` and `src/tests/webhook-fail-closed.test.ts`
- `src/tests/sandbox-runner.test.ts` (host isolation, hardening flags, approval/network)
- `src/tests/project-archive.test.ts` and `src/tests/rar-archive.test.ts` (zip-slip, links, CRC, zip bombs)
- `src/tests/project-import-routes.test.ts` (secret exclusion before the initial commit)
- `src/tests/env-contract-sandbox.test.ts` (sandbox/import settings survive a backup)
