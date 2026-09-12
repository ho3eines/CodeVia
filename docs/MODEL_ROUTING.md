# Model Routing — how a request picks a model (and how the load is spread)

Two questions decide which model answers, and CodeVia answers both:

1. **Which models are *allowed and good* for this task?** → the Model Router
   (`src/ai/model-router.ts`).
2. **Which of those should take *this* request so no single model is burned
   out?** → the Load Balancer (`src/ai/load-balancer.ts`).

Keeping them separate is the point: question 1 has a *stable* answer, so
routing on it alone makes every chat message, agent step and background
summary hit the same top-scored model. One provider key then carries the whole
installation (and its rate limit) while the rest of the registry idles.

## Selection order

```
allowedModels allow-list ─▶ capability + budget filters ─▶ agent primary /
secondary / fallbacks + category model ─▶ benchmark telemetry (accuracy,
p95 latency, error rate) ─▶ static priority ─▶ LOAD DISTRIBUTION ─▶ ordered
candidate list (A → B → C for automatic fallback)
```

The balancer only ever *reorders* the list the router produced. Nothing is
removed, so a one-model installation, a fully saturated pool or a total
outage still answers instead of failing.

## Policies

| Policy | Rule | Use it when |
| --- | --- | --- |
| `adaptive` (default) | `0.30·benchmark score + 0.16·router position − 0.50·fair-share deficit − 1.00·saturation − 0.50·recent errors` | You want spread *and* quality: better models earn a bigger share, busy/broken ones get skipped |
| `round-robin` | strict rotation by fair-share deficit (`picks / weight`) | Equal keys, equal quota — e.g. identical models on one provider |
| `weighted-round-robin` | rotation where the quota is `loadWeight × (0.7 + 0.6·score)` | You pay per token and want the cheap/good mix fixed explicitly |
| `least-loaded` | fewest live calls first, then lowest share of the provider's `rateLimitPerMinute`, then least recently used | Providers with hard concurrency caps (self-hosted/vLLM/Ollama) |
| `sticky` | no spreading — always the best model (legacy behaviour) | A single model must serve everything (audit, reproducibility) |

`picks / weight` is the fair-share deficit: *"how much traffic has this model
already taken relative to what it is entitled to?"* The model furthest behind
is next. Unlike a randomised pick it is deterministic (repeatable in tests and
in incident reviews), and unlike a rotation cursor it copes with models being
added, deactivated or filtered out mid-flight. Because the deficit keeps
growing for an over-selected model, a strong model leads but never permanently
owns the traffic — the shares converge on the configured proportions.

## Pins: what the balancer must not override

| Situation | `pin` | Result |
| --- | --- | --- |
| Model chosen in the chat dropdown (stored on the conversation) | `forced` | That model answers every message; the rest of the list is still rotated as its fallbacks |
| `project.defaultModelId`, agent `primary` / category model | `boost` (default) | It earns **≈ double** the share of an equal peer instead of taking everything, so a deliberate configuration still leads while the load spreads. If it starts failing it is demoted like any other model |
| Nothing chosen ("Auto") | — | Full rotation over every model that fits the task |

The rule behind that split: **a choice made by a human right now is an
instruction; a default in a configuration is a bias.** Treating both as pins is
how an installation with five models ends up using one of them.

Selecting **Auto** in the chat model dropdown also *clears* the stored pin, so a
conversation that was once pinned to one model resumes distributing.

## Two extra safety nets

* **Concurrency ceiling** — `MODEL_ROUTING_MAX_CONCURRENCY_PER_MODEL`, or
  `maxConcurrency` on a single model. A model at its ceiling is treated as
  saturated, so `least-loaded` and `adaptive` hand the request to a peer.
* **Circuit breaker** — after `MODEL_ROUTING_FAILURE_THRESHOLD` consecutive
  failures a model is *demoted to the back of the queue* for
  `MODEL_ROUTING_COOLDOWN_MS` (doubling per trip, capped at 8×). One success
  clears the streak. It is demoted, never dropped, so it still gets a chance to
  recover — and so a total outage is reported as a model error rather than as
  "no models available".

Provider `rateLimitPerMinute` is used as a second saturation signal: a model on a
60 rpm key stops being volunteered once it has actually served 60 calls in the
last minute.

## Stickiness (one thread, one voice)

Every request commits its pick through a lease (`begin()` / `finish(ok)`), and a
commit may record an *affinity*: "this key is using model X". Chat passes
`conv:<id>` and an agent run passes `run:<taskId>:<agentId>:<category>`.

* `MODEL_ROUTING_SESSION_STICKY_MS` (default **0**) — how long a conversation
  keeps its model. `0` means every message rotates, which is the best spread;
  raise it if you prefer one thread to keep one voice.
* `MODEL_ROUTING_RUN_STICKY_MS` (default **900000**) — an agent run keeps its
  model across all its steps (a run must not change style mid-task), while
  *different* runs land on different models.

Affinity is dropped the moment the model becomes unusable (cooling down or ≥ 2×
over its ceiling), so a thread is never stuck on a broken key.

## Where it applies

| Path | Effect |
| --- | --- |
| Web chat (JSON + SSE streaming) | rotates per message; a UI-picked model pins |
| `AiTextService` (conversation summaries, PR descriptions, background helpers) | rotates over the owner's pool |
| Agent runs (`realChatFor`) | rotates per run, sticky within it; budget/context-size re-routing keeps the run's model |
| Math benchmark, model test, one-shot bootstrap (`ProjectStateGenerator`) | **not** balanced — those address one named model on purpose |

Account isolation is unchanged: the balancer only reorders the pool the router
was allowed to see (`listActiveForOwner`), so a request can never be spread onto
another account's key.

## Observability

`GET /models/routing` returns the policy plus live per-model counters —
`picks`, `share`, `inflight`, `requestsLastMinute`, `saturation`,
`consecutiveErrors`, `cooldownUntil`, `effectiveWeight`. The **Models →
Benchmark** tab renders it as the *Load distribution* card, where the policy and
the tunables can be changed (persisted to the KV store; the counters
deliberately are not — after a restart nothing is in flight).

```
GET   /api/models/routing          # policy + live distribution
PATCH /api/models/routing          # { policy, maxConcurrencyPerModel, failureThreshold, cooldownMs, sessionStickyMs }
POST  /api/models/routing/reset    # forget rotation position, error streaks, cooldowns
```

Per-model overrides live on the model row: `loadWeight` (0 = fallback only,
1 = equal share, 2 ≈ twice the traffic) and `maxConcurrency`. Both are editable
in **Models → Edit**, and a model carrying them shows `⚙ share ×2 · ≤3 live` in
its card.
