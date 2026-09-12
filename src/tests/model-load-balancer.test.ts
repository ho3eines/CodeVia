import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ModelLoadBalancer, ROUTING_POLICIES, type LoadBalanceCandidate } from "../ai/load-balancer.js";
import { ModelRouter, toCandidate, type CandidateModel } from "../ai/model-router.js";
import type { AgentModelConfig, Model } from "../domain/entities.js";

/* ------------------------------------------------------------------ *
 * Load distribution across models.
 *
 * The router answers "which model is best?". That answer is stable, which is
 * exactly the problem these tests cover: with several registered models every
 * chat message, agent step and background summary used to land on the same
 * top-scored one — one provider key took all the traffic (and its rate limit)
 * while the rest of the registry idled. The load balancer decides who answers
 * NOW, so pressure is spread over every eligible model.
 * ------------------------------------------------------------------ */

function cand(id: string, extra: Partial<LoadBalanceCandidate> = {}): LoadBalanceCandidate & { id: string } {
  return { id, perfScore: 0.5, ...extra };
}

/** Drive `calls` requests through the balancer the way a caller does: ask, then commit the winner. */
function drive(
  lb: ModelLoadBalancer,
  pool: LoadBalanceCandidate[],
  calls: number,
  opts: { pinnedId?: string; pin?: "forced" | "boost"; affinityKey?: string; scope?: string } = {},
): string[] {
  const used: string[] = [];
  for (let i = 0; i < calls; i++) {
    const ordered = lb.order({ candidates: pool, ...opts });
    const chosen = ordered[0];
    used.push(chosen.id);
    lb.begin(chosen.id, { scope: opts.scope, affinityKey: opts.affinityKey }).finish(true);
  }
  return used;
}

describe("ModelLoadBalancer — policies", () => {
  it("round-robin gives every model an equal share, in turn", () => {
    const lb = new ModelLoadBalancer({ policy: "round-robin" });
    const pool = [cand("a"), cand("b"), cand("c")];
    const used = drive(lb, pool, 6);
    expect(used).toEqual(["a", "b", "c", "a", "b", "c"]);
    const counts = lb.snapshot(pool).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.modelId]: r.picks }), {});
    expect(counts).toEqual({ a: 2, b: 2, c: 2 });
  });

  it("weighted-round-robin splits traffic proportionally to loadWeight", () => {
    const lb = new ModelLoadBalancer({ policy: "weighted-round-robin" });
    const pool = [cand("heavy", { loadWeight: 2 }), cand("light", { loadWeight: 1 })];
    const used = drive(lb, pool, 9);
    expect(used.filter((u) => u === "heavy").length).toBe(6);
    expect(used.filter((u) => u === "light").length).toBe(3);
  });

  it("least-loaded prefers the model with nothing in flight", () => {
    const lb = new ModelLoadBalancer({ policy: "least-loaded", maxConcurrencyPerModel: 2 });
    const pool = [cand("busy"), cand("idle")];
    // Two calls are already running on "busy" → it is at its ceiling.
    const leaseA = lb.begin("busy");
    const leaseB = lb.begin("busy");
    expect(lb.order({ candidates: pool })[0].id).toBe("idle");
    leaseA.finish(true);
    leaseB.finish(true);
    // Both are idle again, so the tiebreak is "least recently used".
    expect(lb.order({ candidates: pool })[0].id).toBe("idle");
  });

  it("sticky keeps the legacy 'always the best model' behaviour", () => {
    const lb = new ModelLoadBalancer({ policy: "sticky" });
    const pool = [cand("best"), cand("second"), cand("third")];
    expect(drive(lb, pool, 4)).toEqual(["best", "best", "best", "best"]);
  });

  it("adaptive spreads traffic but still favours the better-measured model", () => {
    const lb = new ModelLoadBalancer({ policy: "adaptive" });
    const pool = [cand("good", { perfScore: 0.95 }), cand("weak", { perfScore: 0.05 })];
    const used = drive(lb, pool, 12);
    const good = used.filter((u) => u === "good").length;
    // Not everything goes to the good one (that is the bug this file fixes),
    // but it does earn more than its peer.
    expect(good).toBeGreaterThan(4);
    expect(good).toBeLessThan(12);
    expect(used.filter((u) => u === "weak").length).toBeGreaterThan(0);
  });

  it("planning is pure: the same state answers the same way twice", () => {
    const lb = new ModelLoadBalancer({ policy: "round-robin" });
    const pool = [cand("a"), cand("b"), cand("c")];
    const first = lb.order({ candidates: pool }).map((m) => m.id);
    const second = lb.order({ candidates: pool }).map((m) => m.id);
    expect(second).toEqual(first);
    lb.begin("a").finish(true);
    expect(lb.order({ candidates: pool }).map((m) => m.id)).not.toEqual(first);
  });

  it("an unleased in-flight call still shifts the load", () => {
    const lb = new ModelLoadBalancer({ policy: "least-loaded" });
    const pool = [cand("a"), cand("b")];
    lb.begin("a");
    expect(lb.order({ candidates: pool })[0].id).toBe("b");
  });
});

describe("ModelLoadBalancer — pins and stickiness", () => {
  it("a model the user picked is honoured exactly", () => {
    const lb = new ModelLoadBalancer({ policy: "round-robin" });
    const pool = [cand("a"), cand("b"), cand("c")];
    expect(drive(lb, pool, 3, { pinnedId: "c", pin: "forced" })).toEqual(["c", "c", "c"]);
    // …and the fallbacks behind it still rotate, so a retry does not always hit
    // the same second model.
    const ordered = lb.order({ candidates: pool, pinnedId: "c", pin: "forced" });
    expect(ordered.map((m) => m.id)[0]).toBe("c");
    expect(ordered.length).toBe(3);
  });

  it("a configured default takes a bigger share, never the whole pool", () => {
    const lb = new ModelLoadBalancer({ policy: "weighted-round-robin" });
    const pool = [cand("default"), cand("peer-a"), cand("peer-b")];
    const used = drive(lb, pool, 12, { pinnedId: "default", pin: "boost" });
    const forDefault = used.filter((u) => u === "default").length;
    expect(used[0]).toBe("default");          // it does lead the rotation
    expect(forDefault).toBeGreaterThan(4);    // …with roughly double the share
    expect(forDefault).toBeLessThan(12);       // …but the peers are not idle
    expect(new Set(used).size).toBe(3);
  });

  it("a boosted default that keeps failing stops leading (demoted, not dropped)", () => {
    const lb = new ModelLoadBalancer({ policy: "adaptive", failureThreshold: 1, cooldownMs: 60_000 });
    const pool = [cand("default"), cand("peer")];
    lb.begin("default", { scope: "s" }).finish(false);
    const ordered = lb.order({ candidates: pool, pinnedId: "default", pin: "boost" });
    expect(ordered[0].id).toBe("peer");
    expect(ordered.map((m) => m.id)).toContain("default");
  });

  it("affinity keeps one conversation on one model while other conversations rotate", () => {
    const lb = new ModelLoadBalancer({ policy: "round-robin", sessionStickyMs: 60_000 });
    const pool = [cand("a"), cand("b"), cand("c")];
    const thread1 = drive(lb, pool, 3, { affinityKey: "conv-1" });
    expect(new Set(thread1).size).toBe(1);
    // A second conversation is not bound to the first one's model.
    const other = lb.order({ candidates: pool, affinityKey: "conv-2" })[0].id;
    expect(POOL_IDS(pool)).toContain(other);
  });

  it("affinity is abandoned when the sticky model breaks", () => {
    const lb = new ModelLoadBalancer({ policy: "round-robin", sessionStickyMs: 60_000, failureThreshold: 1, cooldownMs: 60_000 });
    const pool = [cand("a"), cand("b")];
    lb.begin("a", { affinityKey: "conv-1" }).finish(true);
    expect(lb.order({ candidates: pool, affinityKey: "conv-1" })[0].id).toBe("a");
    // Trip the circuit breaker for the sticky model → the conversation moves.
    lb.begin("a", { affinityKey: "conv-1" }).finish(false);
    expect(lb.order({ candidates: pool, affinityKey: "conv-1" })[0].id).toBe("b");
  });
});

const POOL_IDS = (pool: LoadBalanceCandidate[]) => pool.map((p) => p.id);

describe("ModelLoadBalancer — health", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cools down a model that keeps failing, then brings it back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const lb = new ModelLoadBalancer({ policy: "adaptive", failureThreshold: 2, cooldownMs: 5_000 });
    const pool = [cand("flaky"), cand("solid")];
    lb.begin("flaky").finish(false);
    lb.begin("flaky").finish(false);
    let ordered = lb.order({ candidates: pool });
    expect(ordered[ordered.length - 1].id).toBe("flaky");
    // Demoted, never removed: it stays the last resort.
    expect(ordered.length).toBe(2);
    expect(lb.snapshot(pool).find((r) => r.modelId === "flaky")?.cooldownUntil).toBeGreaterThan(Date.now());
    vi.advanceTimersByTime(6_000);
    ordered = lb.order({ candidates: pool });
    expect(ordered.some((m) => m.id === "flaky")).toBe(true);
    expect(ordered.map((m) => m.id)).toContain("flaky");
  });

  it("a success clears the error streak", () => {
    const lb = new ModelLoadBalancer({ policy: "adaptive", failureThreshold: 3, cooldownMs: 60_000 });
    const pool = [cand("a"), cand("b")];
    lb.begin("a").finish(false);
    lb.begin("a").finish(false);
    lb.begin("a").finish(true);
    expect(lb.snapshot(pool).find((r) => r.modelId === "a")?.consecutiveErrors).toBe(0);
    expect(lb.snapshot(pool).find((r) => r.modelId === "a")?.cooldownUntil).toBe(0);
  });

  it("one broken model among many never starves the pool", () => {
    const lb = new ModelLoadBalancer({ policy: "adaptive", failureThreshold: 1, cooldownMs: 60_000 });
    const pool = [cand("broken"), cand("ok1"), cand("ok2")];
    lb.begin("broken").finish(false);
    const used = drive(lb, pool, 6);
    expect(used).not.toContain("broken");
  });

  it("reset() forgets rotation, cooldowns and affinities", () => {
    const lb = new ModelLoadBalancer({ policy: "round-robin", failureThreshold: 1, cooldownMs: 60_000 });
    const pool = [cand("a"), cand("b")];
    drive(lb, pool, 2);
    lb.begin("a").finish(false);
    lb.reset();
    expect(lb.order({ candidates: pool })[0].id).toBe("a");
    expect(lb.snapshot(pool).every((r) => r.picks === 0)).toBe(true);
  });
});

describe("routing policy surface", () => {
  it("ignores unknown policies instead of breaking routing", () => {
    const lb = new ModelLoadBalancer({ policy: "round-robin" });
    const cfg = lb.configure({ policy: "vibes" as (typeof ROUTING_POLICIES)[number], cooldownMs: -5, sessionStickyMs: 99e9 });
    expect(cfg.policy).toBe("round-robin");
    expect(cfg.cooldownMs).toBe(1_000);
    expect(cfg.sessionStickyMs).toBe(3_600_000);
  });

  it("loadWeight 0 keeps a model as fallback-only, never the first pick", () => {
    const lb = new ModelLoadBalancer({ policy: "weighted-round-robin" });
    const pool = [cand("spare", { loadWeight: 0 }), cand("workhorse")];
    expect(drive(lb, pool, 4)).toEqual(["workhorse", "workhorse", "workhorse", "workhorse"]);
  });
});

/* ------------------------------------------------------------------ *
 * Integration with the Model Router — the path chat and Telegram use.
 * ------------------------------------------------------------------ */

function mkModel(partial: Partial<Model>): Model {
  const now = new Date().toISOString();
  return {
    id: partial.id!,
    providerId: partial.providerId ?? "provider-x",
    modelId: partial.modelId ?? partial.id!,
    displayName: partial.displayName ?? partial.id!,
    contextWindow: partial.contextWindow ?? 128000,
    inputCostPer1k: partial.inputCostPer1k ?? 0,
    outputCostPer1k: partial.outputCostPer1k ?? 0,
    capabilities: partial.capabilities ?? {
      vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true,
    },
    active: true,
    priority: partial.priority ?? 100,
    fallbackPriority: partial.fallbackPriority ?? 100,
    loadWeight: partial.loadWeight,
    maxConcurrency: partial.maxConcurrency,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

const NO_MODELS_ASSIGNED: AgentModelConfig = { primary: "", fallbacks: [], specialized: {} };

describe("ModelRouter × ModelLoadBalancer", () => {
  it("rotates over the whole registry when nothing is pinned", () => {
    const lb = new ModelLoadBalancer({ policy: "round-robin" });
    const router = new ModelRouter(lb);
    const models = ["model-a", "model-b", "model-c"].map((id, i) => toCandidate(mkModel({ id, priority: i + 1 })));
    const answers: string[] = [];
    for (let i = 0; i < 6; i++) {
      const picked = router.route(models, NO_MODELS_ASSIGNED, "fast", { balance: { scope: "owner:u1" } })[0];
      answers.push(picked.id);
      lb.begin(picked.id).finish(true);
    }
    expect(answers).toEqual(["model-a", "model-b", "model-c", "model-a", "model-b", "model-c"]);
  });

  it("without a balancer the router keeps its single-best answer", () => {
    const router = new ModelRouter();
    const models = ["model-a", "model-b"].map((id, i) => toCandidate(mkModel({ id, priority: i + 1 })));
    const picks = Array.from({ length: 3 }, () => router.route(models, NO_MODELS_ASSIGNED, "fast")[0].id);
    expect(picks).toEqual(["model-a", "model-a", "model-a"]);
  });

  it("an explicitly chosen model is never rotated away, and the allow-list still applies", () => {
    const lb = new ModelLoadBalancer({ policy: "round-robin" });
    const router = new ModelRouter(lb);
    const models = ["model-a", "model-b", "model-c"].map((id) => toCandidate(mkModel({ id })));
    for (let i = 0; i < 3; i++) {
      const ordered = router.route(models, { ...NO_MODELS_ASSIGNED, allowedModels: ["model-b", "model-c"] }, "fast", {
        userPreferredModelId: "model-c",
        balance: { pin: "forced", scope: "owner:u1" },
      });
      expect(ordered[0].id).toBe("model-c");
      expect(ordered.map((m) => m.id)).not.toContain("model-a");
      lb.begin(ordered[0].id).finish(true);
    }
  });

  it("the router default is a boost, so a whole pool is kept warm", () => {
    const lb = new ModelLoadBalancer({ policy: "weighted-round-robin" });
    const router = new ModelRouter(lb);
    const models = [toCandidate(mkModel({ id: "model-default", priority: 1 })), toCandidate(mkModel({ id: "model-peer", priority: 2 }))];
    // No explicit `pin`: routing on a configured default must not monopolise.
    const opts = { userPreferredModelId: "model-default" };
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const chosen = router.route(models, NO_MODELS_ASSIGNED, "fast", opts)[0].id;
      picks.push(chosen);
      lb.begin(chosen, { scope: "owner:u1" }).finish(true);
    }
    expect(picks[0]).toBe("model-default");
    expect(new Set(picks).size).toBe(2);
  });

  it("candidates keep their load hints so provider rate limits count as pressure", () => {
    const m = toCandidate(mkModel({ id: "model-x", loadWeight: 3, maxConcurrency: 2 }), { rateLimitPerMinute: 60 });
    const c: CandidateModel = m;
    expect(c.loadWeight).toBe(3);
    expect(c.maxConcurrency).toBe(2);
    expect(c.rateLimitPerMinute).toBe(60);
  });
});
