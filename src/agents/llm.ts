import type { ProviderRegistry } from "../ai/provider-registry.js";
import type { ModelRepository, ProviderRepository } from "../ai/model-repo.js";
import { logger } from "../logger.js";

/**
 * Real-AI access for the autonomous task loop.
 *
 * The deterministic agent plans (`defaultPlanFor`) stay the safety baseline:
 * they run with zero model cost and can never emit an unexecutable step. The
 * orchestrator uses this module to *upgrade* two decisions to real AI when a
 * non-mock provider is configured and active:
 *
 *   1. task breakdown (research output → implementer subtasks), and
 *   2. file content generation (implementer subtask → code written to git).
 *
 * When no real provider is available (or any call fails), every helper
 * returns `undefined` and the caller falls back to the deterministic path.
 * Nothing here ever throws for missing configuration.
 */

export interface RealChat {
  chat(system: string, user: string, maxTokens?: number): Promise<string>;
  providerName: string;
  modelLabel: string;
}

export interface ChatDeps {
  modelRepo: ModelRepository;
  providerRepo: ProviderRepository;
  providerRegistry: ProviderRegistry;
}

/** First active (model, provider) pair backed by a real (non-mock) provider. */
export function realChatFor(deps: ChatDeps): RealChat | undefined {
  try {
    for (const model of deps.modelRepo.listActive()) {
      const provider = deps.providerRepo.findById(model.providerId)?.data;
      if (!provider || !provider.active || provider.type === "mock") continue;
      const runtime = deps.providerRegistry.get(provider.id) ?? deps.providerRegistry.resolve(provider);
      if (!runtime) continue;
      return {
        providerName: provider.name,
        modelLabel: model.modelId,
        chat: async (system: string, user: string, maxTokens = 2000): Promise<string> => {
          const res = await runtime.chat({
            modelId: model.modelId,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: 0.2,
            maxTokens,
          });
          return res.content ?? "";
        },
      };
    }
  } catch (err) {
    logger.warn("real AI lookup failed, staying deterministic", { err: String(err) });
  }
  return undefined;
}

/**
 * Tolerant JSON extraction from model output: accepts raw JSON, fenced code
 * blocks, or prose with an embedded object/array. Returns undefined when
 * nothing parseable is found.
 */
export function extractJson(text: string): unknown {
  const src = String(text ?? "").trim();
  if (!src) return undefined;
  const candidates: string[] = [src];
  const fence = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.unshift(fence[1].trim());
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try embedded */
    }
    const startObj = c.indexOf("{");
    const startArr = c.indexOf("[");
    let start = -1;
    let end = -1;
    if (startObj !== -1 && (startArr === -1 || startObj < startArr)) {
      start = startObj;
      end = c.lastIndexOf("}");
    } else if (startArr !== -1) {
      start = startArr;
      end = c.lastIndexOf("]");
    }
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(c.slice(start, end + 1));
      } catch {
        /* not parseable */
      }
    }
  }
  return undefined;
}
