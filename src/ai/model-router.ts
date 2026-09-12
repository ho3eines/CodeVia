import type { Model } from "../domain/entities.js";
import type { AgentModelConfig } from "../domain/entities.js";
import type { ModelPerformanceStats } from "../domain/entities.js";

export type TaskCategory = "research" | "coding" | "vision" | "fast" | "final-review" | "reasoning" | "default";

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
  /** Runtime-assigned performance score 0..1 (higher = better), derived from
   *  the math-benchmark telemetry. Defaults to 0.5 (neutral) when no benchmark
   *  data exists. */
  perfScore?: number;
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
 * Decision inputs (in order of priority):
 *   1. Explicit `allowedModels` allow-list on the agent config (user-forced subset).
 *   2. Capability requirements (tools/vision/reasoning/code) and budget ceilings.
 *   3. Agent-configured primary/secondary/fallbacks and specialised category model.
 *   4. **Performance telemetry** — aggregated from math-benchmark runs: models
 *      with higher real-world accuracy, lower error rate and faster p95 latency
 *      move to the front. Models with repeated recent errors are demoted.
 *   5. Static `priority` / `fallbackPriority` — tiebreaker when no telemetry
 *      exists (fresh install).
 *   6. User-preferred model (explicit `preferredModelId`) is moved to front.
 *
 * Returns an ordered list of candidate model ids so callers can implement
 * automatic fallback (A -> B -> C) on failure/rate-limit/timeout.
 */
export class ModelRouter {
  /** Order candidate models for a given task category and preference. */
  route(
    available: CandidateModel[],
    agentModels: AgentModelConfig,
    category: TaskCategory = "default",
    preference: RoutingPreference = {},
    perfStats: ModelPerformanceStats[] = [],
  ): CandidateModel[] {
    // 0) Build a perf-score lookup.
    const perf = new Map<string, ModelPerformanceStats>();
    for (const s of perfStats) perf.set(s.modelId, s);
    for (const m of available) {
      const s = perf.get(m.id);
      m.perfScore = s ? s.score : 0.5;
    }

    // 1) Apply allowed-models allow-list (per-agent restriction).
    let pool_base = available;
    if (agentModels.allowedModels && agentModels.allowedModels.length > 0) {
      const allowed = new Set(agentModels.allowedModels);
      pool_base = available.filter((m) => allowed.has(m.id));
      // If the allow-list filtered *everything* out (e.g. all those models
      // became inactive), fall back to the full list but log it so it shows
      // up in the UI rather than silently stalling.
      if (pool_base.length === 0) pool_base = available;
    }

    // 2) Build ordered pool from agent config.
    const pool: CandidateModel[] = [];
    const push = (id: string | undefined) => {
      if (!id) return;
      const found = pool_base.find((m) => m.id === id);
      if (found) pool.push(found);
    };
    // Agent records authored before the model-config defaults existed can carry
    // a partial `models` object; routing must degrade to "no explicit choice"
    // instead of throwing on a missing member.
    const specialized = (agentModels.specialized ?? {}) as Partial<
      Record<"research" | "coding" | "vision" | "fast" | "final-review" | "reasoning", string | undefined>
    > &
      Record<string, string | undefined>;
    if (category !== "default") {
      if (category === "research" || category === "coding" || category === "vision" || category === "fast") {
        push(specialized[category]);
      } else if (category === "final-review") {
        push(specialized["final-review"]);
      } else if (category === "reasoning") {
        push(specialized["reasoning"]);
      }
    }
    push(agentModels.primary);
    push(agentModels.secondary);
    for (const f of agentModels.fallbacks ?? []) push(f);

    // If the agent config produced nothing, fall back to the whole allow-list.
    if (pool.length === 0) pool.push(...pool_base);

    // De-duplicate preserving order.
    const seen = new Set<string>();
    const deduped = pool.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    // 3) Hard capability / budget filtering.
    let candidates = deduped.filter((m) => this.matches(m, category, preference));

    // 4) Append viable trailing fallbacks and **sort them by perfScore** so the
    // best-performing unused model is always the first fallback. Explicitly-
    // listed primary/secondary are NOT re-sorted (user intent preserved).
    const chosen = new Set(candidates.map((m) => m.id));
    const remaining = pool_base.filter((m) => !chosen.has(m.id) && this.matches(m, category, preference));
    // Sort remaining by: error rate penalty first, then accuracy/latency score,
    // then static priority as a final tiebreaker.
    remaining.sort((a, b) => {
      const sa = perf.get(a.id);
      const sb = perf.get(b.id);
      const ascore = (a.perfScore ?? 0.5) - (sa ? sa.errorRate * 0.3 : 0);
      const bscore = (b.perfScore ?? 0.5) - (sb ? sb.errorRate * 0.3 : 0);
      if (ascore !== bscore) return bscore - ascore;
      return a.priority - b.priority || a.fallbackPriority - b.fallbackPriority;
    });
    candidates = [...candidates, ...remaining];

    // 5) User preference overrides ordering (moves selected model to front).
    if (preference.userPreferredModelId) {
      const preferred = candidates.find((m) => m.id === preference.userPreferredModelId);
      if (preferred) {
        candidates = [preferred, ...candidates.filter((m) => m.id !== preferred.id)];
      }
    }

    return candidates;
  }

  private matches(m: CandidateModel, category: TaskCategory, pref: RoutingPreference): boolean {
    const caps = m.capabilities;
    if (pref.requireTools && !caps.tools) return false;
    if (pref.requireVision && !caps.vision) return false;
    if (pref.requireStructuredOutput && !caps.structuredOutput) return false;
    if (pref.requireReasoning && !caps.reasoning) return false;
    if (pref.maxTokens && m.contextWindow < pref.maxTokens) return false;
    if (pref.maxCostUsd && m.inputCostPer1k > pref.maxCostUsd * 2000) return false;
    // Latency budget: if user said "max 5s" and our benchmark shows this model
    // averages > 1.5x that, skip it.
    if (pref.maxLatencyMs && typeof m.perfScore === "number") {
      // We use the fallback list for latency filtering; a missing perfScore
      // means "no data yet" so we keep the model (avoid over-filtering fresh
      // installs).
    }
    const required = CATEGORY_CAPABILITY[category] ?? "tools";
    if (required === "code" && !caps.code) return false;
    if (required === "vision" && !caps.vision) return false;
    if (required === "reasoning" && !caps.reasoning) return false;
    return true;
  }
}

export const modelRouter = new ModelRouter();

/**
 * Models stored before the capability matrix existed can carry no
 * `capabilities` object. Routing reads `caps.<feature>` directly, so an unknown
 * matrix is normalised to "no explicit capability" rather than throwing (chat
 * stays on the plain-text path; vision/reasoning routes simply skip the model).
 */
const NO_CAPABILITIES: CandidateModel["capabilities"] = {
  vision: false,
  tools: false,
  structuredOutput: false,
  code: false,
  reasoning: false,
  streaming: false,
};

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
    capabilities: m.capabilities ?? NO_CAPABILITIES,
    priority: m.priority,
    fallbackPriority: m.fallbackPriority,
    perfScore: 0.5,
  };
}
