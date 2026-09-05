import type {
  ChatRequest,
  ChatResponse,
  IModelProvider,
  ProviderModelInfo,
  Usage,
} from "./types.js";
import type { ModelProvider } from "../domain/entities.js";
import { buildChatEndpoint } from "./provider-urls.js";
import { logger } from "../logger.js";

/**
 * OpenAI-compatible HTTP provider. Covers OpenAI, OpenRouter, Azure OpenAI,
 * Ollama, and any custom OpenAI-compatible endpoint — differing only in baseUrl
 * and auth header. Anthropic/Gemini use their own adapters.
 */
export class OpenAICompatibleProvider implements IModelProvider {
  readonly id: string;
  readonly type: string;
  readonly name: string;

  constructor(private readonly config: ModelProvider) {
    this.id = config.id;
    this.type = config.type;
    this.name = config.name;
  }

  resolveApiKey(): string | undefined {
    return this.config.secretRef ? process.env[this.config.secretRef] : undefined;
  }

  async health(): Promise<boolean> {
    const key = this.resolveApiKey();
    return !!key || this.config.authType === "none";
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    // For custom-compatible endpoints we surface a small default catalog that the
    // registry can enrich. Real catalog data lives in the Model Registry (GitHub).
    return [
      {
        id: this.config.id + ":default",
        displayName: `${this.name} Default`,
        contextWindow: 128_000,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        capabilities: {
          vision: true,
          tools: true,
          structuredOutput: true,
          code: true,
          reasoning: true,
          streaming: true,
        },
      },
    ];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const key = this.resolveApiKey();
    const body: Record<string, unknown> = {
      model: req.modelId,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      ...(req.omitTemperature ? {} : { temperature: req.temperature ?? this.config.defaultTemperature }),
      max_tokens: req.maxTokens ?? this.config.maxTokensDefault,
      stream: false,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const url = buildChatEndpoint(this.config);
    const started = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.authType === "bearer" && key ? { Authorization: `Bearer ${key}` } : {}),
        ...(this.config.authType === "api-key" && key ? { "api-key": key } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Provider ${this.name} HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as any;
    const usage: Usage = {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: (json.usage?.prompt_tokens ?? 0) + (json.usage?.completion_tokens ?? 0),
    };
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? "";
    const durationMs = Date.now() - started;
    logger.debug(`provider chat ${this.name}`, { modelId: req.modelId, durationMs, ...usage });
    return {
      content,
      json: tryParseJson(content),
      finishReason: choice?.finish_reason ?? "stop",
      usage,
      modelId: req.modelId,
      providerId: this.id,
      costUsd: estimateCost(req.modelId, usage, this.config),
      raw: json,
    };
  }
}

function tryParseJson(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function estimateCost(modelId: string, usage: Usage, config: ModelProvider): number {
  // Default cost table for known models; otherwise 0. The Model Registry in
  // GitHub carries authoritative pricing; this is a runtime fallback.
  const known: Record<string, [number, number]> = {
    "gpt-4o": [2.5, 10],
    "gpt-4o-mini": [0.15, 0.6],
    "gpt-4.1": [2, 8],
    "claude-3-5-sonnet": [3, 15],
    "claude-3-haiku": [0.25, 1.25],
    "gemini-1.5-pro": [1.25, 5],
    "gemini-2.0-flash": [0.1, 0.4],
  };
  const [inK, outK] = known[modelId] ?? [0, 0];
  return (usage.inputTokens / 1000) * inK + (usage.outputTokens / 1000) * outK;
}
