# Service Level Objectives (SLOs)

This document defines the availability, task-success and latency objectives the
platform targets, how each is measured, and where the underlying signals come
from. These are engineering objectives (the line we do not want to cross), not
legal guarantees.

## Measurement model

Every user interaction is assigned a **correlation id** (see
[`src/correlation.ts`](../src/correlation.ts)). The HTTP layer honours an inbound
`x-correlation-id` header or mints one, echoes it on the response, and threads it
through the async context so jobs, approvals and runs created by that request
carry the same id. A single execution can therefore be joined across
`request → job → run → approval → audit` via its correlation id.

## Objectives

| SLO | Target | Window | Signal |
|-----|--------|--------|--------|
| **Availability** | ≥ 99.5% | rolling 28 days | failed 5xx responses / total responses; liveness (`/health`, `/ready`, `/live`) |
| **Task success rate** | ≥ 95% | rolling 28 days | succeeded runs / (succeeded + failed) runs; `jobs` table status |
| **p95 latency** | ≤ 60 s per task run | rolling 28 days | `runs.durationMs` of succeeded runs |

### Why these numbers

- **Availability 99.5%** — a self-hosted, single-instance platform behind
  Railway. The remaining 0.5% absorbs deploys, SQLite checkpoint stalls and
  upstream GitHub/Telegram failures.
- **Task success 95%** — agent executions legitimately fail on model budget
  exhaustion, approval rejection, and QA non-verification; those are expected
  outcomes, not SLO violations. Only 5% headroom is reserved for *unexpected*
  failures.
- **p95 ≤ 60 s** — long-tail runs (multi-agent implementations with QA loops)
  are allowed to be slow, but 95% of runs should complete within a minute.

## Queue health (leading indicators)

The queue exposes the counters behind the task objectives at `GET /admin/queue`
(owner/admin only):

- `pending` — backlog size.
- `retrying` — jobs in a retry backoff.
- `deadLetter` — jobs that exhausted their retry budget.
- `oldestPendingAgeMs` / `oldestRetryingAgeMs` — **queue lag**: how long the
  oldest waiting job has been stuck. A persistently high lag indicates the
  worker cannot keep up and precedes both task-success and p95 breaches.

Operators should alert on: `deadLetter > 0` sustained for more than a few
minutes, or `oldestPendingAgeMs > 10 min`, or a task success rate below 95% over
the trailing 28 days.

## How to check

```bash
curl -H "x-correlation-id: corr_demo" http://localhost:3000/health          # echo + mint
curl http://localhost:3000/admin/queue                                      # queue metrics (admin auth)
```

Runs (`durationMs`, `status`, `createdAt`, `correlationId`) are the source of
truth for the task-success and p95 objectives and are inspectable through the
existing observability routes and the audit log.
