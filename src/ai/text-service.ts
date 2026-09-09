import type { ModelRepository, ProviderRepository } from "./model-repo.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { toCandidate, type ModelRouter, type TaskCategory } from "./model-router.js";
import type { CostRepository } from "../observability/repos.js";
import { ModelBenchmarkRepository } from "../observability/model-bench-repo.js";
import type { ChatMessage } from "./types.js";
import type { AgentModelConfig } from "../domain/entities.js";
import { logger } from "../logger.js";

export interface AiTextRequest {
  messages: ChatMessage[];
  /** Routing category (fast → cheap/quick models first). */
  category?: TaskCategory;
  /** Optional preferred model id (e.g. conversation.modelId). */
  preferredModelId?: string;
  /** Optional agent model config to honour primary/fallback ordering. */
  agentModels?: AgentModelConfig;
  temperature?: number;
  maxTokens?: number;
  /** Cost attribution. */
  projectId?: string;
  agentId?: string;
  taskId?: string;
  correlationId?: string;
  /** Optional hard latency budget (ms); router de-prioritises models whose
   *  benchmark p95 is far above this. */
  maxLatencyMs?: number;
}

export interface AiTextResult {
  content: string;
  modelId: string;
  providerId: string;
  costUsd: number;
  totalTokens: number;
  latencyMs: number;
}

const EMPTY_MODELS: AgentModelConfig = { primary: "", fallbacks: [], specialized: {} };

/**
 * Shared "ask a model" helper used outside agent runs (conversation
 * summarisation, PR descriptions, Telegram chat…). Goes through the model
 * router so it honours:
 *  - agent-configured primary/fallbacks + allowedModels allow-list
 *  - capability and budget constraints
 *  - real-world performance telemetry (accuracy/latency/error rate from
 *    math benchmarks)
 *  - automatic fallback (A → B → C) on failure.
 *
 * Records cost + latency like any agent call.
 * Returns `null` when no active provider/model is configured.
 */
export class AiTextService {
  constructor(
    private readonly deps: {
      modelRepo: ModelRepository;
      providerRepo: ProviderRepository;
      providerRegistry: ProviderRegistry;
      modelRouter: ModelRouter;
      costRepo: CostRepository;
      benchRepo: ModelBenchmarkRepository;
    },
  ) {}

  async complete(req: AiTextRequest): Promise<AiTextResult | null> {
    const available = this.deps.modelRepo.listActive().map(toCandidate);
    const perfStats = this.deps.benchRepo.computeStats();
    ModelBenchmarkRepository.addSpeedNormalisation(perfStats);
    const candidates = this.deps.modelRouter.route(
      available,
      req.agentModels ?? EMPTY_MODELS,
      req.category ?? "fast",
      {
        userPreferredModelId: req.preferredModelId,
        maxLatencyMs: req.maxLatencyMs,
      },
      perfStats,
    );
    let lastError: unknown;
    for (const candidate of candidates) {
      const model = this.deps.modelRepo.findById(candidate.id)?.data;
      if (!model) continue;
      const providerConfig = this.deps.providerRepo.findById(model.providerId)?.data;
      if (!providerConfig || !providerConfig.active) continue;
      const startedAt = Date.now();
      try {
        const provider = this.deps.providerRegistry.resolve(providerConfig);
        const response = await provider.chat({
          modelId: model.modelId,
          messages: req.messages,
          temperature: model.temperature ?? req.temperature ?? 0.2,
          maxTokens: model.maxTokens ?? req.maxTokens,
          omitTemperature: model.omitTemperature === true,
        });
        const latency = Date.now() - startedAt;
        this.deps.costRepo.create({
          providerId: providerConfig.id,
          modelId: model.id,
          projectId: req.projectId,
          agentId: req.agentId,
          taskId: req.taskId,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          estimatedCostUsd: response.costUsd ?? 0,
          durationMs: latency,
        });
        return {
          content: response.content,
          modelId: model.id,
          providerId: providerConfig.id,
          costUsd: response.costUsd ?? 0,
          totalTokens: response.usage.totalTokens,
          latencyMs: latency,
        };
      } catch (err) {
        lastError = err;
        logger.warn(`text-service: model ${candidate.id} failed, trying next`, { err: String(err), correlationId: req.correlationId });
      }
    }
    if (lastError) logger.error("text-service: all models failed", { err: String(lastError), correlationId: req.correlationId });
    return null;
  }
}
