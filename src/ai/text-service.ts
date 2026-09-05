import type { ModelRepository, ProviderRepository } from "./model-repo.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { toCandidate, type ModelRouter, type TaskCategory } from "./model-router.js";
import type { CostRepository } from "../observability/repos.js";
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
}

export interface AiTextResult {
  content: string;
  modelId: string;
  providerId: string;
  costUsd: number;
  totalTokens: number;
}

const EMPTY_MODELS: AgentModelConfig = { primary: "", fallbacks: [], specialized: {} };

/**
 * Shared "ask a model" helper used outside agent runs (conversation
 * summarisation, PR descriptions, Telegram chat…). Goes through the model
 * router so it honours provider priority, capabilities and automatic
 * fallback (A → B → C) and records cost like any agent call.
 * Returns `null` when no active provider/model is configured — callers must
 * degrade gracefully (heuristic fallback) instead of failing.
 */
export class AiTextService {
  constructor(
    private readonly deps: {
      modelRepo: ModelRepository;
      providerRepo: ProviderRepository;
      providerRegistry: ProviderRegistry;
      modelRouter: ModelRouter;
      costRepo: CostRepository;
    },
  ) {}

  async complete(req: AiTextRequest): Promise<AiTextResult | null> {
    const available = this.deps.modelRepo.listActive().map(toCandidate);
    const candidates = this.deps.modelRouter.route(available, req.agentModels ?? EMPTY_MODELS, req.category ?? "fast", {
      userPreferredModelId: req.preferredModelId,
    });
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
          temperature: req.temperature ?? 0.2,
          maxTokens: req.maxTokens,
        });
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
          durationMs: Date.now() - startedAt,
        });
        return {
          content: response.content,
          modelId: model.id,
          providerId: providerConfig.id,
          costUsd: response.costUsd ?? 0,
          totalTokens: response.usage.totalTokens,
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
