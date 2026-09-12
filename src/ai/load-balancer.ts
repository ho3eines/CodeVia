import { logger } from "../logger.js";
import { getEnv } from "../config/env.js";
import type { KvStore } from "../db/kv.js";

/* ------------------------------------------------------------------ *
 * Model load distribution
 *
 * The Model Router answers "which model is *best* for this task?". On its own
 * that is a stable answer, so every chat message, every agent step and every
 * summarisation lands on the same top-scored model — one provider key carries
 * the whole load and hits its rate limit while the other registered models sit
 * idle. This module adds the missing second question: "which model should take
 * THIS request so the load is spread across all of them?".
 *
 * Design rules:
 *   • Planning is pure. `order()` never mutates state, so two routers asking
 *     the same question inside one request get the same answer. Counters only
 *     move when a call is actually committed via `begin()`.
 *   • Selection is deterministic. No randomness: the same sequence of commits
 *     always produces the same sequence of picks, which keeps tests (and
 *     debugging) honest. Fair-share counters replace the usual
 *     "pick a random model" trick.
 *   • Nothing is ever removed from the pool. A cooling-down or saturated model
 *     is moved to the *back* instead of being dropped, so a single-model
 *     installation still works and a broken model can still recover.
 *   • Explicit user intent wins. A model the user picked in the chat dropdown
 *     is pinned ("forced"); a project default or agent primary is only favoured
 *     while it is healthy and below its ceiling ("preferred") — that is the
 *     difference between "use this model" and "I would rather this model".
 * ------------------------------------------------------------------ */

export type RoutingPolicy =
  /** Fair-share + benchmark quality + live load/circuit-breaker (default). */
  | "adaptive"
  /** Strict rotation: every eligible model gets one request in turn. */
  | "round-robin"
  /** nginx-style smooth weighted rotation (weight = loadWeight × benchmark score). */
  | "weighted-round-robin"
  /** Fewest in-flight / lowest share of the provider rate limit first. */
  | "least-loaded"
  /** Legacy behaviour: pure router score, no spreading. */
  | "sticky";

export const ROUTING_POLICIES: RoutingPolicy[] = [
  "adaptive",
  "round-robin",
  "weighted-round-robin",
  "least-loaded",
  "sticky",
];

export interface RoutingConfig {
  policy: RoutingPolicy;
  /** 0 = unlimited. Above this many in-flight calls a model is saturated. */
  maxConcurrencyPerModel: number;
  /** Consecutive failures that trip the circuit breaker. 0 disables it. */
  failureThreshold: number;
  /** Base cooldown for a broken model; doubles per trip, capped at 8×. */
  cooldownMs: number;
  /**
   * How long a caller-supplied `affinityKey` (one conversation, one agent run)
   * keeps its model. 0 = every request rotates, which is what chat wants;
   * agent runs pass a longer window so one run does not switch models per step.
   */
  sessionStickyMs: number;
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  policy: "adaptive",
  maxConcurrencyPerModel: 0,
  failureThreshold: 3,
  cooldownMs: 60_000,
  sessionStickyMs: 0,
};

/** The subset of routing candidates the balancer needs to know about. */
export interface LoadBalanceCandidate {
  id: string;
  /** Benchmark-derived quality 0..1; neutral 0.5 when never measured. */
  perfScore?: number;
  /** Operator-set relative share (1 = equal weight, 0 = never volunteer). */
  loadWeight?: number;
  /** Per-model concurrency ceiling; falls back to the configured global one. */
  maxConcurrency?: number;
  /** Provider rate limit in calls/minute — a second saturation signal. */
  rateLimitPerMinute?: number;
}

export interface BalanceRequest<T> {
  /** Candidates in router order (best first). Reordered in place never drops any. */
  candidates: T[];
  /** Rotation pool identity: per account / project / task category. */
  scope?: string;
  /** The model the caller asked for, if any. */
  pinnedId?: string;
  /**
   * `"forced"` — the user chose it right now (a chat dropdown pick): it answers,
   * full stop. `"boost"` — a *configured* default (project default, agent
   * primary): it is given roughly twice the traffic share of its peers instead of
   * all of it, so a deliberate config still leads while the load also spreads.
   */
  pin?: "forced" | "boost";
  /** Conversation id / task id for short-lived stickiness. */
  affinityKey?: string;
  /** Overrides `sessionStickyMs` for this decision (agent runs use a longer one). */
  affinityTtlMs?: number;
}

/** Live per-model counters, for the UI/API and for routing decisions. */
export interface ModelLoadSnapshot {
  modelId: string;
  inflight: number;
  picks: number;
  /** 0..1 share of everything this process has routed so far. */
  share: number;
  /** 0..1 (and above when a limit is exceeded) — how busy this model is. */
  saturation: number;
  /** Calls in the last minute (per-minute rate). */
  requestsLastMinute: number;
  consecutiveErrors: number;
  /** Epoch ms until which the model is demoted, 0 when healthy. */
  cooldownUntil: number;
  lastUsedAt: number;
  /** Relative share the balancer applies (weights × benchmark score). */
  effectiveWeight: number;
}

export interface LoadLease {
  readonly modelId: string;
  /** Release the slot. `ok=false` counts towards the circuit breaker. */
  finish(ok: boolean): void;
}

const MINUTE_MS = 60_000;
/** KV key holding the operator’s chosen routing policy (the only persisted part). */
const ROUTING_CONFIG_KEY = "model-routing-config";
/** Bounds for the in-memory maps: a long-lived process must not grow forever. */
const MAX_CALL_STAMPS = 2_000;
const MAX_AFFINITIES = 2_000;

interface ModelLoadState {
  inflight: number;
  picks: number;
  lastUsedAt: number;
  consecutiveErrors: number;
  cooldownUntil: number;
  cooldownWindowMs: number;
  /** Epoch ms of recent calls, pruned to the last minute (rate-limit signal). */
  calls: number[];
}

/**
 * Routing defaults from the environment. The Models page can override them at
 * runtime (persisted in the KV store), so this is only the starting point.
 * A bad/unreadable environment must never stop the platform from booting.
 */
export function routingConfigFromEnv(): Partial<RoutingConfig> {
  try {
    const env = getEnv();
    return {
      policy: env.MODEL_ROUTING_POLICY,
      maxConcurrencyPerModel: env.MODEL_ROUTING_MAX_CONCURRENCY_PER_MODEL,
      failureThreshold: env.MODEL_ROUTING_FAILURE_THRESHOLD,
      cooldownMs: env.MODEL_ROUTING_COOLDOWN_MS,
      sessionStickyMs: env.MODEL_ROUTING_SESSION_STICKY_MS,
    };
  } catch {
    return {};
  }
}

/** How long a single agent run keeps its model (steps stay coherent, runs spread). */
export function routingRunStickyMs(): number {
  try {
    return getEnv().MODEL_ROUTING_RUN_STICKY_MS;
  } catch {
    return 900_000;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Process-wide load distributor for model routing.
 *
 * State is intentionally in-memory: it describes *right now* (who is busy, who
 * just failed, where the rotation stands). Persisting it would be wrong — after
 * a restart nothing is in flight. Only the operator's configuration is stored
 * (KV), so a chosen policy survives a deploy.
 */
export class ModelLoadBalancer {
  private readonly states = new Map<string, ModelLoadState>();
  private readonly affinity = new Map<string, { modelId: string; at: number }>();
  private cfg: RoutingConfig;
  private kv: KvStore | undefined;

  constructor(config: Partial<RoutingConfig> = {}) {
    this.cfg = { ...DEFAULT_ROUTING_CONFIG, ...config };
  }

  /* ---------------------------- configuration ---------------------------- */

  config(): RoutingConfig {
    return { ...this.cfg };
  }

  /** Update the policy/tunables. Invalid values are ignored, never thrown. */
  configure(patch: Partial<RoutingConfig> | undefined | null): RoutingConfig {
    const next = { ...this.cfg };
    if (patch?.policy && ROUTING_POLICIES.includes(patch.policy)) next.policy = patch.policy;
    if (typeof patch?.maxConcurrencyPerModel === "number" && Number.isFinite(patch.maxConcurrencyPerModel)) {
      next.maxConcurrencyPerModel = Math.max(0, Math.floor(patch.maxConcurrencyPerModel));
    }
    if (typeof patch?.failureThreshold === "number" && Number.isFinite(patch.failureThreshold)) {
      next.failureThreshold = Math.max(0, Math.floor(patch.failureThreshold));
    }
    if (typeof patch?.cooldownMs === "number" && Number.isFinite(patch.cooldownMs)) {
      next.cooldownMs = Math.min(Math.max(1_000, Math.floor(patch.cooldownMs)), 3_600_000);
    }
    if (typeof patch?.sessionStickyMs === "number" && Number.isFinite(patch.sessionStickyMs)) {
      next.sessionStickyMs = Math.min(Math.max(0, Math.floor(patch.sessionStickyMs)), 3_600_000);
    }
    this.cfg = next;
    this.kv?.set(ROUTING_CONFIG_KEY, next);
    return { ...next };
  }

  /** Store the config so a restart keeps the operator's choice. */
  attachKv(kv: KvStore | undefined): void {
    this.kv = kv;
  }

  /** Read back what `configure()` persisted (called once on boot). */
  restore(): RoutingConfig {
    const stored = this.kv?.get<Partial<RoutingConfig>>(ROUTING_CONFIG_KEY);
    if (stored) this.configure(stored);
    return this.config();
  }

  /* ------------------------------- planning ------------------------------ */

  /**
   * Reorder the router's candidate list for THIS request. Pure: no counters
   * move, so calling it twice with the same state answers twice the same way.
   */
  order<T extends LoadBalanceCandidate>(req: BalanceRequest<T>): T[] {
    const pool = req.candidates;
    if (pool.length <= 1) return pool.slice();
    const pinned = req.pinnedId ? pool.find((m) => m.id === req.pinnedId) : undefined;

    // "sticky" is the legacy single-model behaviour, kept as an escape hatch.
    if (this.cfg.policy === "sticky") {
      return pinned ? [pinned, ...pool.filter((m) => m !== pinned)] : pool.slice();
    }

    // A forced pick (the user chose this model for this chat) always answers —
    // pinning is intent, not a suggestion. The remaining models are still
    // rotated, so the fallback of a pinned model is not a fixed second model.
    const rest = pool.filter((m) => m !== pinned);
    if (pinned && req.pin === "forced") return [pinned, ...this.rank(rest)];

    const now = Date.now();

    // Stickiness: one conversation / one agent run keeps its model while that
    // model is still usable, so a thread does not change voice every message.
    const key = req.affinityKey ? `${req.scope || "global"}|${req.affinityKey}` : undefined;
    if (key) {
      const hit = this.affinity.get(key);
      const ttl = req.affinityTtlMs ?? this.cfg.sessionStickyMs;
      if (hit && ttl > 0 && now - hit.at <= ttl) {
        const held = pool.find((m) => m.id === hit.modelId);
        if (held && !this.coolingDown(held.id, now) && this.saturation(held) < 2) {
          return [held, ...pool.filter((m) => m !== held)];
        }
        this.affinity.delete(key);
      }
    }

    // A configured default is a preference, not an instruction: it earns a
    // larger share of the rotation (≈2×) rather than monopolising it. If it is
    // cooling down or saturated, its peers overtake it on their own — the
    // demotion is what `rank` measures, so the boost never queues traffic
    // behind a model that cannot answer.
    return this.rank(pool, req.pin === "boost" ? pinned?.id : undefined);
  }

  /* ------------------------------- commits ------------------------------- */

  /**
   * Commit a pick: the model is now in flight, its fair-share advances and the
   * affinity (when the caller supplied one) points at it.
   */
  begin(modelId: string, opts: { scope?: string; affinityKey?: string; stickyMs?: number } = {}): LoadLease {
    const st = this.stateOf(modelId);
    const now = Date.now();
    st.inflight += 1;
    st.picks += 1;
    st.lastUsedAt = now;
    st.calls.push(now);
    if (st.calls.length > MAX_CALL_STAMPS) st.calls.splice(0, st.calls.length - MAX_CALL_STAMPS);
    if (opts.affinityKey) {
      this.affinity.set(`${opts.scope || "global"}|${opts.affinityKey}`, { modelId, at: now });
      this.pruneAffinity();
    }
    let finished = false;
    return {
      modelId,
      finish: (ok: boolean) => {
        if (finished) return;
        finished = true;
        this.release(modelId, ok);
      },
    };
  }

  /** Record an outcome for a model that was not leased (e.g. a raw provider test). */
  noteOutcome(modelId: string, ok: boolean): void {
    this.release(modelId, ok, false);
  }

  /** Drop all live counters (used after a provider/model change or from the UI). */
  reset(): void {
    this.states.clear();
    this.affinity.clear();
  }

  /* ----------------------------- observability ---------------------------- */

  /** Live distribution snapshot for every model seen so far, busiest first. */
  snapshot(available: LoadBalanceCandidate[] = []): ModelLoadSnapshot[] {
    const ids = new Set<string>([...this.states.keys(), ...available.map((m) => m.id)]);
    const totalPicks = [...this.states.values()].reduce((s, x) => s + x.picks, 0);
    const now = Date.now();
    const rows: ModelLoadSnapshot[] = [];
    for (const id of ids) {
      const st = this.stateOf(id);
      const cand = available.find((m) => m.id === id);
      rows.push({
        modelId: id,
        inflight: st.inflight,
        picks: st.picks,
        share: totalPicks > 0 ? st.picks / totalPicks : 0,
        saturation: cand ? this.saturation(cand) : Number((st.inflight / Math.max(1, this.cfg.maxConcurrencyPerModel || 1)).toFixed(3)),
        requestsLastMinute: this.recentCalls(st, now).length,
        consecutiveErrors: st.consecutiveErrors,
        cooldownUntil: st.cooldownUntil,
        lastUsedAt: st.lastUsedAt,
        effectiveWeight: Number(this.weight(cand ?? { id }).toFixed(3)),
      });
    }
    return rows.sort((a, b) => b.picks - a.picks || String(a.modelId).localeCompare(String(b.modelId)));
  }

  /* -------------------------------- internals ---------------------------- */

  private stateOf(modelId: string): ModelLoadState {
    let st = this.states.get(modelId);
    if (!st) {
      st = { inflight: 0, picks: 0, lastUsedAt: 0, consecutiveErrors: 0, cooldownUntil: 0, cooldownWindowMs: this.cfg.cooldownMs, calls: [] };
      this.states.set(modelId, st);
    }
    return st;
  }

  private release(modelId: string, ok: boolean, inFlight = true): void {
    const st = this.stateOf(modelId);
    if (inFlight) st.inflight = Math.max(0, st.inflight - 1);
    if (ok) {
      st.consecutiveErrors = 0;
      st.cooldownUntil = 0;
      st.cooldownWindowMs = this.cfg.cooldownMs;
      return;
    }
    st.consecutiveErrors += 1;
    if (this.cfg.failureThreshold > 0 && st.consecutiveErrors >= this.cfg.failureThreshold) {
      const base = this.cfg.cooldownMs;
      st.cooldownWindowMs = Math.min(Math.max(st.cooldownWindowMs || base, base) * 2, base * 8);
      st.cooldownUntil = Date.now() + st.cooldownWindowMs;
      logger.warn("load-balancer: model cooling down after repeated failures", {
        modelId,
        consecutiveErrors: st.consecutiveErrors,
        cooldownMs: st.cooldownWindowMs,
      });
    }
  }

  private coolingDown(modelId: string, now = Date.now()): boolean {
    const st = this.states.get(modelId);
    return !!st && st.cooldownUntil > now;
  }

  /**
   * How much of its own capacity this model is already burning (1 = at its
   * ceiling). Both the concurrency ceiling and the provider's per-minute rate
   * limit count, whichever is worse.
   */
  private saturation(cand: LoadBalanceCandidate): number {
    const st = this.states.get(cand.id);
    if (!st) return 0;
    const cap = cand.maxConcurrency && cand.maxConcurrency > 0 ? cand.maxConcurrency : this.cfg.maxConcurrencyPerModel;
    // 0 = unlimited: still show pressure relative to a soft reference so
    // `least-loaded` can rank models against each other.
    const byConcurrency = cap > 0 ? st.inflight / cap : st.inflight / 4;
    const rpm = this.recentCalls(st, Date.now()).length;
    const byRateLimit = cand.rateLimitPerMinute && cand.rateLimitPerMinute > 0 ? rpm / cand.rateLimitPerMinute : 0;
    return Math.max(byConcurrency, byRateLimit);
  }

  private recentCalls(st: ModelLoadState, now: number): number[] {
    const cutoff = now - MINUTE_MS;
    while (st.calls.length && st.calls[0] < cutoff) st.calls.shift();
    return st.calls;
  }

  /** Relative share: operator weight × benchmark quality (0.7…1.3×). */
  private weight(cand: LoadBalanceCandidate | undefined): number {
    const base = cand?.loadWeight;
    const weight = typeof base === "number" && Number.isFinite(base) ? Math.max(0, base) : 1;
    if (weight <= 0) return 0;
    return weight * (0.7 + 0.6 * clamp01(cand?.perfScore ?? 0.5));
  }

  /**
   * Rank a pool by the active policy. Lower key array = earlier, and every
   * policy ends with the incoming (router) index as the final tiebreaker, so
   * nothing here is arbitrary: equal standing means "keep what the router
   * decided".
   *
   * Fair share is the spine of every rotating policy: a model's `share` is how
   * many picks it already took divided by its weight, so the model that is
   * furthest behind its entitlement is next. Unlike a normalised score, the
   * raw gap keeps correcting: a strong model may lead, but each extra pick
   * pushes it back, so traffic converges on the configured proportions instead
   * of sticking permanently to the best benchmark score.
   *
   * Nothing is removed: a cooling model is appended last (so a single-model or
   * total-outage installation still answers), and `loadWeight: 0` means
   * "fallback only" rather than "unusable".
   */
  private rank<T extends LoadBalanceCandidate>(pool: T[], boostId?: string): T[] {
    if (pool.length <= 1) return pool.slice();
    const policy = this.cfg.policy;
    const now = Date.now();
    const fallbackOnly = pool.filter((m) => (m.loadWeight ?? 1) <= 0);
    const fallbackSet = new Set(fallbackOnly);
    const available = pool.filter((m) => !fallbackSet.has(m));
    const healthy = available.filter((m) => !this.coolingDown(m.id, now));
    const cooling = [...available.filter((m) => this.coolingDown(m.id, now)), ...fallbackOnly];
    if (!healthy.length) return [...cooling];

    // Fair share = picks taken relative to this model's entitlement.
    const weightOf = (m: T) => {
      const base = policy === "weighted-round-robin" || policy === "adaptive" ? Math.max(0.05, this.weight(m)) : 1;
      // A configured default doubles its entitlement — in a fair-share rotation
      // that is exactly "twice the traffic", not "every request".
      return m.id === boostId ? base * 2 : base;
    };
    const share = (m: T) => this.stateOf(m.id).picks / weightOf(m);

    let rows: Array<{ m: T; keys: number[] }>;
    if (policy === "least-loaded") {
      rows = healthy.map((m, i) => {
        const st = this.stateOf(m.id);
        return { m, keys: [this.saturation(m), st.inflight, share(m), st.lastUsedAt, i] };
      });
    } else if (policy === "adaptive") {
      const n = healthy.length;
      rows = healthy.map((m, i) => {
        const st = this.stateOf(m.id);
        const routerFactor = n > 1 ? 1 - i / (n - 1) : 1;
        const errorPressure = Math.min(1, st.consecutiveErrors / Math.max(1, this.cfg.failureThreshold || 1));
        const value =
          0.3 * clamp01(m.perfScore ?? 0.5) +
          0.16 * routerFactor -
          0.5 * share(m) -
          1 * clamp01(this.saturation(m)) -
          0.5 * errorPressure;
        return { m, keys: [-value, this.saturation(m), share(m), i] };
      });
    } else {
      // round-robin / weighted-round-robin: strict fair-share rotation, with
      // busy models and least-recently-used as deterministic tiebreakers.
      rows = healthy.map((m, i) => {
        const st = this.stateOf(m.id);
        return { m, keys: [share(m), st.inflight, st.lastUsedAt, i] };
      });
    }
    const ranked = rows.sort((a, b) => cmp(a.keys, b.keys)).map((r) => r.m);
    // Rank the demoted ones too, so even the last-resort order is sane.
    const demoted = cooling
      .map((m, i) => ({ m, keys: [this.saturation(m), share(m), i] }))
      .sort((a, b) => cmp(a.keys, b.keys))
      .map((r) => r.m);
    return [...ranked, ...demoted];
  }

  private pruneAffinity(): void {
    if (this.affinity.size <= MAX_AFFINITIES) return;
    const entries = [...this.affinity.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of entries.slice(0, this.affinity.size - MAX_AFFINITIES)) this.affinity.delete(k);
  }
}

/** Compare numeric key arrays, first difference wins. */
function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    if (d !== 0 && Number.isFinite(d)) return d;
  }
  return 0;
}
