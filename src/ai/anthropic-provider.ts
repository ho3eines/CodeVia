import type { ChatRequest, ChatResponse, IModelProvider, ProviderModelInfo } from "./types.js";
import type { ModelProvider } from "../domain/entities.js";
import { logger } from "../logger.js";

/** Anthropic Messages API adapter. */
export class AnthropicProvider implements IModelProvider {
  readonly id: string;
  readonly type = "anthropic";
  readonly name: string;

  constructor(private readonly config: ModelProvider) {
    this.id = config.id;
    this.name = config.name;
  }

  resolveApiKey(): string | undefined {
    return this.config.secretRef ? process.env[this.config.secretRef] : undefined;
  }

  async health(): Promise<boolean> {
    return !!this.resolveApiKey();
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    return [
      {
        id: this.config.id + ":default",
        displayName: `${this.name} Default`,
        contextWindow: 200_000,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        capabilities: { vision: true, tools: true, structuredOutput: true, code: true, reasoning: true, streaming: true },
      },
    ];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const baseUrl = this.config.baseUrl ?? "https://api.anthropic.com/v1";
    const key = this.resolveApiKey();
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: req.modelId,
      max_tokens: req.maxTokens ?? this.config.maxTokensDefault,
      system,
      messages,
      temperature: req.temperature ?? this.config.defaultTemperature,
    };

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as any;
    const usage = {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      totalTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
    };
    const content = json.content?.find((b: any) => b.type === "text")?.text ?? "";
    logger.debug(`anthropic chat`, { modelId: req.modelId, ...usage });
    return {
      content,
      json: tryParse(content),
      finishReason: json.stop_reason ?? "stop",
      usage,
      modelId: req.modelId,
      providerId: this.id,
      costUsd: 0,
      raw: json,
    };
  }
}

function tryParse(content: string): unknown {
  const t = content.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}
