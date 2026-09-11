import { DocumentRepository } from "../db/repository.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import type { ModelBenchmarkResult, ModelPerformanceStats } from "../domain/entities.js";
import { randomUUID } from "node:crypto";

export class ModelBenchmarkRepository extends DocumentRepository<ModelBenchmarkResult> {
  constructor(db: Db = getDb()) {
    super("model-benchmark", db);
  }

  record(data: Omit<ModelBenchmarkResult, "id" | "createdAt">): ModelBenchmarkResult {
    const rec: ModelBenchmarkResult = {
      ...data,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.upsert(rec, { parentId: data.modelId, key: data.benchmarkRunId });
    return rec;
  }

  /** All results for a specific model. */
  forModel(modelId: string): ModelBenchmarkResult[] {
    return this.findMany({ parentId: modelId }).map((r) => r.data);
  }

  /** All results from a single benchmark run. */
  forRun(runId: string): ModelBenchmarkResult[] {
    return this.findMany({ key: runId }).map((r) => r.data);
  }

  /**
   * Drop every stored result belonging to a model. Called when a model (or its
   * provider, which deletes the provider's models) is deleted so deleted models
   * never resurface in the benchmark table / smart-router stats.
   */
  purgeForModel(modelId: string): number {
    return this.purgeForModels([modelId]);
  }

  /** Drop every stored result whose modelId is in the given set. */
  purgeForModels(modelIds: string[]): number {
    const set = new Set(modelIds);
    if (!set.size) return 0;
    let n = 0;
    for (const rec of this.findMany({})) {
      if (set.has(rec.data.modelId)) {
        this.deleteById(rec.data.id);
        n++;
      }
    }
    return n;
  }

  /** Purge all results older than `cutoffMs` (default: keep last 30 days). */
  prune(cutoffMs = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - cutoffMs).toISOString();
    let n = 0;
    for (const rec of this.findMany({})) {
      if (rec.data.createdAt < cutoff) {
        this.deleteById(rec.data.id);
        n++;
      }
    }
    return n;
  }

  /**
   * Compute per-model aggregated stats from every stored result.
   * Used by the smart router as a performance signal and by the UI for display.
   */
  computeStats(): ModelPerformanceStats[] {
    const byModel = new Map<string, ModelBenchmarkResult[]>();
    for (const rec of this.findMany({})) {
      const d = rec.data;
      if (!byModel.has(d.modelId)) byModel.set(d.modelId, []);
      byModel.get(d.modelId)!.push(d);
    }
    const stats: ModelPerformanceStats[] = [];
    for (const [modelId, results] of byModel) {
      stats.push(this.aggregate(modelId, results));
    }
    // Best score first.
    stats.sort((a, b) => b.score - a.score);
    return stats;
  }

  statsFor(modelId: string): ModelPerformanceStats | null {
    const results = this.forModel(modelId);
    if (!results.length) return null;
    return this.aggregate(modelId, results);
  }

  private aggregate(modelId: string, results: ModelBenchmarkResult[]): ModelPerformanceStats {
    const providerId = results[0]?.providerId ?? "";
    const success = results.filter((r) => r.answered && !r.error);
    const errors = results.length - success.length;
    const correct = success.filter((r) => r.correct).length;
    const latencies = success.map((r) => r.latencyMs).sort((a, b) => a - b);
    const avgLatency = latencies.length
      ? Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length)
      : 0;
    const p95 = latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
      : 0;
    const avgCost = success.length
      ? success.reduce((s, r) => s + (r.costUsd || 0), 0) / success.length
      : 0;
    const accuracy = success.length ? correct / success.length : 0;
    const errorRate = results.length ? errors / results.length : 0;

    // Composite score: accuracy 60%, reliability (1 - errorRate) 20%, speed 20%.
    // Speed is normalised against the slowest successful model we have seen for
    // this dataset — relative, not absolute, so adding a new slower model
    // doesn't magically make others worse.
    const score = accuracy * 0.6 + (1 - errorRate) * 0.2; // speed blended globally
    // (Speed is normalised later by the caller that has all models in view.)

    const byKind: ModelPerformanceStats["byKind"] = {};
    for (const r of results) {
      const k = r.problemKind;
      if (!byKind[k]) byKind[k] = { attempts: 0, correct: 0, accuracy: 0 };
      byKind[k].attempts++;
      if (r.correct) byKind[k].correct++;
    }
    for (const k of Object.keys(byKind)) {
      const b = byKind[k];
      b.accuracy = b.attempts ? b.correct / b.attempts : 0;
    }
    const lastTestedAt = results.reduce(
      (max, r) => (r.createdAt > (max ?? "") ? r.createdAt : max),
      undefined as string | undefined,
    );
    // Most recent error message (for the "Unresponsive" cleanup list in the UI).
    const lastError = results
      .filter((r) => r.error)
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))[0]?.error;
    return {
      modelId,
      totalAttempts: results.length,
      successAttempts: success.length,
      correctCount: correct,
      accuracy,
      avgLatencyMs: avgLatency,
      p95LatencyMs: p95,
      errorRate,
      avgCostUsd: avgCost,
      score, // filled with global speed normalisation by the caller
      byKind,
      lastTestedAt,
      ...(lastError ? { lastError } : {}),
    };
  }

  /**
   * Add the speed component (which needs a global max-latency across models to
   * normalise). The router calls this after getting all per-model stats so
   * that each model's score reflects how fast it is *relative to its peers*.
   */
  static addSpeedNormalisation(stats: ModelPerformanceStats[]): void {
    const maxLat = Math.max(1, ...stats.map((s) => s.p95LatencyMs || s.avgLatencyMs || 1));
    for (const s of stats) {
      const lat = s.p95LatencyMs || s.avgLatencyMs || maxLat;
      const speedFactor = 1 - lat / maxLat; // 0 = slowest, ~1 = fastest
      const accComponent = s.accuracy * 0.6;
      const errComponent = (1 - s.errorRate) * 0.2;
      const speedComponent = Math.max(0, speedFactor) * 0.2;
      // Tiny bonus for cheap models when accuracy is tied (sub-cent penalty).
      s.score = accComponent + errComponent + speedComponent;
    }
    stats.sort((a, b) => b.score - a.score);
  }
}

let repo: ModelBenchmarkRepository | null = null;
let repoDb: unknown = null;
/**
 * The benchmark repository is a process-wide singleton, but `getDb()` is not:
 * tests (and a reconfigured runtime) swap the active database behind it. Caching
 * the repository without tracking the database it was built on left it holding a
 * closed handle — every model call after the first database swap failed with
 * "database is not open" (agent runs, chat, benchmark stats). Re-bind whenever
 * the active database changes.
 */
export function getModelBenchmarkRepo(): ModelBenchmarkRepository {
  const db = getDb();
  if (!repo || repoDb !== db) {
    repo = new ModelBenchmarkRepository(db);
    repoDb = db;
  }
  return repo;
}
