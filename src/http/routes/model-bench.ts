import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import { ModelBenchmarkRepository } from "../../observability/model-bench-repo.js";

/**
 * Model benchmarking routes.
 *
 *   POST /models/benchmark/run         -> run math benchmark across all (or some) models
 *   GET  /models/benchmark/stats       -> aggregated per-model performance stats
 *   GET  /models/benchmark/results     -> raw results (latest run, or ?runId= / ?modelId=)
 *
 * Stats power the smart router and appear in the Models page as a table of
 * accuracy / latency / error rate / composite score.
 */
export function registerModelBenchRoutes(app: FastifyInstance, container: Container): void {
  app.post("/models/benchmark/run", { schema: { tags: ["models"], summary: "Run math benchmark across active models" } }, async (req) => {
    const body = (req.body ?? {}) as { problemsPerModel?: number; modelIds?: string[] };
    const n = Math.max(2, Math.min(50, Number(body.problemsPerModel) || 8));
    const result = await container.mathBench.runBenchmark({ problemsPerModel: n, modelIds: body.modelIds });
    const stats = container.benchRepo.computeStats();
    ModelBenchmarkRepository.addSpeedNormalisation(stats);
    return {
      ok: true,
      runId: result.runId,
      problemCount: result.problemCount,
      modelCount: result.modelCount,
      resultCount: result.results.length,
      stats,
    };
  });

  app.get("/models/benchmark/stats", { schema: { tags: ["models"], summary: "Per-model benchmark stats used for smart routing" } }, async () => {
    const stats = container.benchRepo.computeStats();
    ModelBenchmarkRepository.addSpeedNormalisation(stats);
    return { stats };
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
