import type { ChatRequest, ChatResponse, IModelProvider, ProviderModelInfo } from "./types.js";
import type { ModelProvider } from "../domain/entities.js";
import { logger } from "../logger.js";

/** Google Gemini (generateContent) adapter. */
export class GeminiProvider implements IModelProvider {
  readonly id: string;
  readonly type = "gemini";
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
        contextWindow: 2_000_000,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        capabilities: { vision: true, tools: true, structuredOutput: true, code: true, reasoning: true, streaming: true },
      },
    ];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const key = this.resolveApiKey();
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const user = req.messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${req.modelId}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: req.temperature ?? this.config.defaultTemperature },
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as any;
    const usage = {
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: (json.usageMetadata?.promptTokenCount ?? 0) + (json.usageMetadata?.candidatesTokenCount ?? 0),
    };
    const content = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
    logger.debug(`gemini chat`, { modelId: req.modelId, ...usage });
    return {
      content,
      json: tryParse(content),
      finishReason: "stop",
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
