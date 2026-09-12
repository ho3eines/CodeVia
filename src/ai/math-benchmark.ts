import { randomUUID, randomInt } from "node:crypto";
import type { ModelRepository, ProviderRepository } from "../ai/model-repo.js";
import type { ProviderRegistry } from "../ai/provider-registry.js";
import { toCandidate } from "../ai/model-router.js";
import { ModelBenchmarkRepository } from "../observability/model-bench-repo.js";
import type { CostRepository } from "../observability/repos.js";
import type { MathBenchmarkProblem, Model, ModelBenchmarkResult, ModelProvider } from "../domain/entities.js";
import { logger } from "../logger.js";

interface BenchmarkTarget {
  model: Model;
  providerConfig: ModelProvider;
}

/**
 * Benchmark run state surfaced to the UI so the user can watch what is being
 * tested instead of firing the whole thing in a silent, blocking request.
 */
export interface BenchmarkRunProgress {
  runId: string;
  /** idle = nothing running · running · done · error */
  status: "idle" | "running" | "done" | "error";
  /** Pause inserted between successive provider calls (rate-limit friendly). */
  delayMs: number;
  totalModels: number;
  completedModels: number;
  currentModelId: string | null;
  currentModelLabel: string | null;
  totalProblems: number;
  completedProblems: number;
  /** Total recorded results so far in this run. */
  resultCount: number;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
}

function envDelay(env?: string, fallback = 2500): number {
  const raw = process.env[env || "BENCHMARK_CALL_DELAY_MS"];
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const pause = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * MathBenchmarkService
 * --------------------
 * Generates random grade-school math problems, asks every ACTIVE model to
 * solve them with temperature = 0 (deterministic), parses the numeric answer,
 * and records whether the model got it right, how fast it responded, how much
 * it cost, and whether it errored out.
 *
 * The stored results feed the ModelRouter so it picks the *actually best*
 * model for each category (highest accuracy, lowest latency, fewest errors)
 * rather than relying on hand-tuned `priority` fields.
 *
 * Rate-limit friendliness: calls are strictly serialised and a pause of
 * `BENCHMARK_CALL_DELAY_MS` (default 2.5s) is inserted between every request so
 * providers are never hammered by a parallel fan-out. Runs execute in the
 * background and publish live progress (see {@link BenchmarkRunProgress}) which
 * the web UI polls to show the model currently being tested.
 */
export class MathBenchmarkService {
  private executing = false;
  private progress: BenchmarkRunProgress = this.idleProgress();
  private delayMs = envDelay();

  constructor(
    private readonly deps: {
      modelRepo: ModelRepository;
      providerRepo: ProviderRepository;
      providerRegistry: ProviderRegistry;
      benchRepo: ModelBenchmarkRepository;
      costRepo: CostRepository;
    },
  ) {}

  /** Compute the list of ACTIVE models whose provider is also currently active. */
  private resolveTargets(modelIds?: string[], ownerId?: string): BenchmarkTarget[] {
    // Per-account: only the requesting account's models (+ shared rows) are
    // benchmarked — never another account's paid provider.
    const active = this.deps.modelRepo.listActiveForOwner(ownerId).map(toCandidate);
    const picked = modelIds?.length ? active.filter((c) => modelIds!.includes(c.id)) : active;
    const out = [];
    for (const candidate of picked) {
      const model = this.deps.modelRepo.findById(candidate.id)?.data;
      if (!model) continue;
      const providerConfig = this.deps.providerRepo.findById(model.providerId)?.data;
      // Skip models whose provider row is gone or disabled — a provider can be
      // deleted independently, and we must never test through a stale provider.
      if (!providerConfig?.active) continue;
      out.push({ model, providerConfig });
    }
    return out;
  }

  private idleProgress(): BenchmarkRunProgress {
    return {
      runId: "",
      status: "idle",
      delayMs: this.delayMs,
      totalModels: 0,
      completedModels: 0,
      currentModelId: null,
      currentModelLabel: null,
      totalProblems: 0,
      completedProblems: 0,
      resultCount: 0,
    };
  }

  private touch(): void {
    this.progress.updatedAt = new Date().toISOString();
  }

  /** Whether a benchmark is currently executing in the background. */
  isRunning(): boolean {
    return this.executing;
  }

  /** Snapshot of the current/last run's progress (safe to send over HTTP). */
  getProgress(): BenchmarkRunProgress {
    return { ...this.progress };
  }

  /**
   * Kick off a benchmark run in the background and return immediately.
   * If one is already running, that run's id is returned instead (no double-run).
   */
  start(opts: { problemsPerModel?: number; modelIds?: string[]; ownerId?: string } = {}): {
    started: boolean;
    runId: string;
    alreadyRunning: boolean;
  } {
    if (this.executing) {
      return { started: false, runId: this.progress.runId, alreadyRunning: true };
    }
    const problems = this.generateProblems(opts.problemsPerModel ?? 8);
    const targets = this.resolveTargets(opts.modelIds, opts.ownerId);
    const runId = randomUUID();
    this.delayMs = envDelay();
    this.progress = {
      runId,
      status: "running",
      delayMs: this.delayMs,
      totalModels: targets.length,
      completedModels: 0,
      currentModelId: null,
      currentModelLabel: null,
      totalProblems: problems.length,
      completedProblems: 0,
      resultCount: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.executing = true;

    // Fire-and-forget; completion / failure is reflected in this.progress.
    void (async () => {
      try {
        const result = await this.performRun(runId, problems, targets);
        logger.info(`benchmark run ${runId} complete`, { results: result.results.length });
        this.progress.status = "done";
        this.progress.resultCount = result.results.length;
        this.progress.completedModels = targets.length;
        this.progress.completedProblems = problems.length;
      } catch (err) {
        logger.error(`benchmark run ${runId} failed`, { err: String(err) });
        this.progress.status = "error";
        this.progress.error = String((err as Error)?.message ?? err);
      } finally {
        this.touch();
        this.executing = false;
      }
    })();

    return { started: true, runId, alreadyRunning: false };
  }

  private async performRun(
    runId: string,
    problems: MathBenchmarkProblem[],
    targets: BenchmarkTarget[],
  ): Promise<{ results: ModelBenchmarkResult[] }> {
    const results: ModelBenchmarkResult[] = [];
    logger.info(`benchmark starting run ${runId}`, { models: targets.length, problems: problems.length });

    for (let mi = 0; mi < targets.length; mi++) {
      const { model, providerConfig } = targets[mi];
      this.progress.currentModelId = model.id;
      this.progress.currentModelLabel = model.displayName || model.modelId;
      this.touch();

      let provider;
      try {
        provider = this.deps.providerRegistry.resolve(providerConfig);
      } catch (err) {
        logger.warn(`benchmark: skipping ${model.id} (provider resolve failed)`, { err: String(err) });
        this.progress.completedModels = mi + 1;
        this.touch();
        continue;
      }

      for (const problem of problems) {
        const startedAt = Date.now();
        let record: Omit<ModelBenchmarkResult, "id" | "createdAt">;
        try {
          const response = await provider.chat({
            modelId: model.modelId,
            messages: [
              {
                role: "system",
                content:
                  "You are a calculator. Answer ONLY with the numeric result, no explanation, no units, no words. If the answer is a decimal, give at most 4 decimal places.",
              },
              { role: "user", content: problem.question },
            ],
            temperature: 0,
            maxTokens: 20,
            omitTemperature: model.omitTemperature === true,
          });
          const latency = Date.now() - startedAt;
          const answer = (response.content ?? "").trim();
          const parsed = this.parseNumericAnswer(answer);
          const expected = this.parseNumericAnswer(problem.expected);
          const correct = parsed !== null && expected !== null && this.numbersClose(parsed, expected);

          // Attribute cost like a normal call.
          this.deps.costRepo.create({
            providerId: providerConfig.id,
            modelId: model.id,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            totalTokens: response.usage.totalTokens,
            estimatedCostUsd: response.costUsd ?? 0,
            durationMs: latency,
          });

          record = {
            benchmarkRunId: runId,
            modelId: model.id,
            providerId: providerConfig.id,
            problemId: problem.id,
            problemKind: problem.kind,
            question: problem.question,
            expectedAnswer: problem.expected,
            modelAnswer: answer,
            correct,
            answered: parsed !== null,
            latencyMs: latency,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            totalTokens: response.usage.totalTokens,
            costUsd: response.costUsd ?? 0,
          };
        } catch (err) {
          const latency = Date.now() - startedAt;
          record = {
            benchmarkRunId: runId,
            modelId: model.id,
            providerId: providerConfig.id,
            problemId: problem.id,
            problemKind: problem.kind,
            question: problem.question,
            expectedAnswer: problem.expected,
            modelAnswer: "",
            correct: false,
            answered: false,
            latencyMs: latency,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            error: String((err as Error)?.message ?? err),
          };
        }
        results.push(this.deps.benchRepo.record(record));
        this.progress.completedProblems = (this.progress.completedProblems || 0) + 1;
        this.progress.resultCount = results.length;
        this.touch();

        // Pause between every provider request so we never burst a provider
        // with back-to-back calls (the source of the 429 / blocking the user hit).
        await pause(this.progress.delayMs);
      }
      this.progress.completedModels = mi + 1;
      this.touch();
    }

    return { results };
  }

  /**
   * Run every active model against a fresh batch of problems and persist results.
   * Returns all recorded rows + updated per-model stats.
   *
   * NOTE: this blocks until every model has been quizzed (with pacing pauses in
   * between), so it is meant for callers that genuinely need the synchronous
   * result. HTTP requests should use {@link start} + {@link getProgress} instead.
   */
  async runBenchmark(opts: { problemsPerModel?: number; modelIds?: string[]; ownerId?: string } = {}): Promise<{
    runId: string;
    results: ModelBenchmarkResult[];
    problemCount: number;
    modelCount: number;
  }> {
    const problems = this.generateProblems(opts.problemsPerModel ?? 8);
    const targets = this.resolveTargets(opts.modelIds, opts.ownerId);
    const runId = randomUUID();
    const results = (await this.performRun(runId, problems, targets)).results;
    return {
      runId,
      results,
      problemCount: problems.length,
      modelCount: targets.length,
    };
  }

  /** Generate `count` random problems spanning multiple kinds. */
  generateProblems(count = 10): MathBenchmarkProblem[] {
    const kinds: MathBenchmarkProblem["kind"][] = [
      "arithmetic",
      "algebra",
      "word-problem",
      "order-of-ops",
      "fractions",
    ];
    const out: MathBenchmarkProblem[] = [];
    for (let i = 0; i < count; i++) {
      const kind = kinds[i % kinds.length];
      out.push(this.generateOne(kind, i));
    }
    return out;
  }

  private generateOne(kind: MathBenchmarkProblem["kind"], idx: number): MathBenchmarkProblem {
    const id = `prob-${Date.now()}-${idx}`;
    switch (kind) {
      case "arithmetic": {
        const a = randomInt(2, 999);
        const b = randomInt(2, 999);
        const op = ["+", "-", "×"][randomInt(0, 3)];
        let expected: number;
        if (op === "+") expected = a + b;
        else if (op === "-") expected = a - b;
        else expected = a * b;
        return {
          id,
          kind,
          question: `Calculate: ${a} ${op} ${b}. Respond with ONLY the number, no words.`,
          expected: String(expected),
        };
      }
      case "order-of-ops": {
        const a = randomInt(2, 50);
        const b = randomInt(2, 20);
        const c = randomInt(2, 20);
        const d = randomInt(2, 15);
        // a + b × c - d  → multiplication first
        const expected = a + b * c - d;
        return {
          id,
          kind,
          question: `Calculate using standard order of operations: ${a} + ${b} × ${c} - ${d}. Respond with ONLY the number.`,
          expected: String(expected),
        };
      }
      case "algebra": {
        // Solve a·x + b = c  → x = (c-b)/a, keep integer solutions.
        const x = randomInt(2, 50);
        const a = randomInt(2, 12);
        const b = randomInt(1, 50);
        const c = a * x + b;
        return {
          id,
          kind,
          question: `Solve for x: ${a}x + ${b} = ${c}. Respond with ONLY the numeric value of x, no words.`,
          expected: String(x),
        };
      }
      case "fractions": {
        // 1/2 + 1/4 style, result is always a decimal with ≤ 2 digits for easy parsing.
        const pairs = [
          { q: "What is 1/2 + 1/4? Give the decimal answer, only the number.", e: "0.75" },
          { q: "What is 3/4 - 1/2? Give the decimal answer, only the number.", e: "0.25" },
          { q: "What is 1/5 + 2/5? Give the decimal answer, only the number.", e: "0.6" },
          { q: "What is 2/3 + 1/6? Give the decimal answer, only the number.", e: "0.8333" },
          { q: "What is 1/10 + 3/10? Give the decimal answer, only the number.", e: "0.4" },
        ];
        const p = pairs[randomInt(0, pairs.length)];
        return { id, kind, question: p.q, expected: p.e };
      }
      case "word-problem": {
        const apples = randomInt(3, 30);
        const given = randomInt(1, apples);
        const remaining = apples - given;
        return {
          id,
          kind,
          question: `Sarah has ${apples} apples. She gives ${given} to her friend. How many apples does Sarah have left? Respond with ONLY the number.`,
          expected: String(remaining),
        };
      }
    }
  }

  /** Parse the first number (int or decimal, possibly negative) out of a reply. */
  private parseNumericAnswer(text: string): number | null {
    if (!text) return null;
    // Find first numeric token (handles "The answer is 42." or "42." etc.)
    const match = text.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    if (!match) return null;
    const n = Number(match[0]);
    if (!Number.isFinite(n)) return null;
    return n;
  }

  /** Compare two parsed numbers with tolerance (float rounding). */
  private numbersClose(a: number, b: number): boolean {
    if (a === b) return true;
    const tol = Math.max(1e-4, Math.abs(b) * 1e-2);
    return Math.abs(a - b) <= tol;
  }
}
