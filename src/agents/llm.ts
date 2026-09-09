import type { ProviderRegistry } from "../ai/provider-registry.js";
import type { ModelRepository, ProviderRepository } from "../ai/model-repo.js";
import { ModelRouter, toCandidate, type TaskCategory } from "../ai/model-router.js";
import type { Agent, Project, Task } from "../domain/entities.js";
import type { CostRepository } from "../observability/repos.js";
import { getModelBenchmarkRepo, ModelBenchmarkRepository } from "../observability/model-bench-repo.js";
import { BudgetExceededError, TaskCancelledError, type ExecutionBudget } from "./execution.js";
import { logger } from "../logger.js";
import { projectBrief } from "../domain/project-brief.js";

export interface RealChat {
  chat(system: string, user: string, maxTokens?: number): Promise<string>;
  /** Refresh only the task context when a single-agent plan refines its skills. */
  setContext(context: string): void;
  providerName: string;
  modelLabel: string;
}

export interface ChatDeps {
  modelRepo: ModelRepository;
  providerRepo: ProviderRepository;
  providerRegistry: ProviderRegistry;
  modelRouter: ModelRouter;
  costRepo: CostRepository;
  project: Project;
  agent: Agent;
  task: Task;
  /** ContextEngine output: task, configured prompts, skills, rules and memory. */
  context: string;
  category: TaskCategory;
  budget: ExecutionBudget;
  taskBudget?: ExecutionBudget;
  signal?: AbortSignal;
  checkActive: () => void;
  /** Analysis/demo runs may use Mock; code generation never silently falls back to it. */
  allowMock?: boolean;
}

/**
 * A routed, attributed model session for ONE agent. Code generation uses the
 * very same prompt/model/limits as that agent's run, rather than the first
 * globally-active provider. A configured real provider failing is an error,
 * not permission to commit a placeholder implementation.
 */
export function realChatFor(deps: ChatDeps): RealChat | undefined {
  const models = deps.modelRepo.listActive().filter((m) => {
    const p = deps.providerRepo.findById(m.providerId)?.data;
    return p?.active && (deps.allowMock || p.type !== "mock");
  });

  const hasReal = models.some((m) => deps.providerRepo.findById(m.providerId)?.data.type !== "mock");
  // An explicit mock-only installation remains offline. With real models
  // enabled, a failed real call must not be hidden by a trailing mock result.
  let available = models.filter((m) => !hasReal || deps.providerRepo.findById(m.providerId)?.data.type !== "mock");
  const assigned = new Set([deps.agent.models.primary, deps.agent.models.secondary, deps.agent.models.specialized[deps.category as keyof Agent["models"]["specialized"]], ...deps.agent.models.fallbacks].filter(Boolean));
  // Once real models are explicitly assigned, do not send project code to
  // unrelated global providers just because the chosen model is unavailable.
  const explicitModels = [...assigned].map((id) => deps.modelRepo.findById(id!)?.data);
  const explicitReal = explicitModels.some((m) => m && deps.providerRepo.findById(m.providerId)?.data.type !== "mock");
  const missingAssignment = explicitModels.some((m) => !m);
  if (explicitReal || missingAssignment) {
    available = available.filter((m) => assigned.has(m.id) && deps.providerRepo.findById(m.providerId)?.data.type !== "mock");
    if (!available.length) throw new Error(`Assigned models for ${deps.agent.name} are missing or disabled; refusing unrelated providers or simulation`);
  }
  if (!available.length) return undefined;
  const benchRepo: ModelBenchmarkRepository = getModelBenchmarkRepo();
  const perfStats = benchRepo.computeStats();
  ModelBenchmarkRepository.addSpeedNormalisation(perfStats);
  const initial = deps.modelRouter.route(available.map(toCandidate), deps.agent.models, deps.category, {}, perfStats);
  if (!initial.length) throw new Error(`No active ${deps.category} model is available for ${deps.agent.name}`);
  const session: RealChat = {
    setContext: (context) => { deps.context = context; },
    providerName: deps.providerRepo.findById(initial[0].providerId)!.data.name,
    modelLabel: initial[0].modelId,
    chat: async (instruction, user, maxTokens = 4000) => {
      const messages = [
        { role: "system" as const, content: [
          deps.agent.systemPrompt,
          instruction,
          `Current project settings (authoritative over stale generated prompt defaults):\n${projectBrief(deps.project)}`,
          deps.project.settings.rules.length ? `Project rules:\n${deps.project.settings.rules.join("\n\n")}` : "",
          `Allowed tools: ${deps.agent.tools.join(", ")}. Skills are knowledge only; they never grant new tools or bypass approvals.`,
          "Return only the requested deliverable, never private reasoning.",
        ].filter(Boolean).join("\n\n") },
        { role: "user" as const, content: `${deps.context}\n\n--- Current operation ---\n${user}` },
      ];
      const inputEstimate = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
      const candidates = deps.modelRouter.route(available.map(toCandidate), deps.agent.models, deps.category, { maxTokens: inputEstimate + 1 }, perfStats);
      let lastError: unknown;
      for (const candidate of candidates) {
        deps.checkActive();
        deps.budget.check();
        deps.taskBudget?.check();
        const model = deps.modelRepo.findById(candidate.id)?.data;
        const config = model && deps.providerRepo.findById(model.providerId)?.data;
        if (!model?.active || !config?.active) continue;
        const remaining = Math.min(deps.budget.remainingTokens(), deps.taskBudget?.remainingTokens() ?? Infinity);
        if (inputEstimate >= remaining) throw new BudgetExceededError(`request context needs about ${inputEstimate} tokens; ${remaining} remain`);
        const outputLimit = Math.floor(Math.min(maxTokens, model.maxTokens ?? maxTokens, remaining - inputEstimate, model.contextWindow - inputEstimate));
        if (outputLimit < 1) continue;
        deps.taskBudget?.beginCall();
        deps.budget.beginCall();
        const started = Date.now();
        try {
          const response = await deps.providerRegistry.resolve(config).chat({
            modelId: model.modelId,
            signal: deps.signal,
            messages,
            temperature: model.temperature ?? 0.2,
            omitTemperature: model.omitTemperature === true,
            maxTokens: outputLimit,
          });
          const registeredPrice = (response.usage.inputTokens * model.inputCostPer1k + response.usage.outputTokens * model.outputCostPer1k) / 1000;
          const costUsd = registeredPrice > 0 ? registeredPrice : response.costUsd ?? 0;
          deps.costRepo.create({
            providerId: config.id, modelId: model.id, projectId: deps.project.id,
            agentId: deps.agent.id, taskId: deps.task.id, ...response.usage,
            estimatedCostUsd: costUsd, durationMs: Date.now() - started,
          });
          const usage = { ...response.usage, costUsd, modelId: model.id };
          // Record both ledgers even when one limit is exceeded.
          let budgetError: unknown;
          try { deps.budget.add(usage); } catch (err) { budgetError = err; }
          try { deps.taskBudget?.add(usage); } catch (err) { budgetError ??= err; }
          if (budgetError) throw budgetError;
          deps.checkActive();
          if (["length", "max_tokens", "MAX_TOKENS"].includes(response.finishReason)) {
            throw new Error(`Model ${model.displayName} truncated its response; refusing an incomplete deliverable`);
          }
          if (!response.content?.trim()) throw new Error(`Model ${model.displayName} returned no content`);
          session.providerName = config.name;
          session.modelLabel = model.modelId;
          return response.content;
        } catch (err) {
          deps.signal?.throwIfAborted();
          if (err instanceof BudgetExceededError || err instanceof TaskCancelledError) throw err;
          lastError = err;
          logger.warn("agent model failed; trying configured fallback", { modelId: model.id, taskId: deps.task.id, err: String(err) });
        }
      }
      throw new Error(`All ${deps.category} models failed for ${deps.agent.name}: ${String(lastError ?? "no model fits the context window")}`);
    },
  };
  return session;
}

/** JSON extraction for structured model deliverables (raw, fenced, or embedded). */
export function extractJson(text: string): unknown {
  const src = String(text ?? "").trim();
  if (!src) return undefined;
  const candidates: string[] = [src];
  const fence = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.unshift(fence[1].trim());
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try embedded */ }
    const object = c.indexOf("{");
    const array = c.indexOf("[");
    const start = object !== -1 && (array === -1 || object < array) ? object : array;
    const end = start === object ? c.lastIndexOf("}") : c.lastIndexOf("]");
    if (start !== -1 && end > start) {
      try { return JSON.parse(c.slice(start, end + 1)); } catch { /* no valid JSON */ }
    }
  }
  return undefined;
}
