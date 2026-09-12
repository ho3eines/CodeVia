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
- **Ownership** — projects, models and providers are owner-scoped; foreign rows
  read as `404` (no existence leak). Shared/legacy rows are adopted on first
  write, never published to everyone.
- **Realtime** — Socket.io handshakes authenticate like HTTP and events are
  delivered only to sockets subscribed to a project they may access
  (A03).
- **Dangerous operations** — merges are gated behind an `ApprovalRequest` that
  is validated for project, PR, repository, commit SHA, actor and expiry before
  the worker acts (A04, `src/workers/worker.ts`).
- **Secrets** — credentials, sessions and queue lease state are intentionally
  kept out of the `CodeVia/` repository state; the repository is never a
  credential store.

## Known advisories (transitive, runtime)

`npm audit` reports a **high** advisory for a transitive `@fastify/static`
(`GHSA-8pvw-jcv7-9cmj`, `GHSA-83w8-p2f5-377r`) pulled in through
`@fastify/swagger-ui@5`. The project's direct `@fastify/static@^10.1.3` is not
affected; the vulnerable copy only serves the `/docs` Swagger UI assets.
Upgrading `@fastify/swagger-ui` to `6.1.1` removes it and is tracked in the
roadmap — it is a semver-major change that has not been forced without testing.

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
