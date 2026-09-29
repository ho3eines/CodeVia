import { afterEach, describe, expect, it } from "vitest";
import { ModelRouter, type CandidateModel } from "../ai/model-router.js";
import type { AgentModelConfig, ModelPerformanceStats } from "../domain/entities.js";
import { JobQueue } from "../db/queue.js";
import { freshDb } from "./test-helpers.js";

const NONE: AgentModelConfig = { primary: "", fallbacks: [], specialized: {} };

function model(id: string, extra: Partial<CandidateModel> = {}): CandidateModel {
  return {
    id,
    modelId: id,
    displayName: id,
    providerId: "p",
    contextWindow: 100000,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: { vision: false, tools: true, structuredOutput: true, code: true, reasoning: true, streaming: true },
    priority: 1,
    fallbackPriority: 1,
    ...extra,
  };
}

function stat(modelId: string, p95LatencyMs: number, score = 0.9): ModelPerformanceStats {
  return {
    modelId,
    totalAttempts: 5,
    successAttempts: 5,
    correctCount: 5,
    accuracy: 1,
    avgLatencyMs: p95LatencyMs,
    p95LatencyMs,
    errorRate: 0,
    avgCostUsd: 0,
    score,
    byKind: {},
  };
}

describe("ModelRouter logic fixes", () => {
  const router = new ModelRouter();

  it("fails closed when every allow-listed model is unavailable", () => {
    const out = router.route([model("a"), model("b")], { ...NONE, allowedModels: ["gone"] }, "fast");
    expect(out).toEqual([]);
  });

  it("does not mutate the caller's candidate objects", () => {
    const a = model("a");
    router.route([a], NONE, "fast", {}, [stat("a", 100, 0.99)]);
    expect(a.perfScore).toBeUndefined();
  });

  it("applies the cost ceiling to the estimated request cost", () => {
    const cheap = model("cheap", { inputCostPer1k: 0.001 });
    const pricey = model("pricey", { inputCostPer1k: 1 });
    const out = router.route([pricey, cheap], NONE, "fast", { maxCostUsd: 0.5, maxTokens: 1000 });
    expect(out.map((m) => m.id)).toEqual(["cheap"]);
  });

  it("demotes models far above the latency budget but keeps them as a last resort", () => {
    const out = router.route([model("slow"), model("fast"), model("unknown")], NONE, "fast", { maxLatencyMs: 1000 }, [
      stat("slow", 5000, 0.99),
      stat("fast", 500, 0.5),
    ]);
    expect(out.map((m) => m.id)).toEqual(["fast", "unknown", "slow"]);
  });
});

describe("JobQueue lease heartbeat and retry", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  it("a heartbeat keeps a long-running job from being reclaimed as abandoned", () => {
    const h = freshDb();
    cleanup = h.cleanup;
    const q = new JobQueue();
    const job = q.enqueue("agent.run", { taskId: "t1" });
    expect(q.claim(1).map((j) => j.id)).toEqual([job.id]);
    const stale = new Date(Date.now() - JobQueue.LEASE_TTL_MS - 60_000).toISOString();
    h.db.run(`UPDATE jobs SET started_at = :s WHERE id = :id`, { s: stale, id: job.id });
    q.heartbeat([job.id]);
    expect(q.claim(1)).toEqual([]);
    expect(q.getById(job.id)?.status).toBe("running");
    expect(q.getById(job.id)?.attempts).toBe(0);
  });

  it("scheduleRetry records the attempt and defers the job atomically", () => {
    const h = freshDb();
    cleanup = h.cleanup;
    const q = new JobQueue();
    const job = q.enqueue("agent.run", { taskId: "t2" });
    q.claim(1);
    const later = new Date(Date.now() + 60_000).toISOString();
    const after = q.scheduleRetry(job.id, 1, "boom", later);
    expect(after).toMatchObject({ status: "pending", attempts: 1, error: "boom" });
    expect(q.claim(1)).toEqual([]);
  });
});
