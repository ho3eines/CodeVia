import { describe, it, expect } from "vitest";
import { ModelRouter, toCandidate, type CandidateModel } from "../ai/model-router.js";
import type { AgentModelConfig, Model } from "../domain/entities.js";

function mkModel(partial: Partial<Model>): Model {
  const now = new Date().toISOString();
  return {
    id: partial.id!,
    providerId: partial.providerId ?? "p",
    modelId: partial.modelId ?? partial.id!,
    displayName: partial.displayName ?? partial.id!,
    contextWindow: partial.contextWindow ?? 128000,
    inputCostPer1k: partial.inputCostPer1k ?? 0,
    outputCostPer1k: partial.outputCostPer1k ?? 0,
    capabilities: partial.capabilities ?? {
      vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true,
    },
    active: true,
    priority: partial.priority ?? 100,
    fallbackPriority: partial.fallbackPriority ?? 100,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

const router = new ModelRouter();

describe("ModelRouter", () => {
  it("returns an ordered candidate list for a coding task respecting code capability", () => {
    const models: CandidateModel[] = [
      toCandidate(mkModel({ id: "m-weak", priority: 1, capabilities: { vision: false, tools: true, structuredOutput: false, code: false, reasoning: false, streaming: true } })),
      toCandidate(mkModel({ id: "m-strong", priority: 2, capabilities: { vision: true, tools: true, structuredOutput: true, code: true, reasoning: true, streaming: true } })),
      toCandidate(mkModel({ id: "m-fast", priority: 3, capabilities: { vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true } })),
    ];
    const config: AgentModelConfig = { primary: "m-strong", fallbacks: ["m-fast", "m-weak"], specialized: {} };
    const result = router.route(models, config, "coding");
    expect(result.map((m) => m.id)).toContain("m-strong");
    // The weak model lacks code capability and must be filtered out.
    expect(result.map((m) => m.id)).not.toContain("m-weak");
    // Primary sorted first.
    expect(result[0].id).toBe("m-strong");
  });

  it("falls back through secondary and fallbacks when primary is unavailable", () => {
    const models: CandidateModel[] = [
      toCandidate(mkModel({ id: "a", priority: 1 })),
      toCandidate(mkModel({ id: "b", priority: 2 })),
      toCandidate(mkModel({ id: "c", priority: 3 })),
    ];
    const config: AgentModelConfig = { primary: "missing", secondary: "b", fallbacks: ["c"], specialized: {} };
    const result = router.route(models, config, "default");
    expect(result.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  it("moves the user-preferred model to the front", () => {
    const models: CandidateModel[] = [
      toCandidate(mkModel({ id: "x", priority: 1, capabilities: { vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true } })),
      toCandidate(mkModel({ id: "y", priority: 2, capabilities: { vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true } })),
    ];
    const config: AgentModelConfig = { primary: "x", fallbacks: [], specialized: {} };
    const result = router.route(models, config, "default", { userPreferredModelId: "y" });
    expect(result[0].id).toBe("y");
  });

  it("filters models whose context window is too small for the budget", () => {
    const models: CandidateModel[] = [
      toCandidate(mkModel({ id: "small", contextWindow: 2000, priority: 1, capabilities: { vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true } })),
      toCandidate(mkModel({ id: "big", contextWindow: 100000, priority: 2, capabilities: { vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true } })),
    ];
    const config: AgentModelConfig = { primary: "small", fallbacks: ["big"], specialized: {} };
    const result = router.route(models, config, "default", { maxTokens: 10000 });
    expect(result.map((m) => m.id)).not.toContain("small");
    expect(result.map((m) => m.id)).toContain("big");
  });
});
