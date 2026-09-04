import type { Model } from "../domain/entities.js";
import type { AgentModelConfig } from "../domain/entities.js";

export type TaskCategory =
  | "research"
  | "coding"
  | "vision"
  | "fast"
  | "final-review"
  | "reasoning"
  | "default";

/** Preferences that bias routing (from budget, user preference, context size). */
export interface RoutingPreference {
  maxCostUsd?: number;
  maxTokens?: number;
  maxLatencyMs?: number;
  requireTools?: boolean;
  requireVision?: boolean;
  requireStructuredOutput?: boolean;
  requireReasoning?: boolean;
  userPreferredModelId?: string;
}

export interface CandidateModel {
  id: string;
  modelId: string;
  displayName: string;
  providerId: string;
  contextWindow: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
  capabilities: {
    vision: boolean;
    tools: boolean;
    structuredOutput: boolean;
    code: boolean;
    reasoning: boolean;
    streaming: boolean;
  };
  priority: number;
  fallbackPriority: number;
}

const CATEGORY_CAPABILITY: Record<TaskCategory, keyof Model["capabilities"]> = {
  research: "reasoning",
  coding: "code",
  vision: "vision",
  fast: "tools",
  "final-review": "reasoning",
  reasoning: "reasoning",
  default: "tools",
};

/**
 * Central Intelligent Model Router.
 *
 * Decision inputs: agent, task category, token/cost/latency budget, model
 * capability, context size, user preference, and prior failures. Returns an
 * ordered list of candidate model ids so callers can implement automatic
 * fallback (A -> B -> C) on failure/rate-limit/timeout.
 */
export class ModelRouter {
  /** Order candidate models for a given task category and preference. */
  route(
    available: CandidateModel[],
    agentModels: AgentModelConfig,
    category: TaskCategory = "default",
    preference: RoutingPreference = {},
  ): CandidateModel[] {
    // Build a pool of candidate Model refs from the agent config first, then filter.
    const pool: CandidateModel[] = [];
    const push = (id: string | undefined) => {
      if (!id) return;
      const found = available.find((m) => m.id === id);
      if (found) pool.push(found);
    };
    if (category !== "default") {
      const indexed = agentModels.specialized as Partial<
        Record<"research" | "coding" | "vision" | "fast" | "final-review" | "reasoning", string | undefined>
      > & Record<string, string | undefined>;
      if (category === "research" || category === "coding" || category === "vision" || category === "fast") {
        push(indexed[category]);
      } else if (category === "final-review") {
        push(indexed["final-review"]);
      } else if (category === "reasoning") {
        push(indexed["reasoning"]);
      }
    }
    push(agentModels.primary);
    push(agentModels.secondary);
    for (const f of agentModels.fallbacks) push(f);
    // If the agent config produced nothing, fall back to any available model.
    if (pool.length === 0) pool.push(...available);

    // De-duplicate while preserving order.
    const seen = new Set<string>();
    const deduped = pool.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    let candidates = deduped.filter((m) => this.matches(m, category, preference));

    // Resiliency: append any remaining viable models (not already chosen) as
    // trailing fallbacks so a run never stalls for lack of a candidate (A->B->C…).
    const chosen = new Set(candidates.map((m) => m.id));
    const remaining = available
      .filter((m) => !chosen.has(m.id) && this.matches(m, category, preference))
      .sort((a, b) => a.priority - b.priority || a.fallbackPriority - b.fallbackPriority);
    candidates = [...candidates, ...remaining];

    // Apply user preference to move the preferred model to the front.
    if (preference.userPreferredModelId) {
      const preferred = candidates.find((m) => m.id === preference.userPreferredModelId);
      if (preferred) {
        candidates = [preferred, ...candidates.filter((m) => m.id !== preferred.id)];
      }
    }

    // Order preserves the agent's configured pool first, then remaining viable
    // models by priority (A -> B -> C fallback path). No global re-sort, so an
    // explicitly-configured `primary`/`secondary` is never bumped by an unrelated
    // high-priority model that the agent did not opt into.
    return candidates;
  }

  private matches(m: CandidateModel, category: TaskCategory, pref: RoutingPreference): boolean {
    const caps = m.capabilities;
    // Hard capability requirements.
    if (pref.requireTools && !caps.tools) return false;
    if (pref.requireVision && !caps.vision) return false;
    if (pref.requireStructuredOutput && !caps.structuredOutput) return false;
    if (pref.requireReasoning && !caps.reasoning) return false;
    // Context size feasibility.
    if (pref.maxTokens && m.contextWindow < pref.maxTokens) return false;
    // Cost feasibility (per-call upper bound not strictly required by default).
    if (pref.maxCostUsd && m.inputCostPer1k > pref.maxCostUsd * 1000) {
      // Only reject if the model is clearly above the per-run budget ceiling.
      if (m.inputCostPer1k > pref.maxCostUsd * 2000) return false;
    }
    const required = CATEGORY_CAPABILITY[category] ?? "tools";
    if (required === "code" && !caps.code) return false;
    if (required === "vision" && !caps.vision) return false;
    if (required === "reasoning" && !caps.reasoning) return false;
    return true;
  }
}

export const modelRouter = new ModelRouter();

/** Adapt a stored Model to a CandidateModel for routing. */
export function toCandidate(m: Model): CandidateModel {
  return {
    id: m.id,
    modelId: m.modelId,
    displayName: m.displayName,
    providerId: m.providerId,
    contextWindow: m.contextWindow,
    inputCostPer1k: m.inputCostPer1k,
    outputCostPer1k: m.outputCostPer1k,
    capabilities: m.capabilities,
    priority: m.priority,
    fallbackPriority: m.fallbackPriority,
  };
}
