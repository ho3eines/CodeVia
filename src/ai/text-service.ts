import type { ModelRepository, ProviderRepository } from "./model-repo.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { candidatesFor, type ModelRouter, type TaskCategory } from "./model-router.js";
import type { ModelLoadBalancer } from "./load-balancer.js";
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
  /**
   * True when the caller *chose* `preferredModelId` (a model picked in the chat
   * UI): routing pins it. False/absent means "a configured default", which is
   * only a bias — it gets roughly double the traffic share of its peers instead
   * of every request. That is what keeps one model from carrying every chat in
   * an installation with several models.
   */
  preferredModelPinned?: boolean;
  /**
   * Affinity for load distribution: requests sharing a key (one conversation,
   * one task) reuse one model for a short window while different keys rotate
   * across the registry. Omitted = rotate on every call.
   */
  balanceAffinityKey?: string;
  /** Opt out of load distribution (single-shot or pinned calls, e.g. a test). */
  disableLoadBalancing?: boolean;
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
  /**
   * The account whose models may serve this call (project owner, or the
   * signed-in user). Another account's provider is never a candidate, so a
   * request can never spend someone else's key. See `src/ai/ownership.ts`.
   */
  ownerId?: string;
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
      /** Live load counters — in-flight, fair-share cursor, circuit breaker. */
      loadBalancer?: ModelLoadBalancer;
    },
  ) {}

  async complete(req: AiTextRequest): Promise<AiTextResult | null> {
    // Per-account pool: this account's models + the shared platform rows.
    const pool = this.deps.modelRepo.listActiveForOwner(req.ownerId);
    const available = candidatesFor(pool, (providerId) => this.deps.providerRepo.findById(providerId)?.data);
    const perfStats = this.deps.benchRepo.computeStats();
    // Ignore telemetry for models that no longer exist (deleted/deactivated), so
    // a stale model can never skew the speed normalisation or be routed to.
    const liveIds = new Set(pool.map((m) => m.id));
    ModelBenchmarkRepository.addSpeedNormalisation(perfStats.filter((s) => liveIds.has(s.modelId)));
    const candidates = this.deps.modelRouter.route(
      available,
      req.agentModels ?? EMPTY_MODELS,
      req.category ?? "fast",
      {
        userPreferredModelId: req.preferredModelId,
        maxLatencyMs: req.maxLatencyMs,
        balance: {
          // One rotation per account: two users' pools never advance each other.
          scope: `owner:${req.ownerId ?? "platform"}`,
          pin: req.preferredModelPinned ? "forced" : "boost",
          affinityKey: req.balanceAffinityKey,
          disable: req.disableLoadBalancing,
        },
      },
      perfStats,
    );
    let lastError: unknown;
    for (const candidate of candidates) {
      const model = this.deps.modelRepo.findVisibleById(candidate.id, req.ownerId);
      if (!model) continue;
      const providerConfig = this.deps.providerRepo.findById(model.providerId)?.data;
      if (!providerConfig || !providerConfig.active) continue;
      const startedAt = Date.now();
      // Commit the pick: this model is now in flight and its fair-share
      // advances, so the next request goes to a peer instead of hammering it.
      const lease = this.deps.loadBalancer?.begin(candidate.id, {
        scope: `owner:${req.ownerId ?? "platform"}`,
        affinityKey: req.balanceAffinityKey,
      });
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
        lease?.finish(true);
        return {
          content: response.content,
          modelId: model.id,
          providerId: providerConfig.id,
          costUsd: response.costUsd ?? 0,
          totalTokens: response.usage.totalTokens,
          latencyMs: latency,
        };
      } catch (err) {
        lease?.finish(false);
        lastError = err;
        logger.warn(`text-service: model ${candidate.id} failed, trying next`, { err: String(err), correlationId: req.correlationId });
      }
    }
    if (lastError) logger.error("text-service: all models failed", { err: String(lastError), correlationId: req.correlationId });
    return null;
  }
}
