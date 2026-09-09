import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import { ModelBenchmarkRepository } from "../../observability/model-bench-repo.js";

/**
 * Model benchmarking routes.
 *
 *   POST /models/benchmark/run         -> start a benchmark run (background, paced)
 *   GET  /models/benchmark/status      -> live progress of the current run
 *   GET  /models/benchmark/stats       -> aggregated per-model performance stats
 *   GET  /models/benchmark/results     -> raw results (latest run, or ?runId= / ?modelId=)
 *
 * Stats power the smart router and appear in the Models page as a table of
 * accuracy / latency / error rate / composite score.
 *
 * Rate-limit friendliness: `/run` starts the benchmark in the background and
 * returns immediately; the service paces requests (a pause between every
 * provider call) and publishes progress that the client polls via `/status`.
 * Only ACTIVE models whose provider is ACTIVE are ever tested, and only stats
 * for currently-existing models are returned so deleted models never show up.
 */
export function registerModelBenchRoutes(app: FastifyInstance, container: Container): void {
  app.post("/models/benchmark/run", { schema: { tags: ["models"], summary: "Start a paced math benchmark across active models" } }, async (req) => {
    const body = (req.body ?? {}) as { problemsPerModel?: number; modelIds?: string[] };
    const n = Math.max(2, Math.min(50, Number(body.problemsPerModel) || 8));

    if (container.mathBench.isRunning()) {
      const p = container.mathBench.getProgress();
      return {
        ok: true,
        started: false,
        running: true,
        alreadyRunning: true,
        runId: p.runId,
        message: "A benchmark run is already in progress — wait for it to finish before starting another.",
        totalModels: p.totalModels,
        problemCount: p.totalProblems,
      };
    }

    const res = container.mathBench.start({ problemsPerModel: n, modelIds: body.modelIds });
    const p = container.mathBench.getProgress();
    return {
      ok: true,
      started: res.started,
      running: true,
      alreadyRunning: res.alreadyRunning,
      runId: res.runId,
      totalModels: p.totalModels,
      problemCount: p.totalProblems,
      delayMs: p.delayMs,
    };
  });

  app.get("/models/benchmark/status", { schema: { tags: ["models"], summary: "Live progress of the running (or last) benchmark" } }, async () => {
    const progress = container.mathBench.getProgress();
    return { running: container.mathBench.isRunning(), progress };
  });

  app.get("/models/benchmark/stats", { schema: { tags: ["models"], summary: "Per-model benchmark stats used for smart routing" } }, async () => {
    const stats = container.benchRepo.computeStats();
    // Only show stats for models that still exist in the registry, so a model
    // that has since been deleted (individually or with its provider) never
    // reappears in the benchmark table / routing signal.
    const liveIds = new Set(container.modelRepo.listActive().map((m) => m.id));
    const liveStats = stats.filter((s) => liveIds.has(s.modelId));
    ModelBenchmarkRepository.addSpeedNormalisation(liveStats);
    return { stats: liveStats };
  });

  app.get("/models/benchmark/results", { schema: { tags: ["models"] } }, async (req) => {
    const q = req.query as { runId?: string; modelId?: string; limit?: string };
    let recs = container.benchRepo.findMany({});
    if (q.runId) recs = recs.filter((r) => r.data.benchmarkRunId === q.runId);
    if (q.modelId) recs = recs.filter((r) => r.data.modelId === q.modelId);
    const limit = Math.min(500, Number(q.limit) || 200);
    // Most recent first.
    recs.sort((a, b) => (b.data.createdAt > a.data.createdAt ? 1 : -1));
    return { results: recs.slice(0, limit).map((r) => r.data) };
  });
}
