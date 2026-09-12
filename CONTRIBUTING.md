# Contributing to CodeVia

Thanks for helping build CodeVia. This document covers the workflow, the
quality gates, and the conventions the repository enforces.

## First principles

- **Repository is the source of truth for project state.** Definitions live
  under `CodeVia/` in each connected repository; read
  [docs/REPOSITORY_STATE.md](docs/REPOSITORY_STATE.md) and
  [docs/REPOSITORY_STATE_AUDIT.md](docs/REPOSITORY_STATE_AUDIT.md) before
  touching the loader/codec/restore paths.
- **Isolation rules are uniform.** Projects, models, providers and credentials
  follow the same ownership predicate across HTTP, realtime, workers and
  Telegram — see [docs/MULTI_USER_ISOLATION.md](docs/MULTI_USER_ISOLATION.md).
- **Security changes need regression tests.** Any change to auth, ownership,
  approvals or realtime must extend the hardening tests listed in
  [SECURITY.md](SECURITY.md).

## Getting started

```bash
npm install          # also sets up git hooks via `prepare`
npm run dev          # run the platform (mock AI/GitHub/Telegram, fully offline)
```

Node.js ≥ 20 is required (CI runs Node 22; `node:sqlite` needs a recent runtime).

## Development loop

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint over src/ and scripts/
npm run lint:fix     # autofix lint issues
npm test             # full Vitest suite (~4 minutes)
npm run smoke        # end-to-end smoke (boots the server on a temp DB)
npm run build        # production build (tsc + static copy)
```

`npm run check` runs typecheck + lint in one step. Formatting is enforced with
Prettier — `npm run format` rewrites and `npm run format:check` is the CI gate.
A pre-commit hook (`lint-staged`) lints and formats the files you stage.

## Tests

- Tests live next to the code under `src/**/*.test.ts`.
- `src/tests/security-regressions.test.ts`, `merge-approval.test.ts` and
  `multi-user-ownership.test.ts` are **hardening regressions** — they encode
  security policy, not just behavior.
- The audit probes (`scripts/audit-pipeline.mjs`,
  `scripts/audit-repository-state.mjs`) are diagnostic tools with an intentional
  non-zero exit when a gap exists; read the "بازتولید" section of the matching
  `docs/*_AUDIT.md` before interpreting their output.
- Coverage: `npm run test:coverage` produces reports under `coverage/` and
  enforces the thresholds in `vitest.config.ts`.

## Submitting changes

1. Branch from `main`; keep commits focused with a clear subject line.
2. Run `npm run check`, `npm test`, and `npm run smoke` locally.
3. Add or update tests for any behavior change, and docs for any contract
   change (the `docs/` folder is the source of the platform's contracts).
4. Open a pull request. CI runs typecheck, lint, format, test, build and smoke.

## Conventions

- **TypeScript strict**, ESM throughout; imports use `.js` extensions.
- **No credentials in the repository.** Keep secrets in env/`.env` (see
  [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)); `CodeVia/` never stores secrets.
- **Fail closed.** Silent fallbacks that can hide corrupt input are a bug —
  see R08 in [docs/REPOSITORY_STATE_AUDIT.md](docs/REPOSITORY_STATE_AUDIT.md).
- **Logs and audit rows** carry the execution's correlation id so a request can
  be traced end to end.

## Code of conduct

All participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
