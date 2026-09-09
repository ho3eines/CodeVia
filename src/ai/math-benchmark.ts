import { randomUUID, randomInt } from "node:crypto";
import type { ModelRepository, ProviderRepository } from "../ai/model-repo.js";
import type { ProviderRegistry } from "../ai/provider-registry.js";
import { toCandidate } from "../ai/model-router.js";
import { ModelBenchmarkRepository } from "../observability/model-bench-repo.js";
import type { CostRepository } from "../observability/repos.js";
import type { MathBenchmarkProblem, ModelBenchmarkResult } from "../domain/entities.js";
import { logger } from "../logger.js";

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
 */
export class MathBenchmarkService {
  constructor(
    private readonly deps: {
      modelRepo: ModelRepository;
      providerRepo: ProviderRepository;
      providerRegistry: ProviderRegistry;
      benchRepo: ModelBenchmarkRepository;
      costRepo: CostRepository;
    },
  ) {}

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
        const friends = randomInt(2, 8);
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

  /**
   * Run every active model against a fresh batch of problems and persist results.
   * Returns all recorded rows + updated per-model stats.
   */
  async runBenchmark(opts: { problemsPerModel?: number; modelIds?: string[] } = {}): Promise<{
    runId: string;
    results: ModelBenchmarkResult[];
    problemCount: number;
    modelCount: number;
  }> {
    const runId = randomUUID();
    const problems = this.generateProblems(opts.problemsPerModel ?? 8);
    const active = this.deps.modelRepo.listActive().map(toCandidate);
    const targets = opts.modelIds?.length
      ? active.filter((c) => opts.modelIds!.includes(c.id))
      : active;

    logger.info(`benchmark starting run ${runId}`, { models: targets.length, problems: problems.length });
    const results: ModelBenchmarkResult[] = [];

    for (const candidate of targets) {
      const model = this.deps.modelRepo.findById(candidate.id)?.data;
      if (!model) continue;
      const providerConfig = this.deps.providerRepo.findById(model.providerId)?.data;
      if (!providerConfig?.active) continue;
      let provider;
      try {
        provider = this.deps.providerRegistry.resolve(providerConfig);
      } catch (err) {
        logger.warn(`benchmark: skipping ${model.id} (provider resolve failed)`, { err: String(err) });
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
      }
    }

    logger.info(`benchmark run ${runId} complete`, { results: results.length });
    return {
      runId,
      results,
      problemCount: problems.length,
      modelCount: targets.length,
    };
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
