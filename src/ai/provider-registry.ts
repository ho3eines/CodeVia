import type { ModelProvider } from "../domain/entities.js";
import type { IModelProvider, ChatResponse, ChatRequest } from "./types.js";
import { MockProvider } from "./mock-provider.js";
import { OpenAICompatibleProvider } from "./http-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { getEnv } from "../config/env.js";
import { logger } from "../logger.js";

/**
 * Resolves a stored ModelProvider configuration into a live IModelProvider adapter.
 * This is the seam that keeps agents decoupled from vendor SDKs and lets new
 * provider types be added with a single entry point.
 */
export class ProviderRegistry {
  private providers = new Map<string, IModelProvider>();

  register(provider: IModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): IModelProvider | undefined {
    return this.providers.get(id);
  }

  /** Resolve an IModelProvider from a ModelProvider entity, instantiating the right adapter. */
  resolve(config: ModelProvider): IModelProvider {
    if (!this.providers.has(config.id)) {
      this.providers.set(config.id, this.instantiate(config));
    }
    return this.providers.get(config.id)!;
  }

  private instantiate(config: ModelProvider): IModelProvider {
    if (config.type === "mock") return new MockProvider(config.id);
    switch (config.type) {
      case "anthropic":
        return new AnthropicProvider(config);
      case "gemini":
        return new GeminiProvider(config);
      case "openai":
      case "openrouter":
      case "azure-openai":
      case "ollama":
      case "openai-compatible":
      case "custom-http":
      default:
        return new OpenAICompatibleProvider(config);
    }
  }

  all(): IModelProvider[] {
    return [...this.providers.values()];
  }

  async chat(req: ChatRequest, config: ModelProvider): Promise<ChatResponse> {
    const provider = this.resolve(config);
    return provider.chat(req);
  }

  /** Seed the registry with default providers (mock unless real keys exist). */
  async bootDefault(): Promise<void> {
    const env = getEnv();
    // Always make the mock provider available so the platform runs anywhere.
    this.register(new MockProvider("provider-mock"));

    const defaults: ModelProvider[] = [
      {
        id: "provider-openai",
        name: "OpenAI",
        type: "openai",
        baseUrl: "https://api.openai.com/v1",
        secretRef: "OPENAI_API_KEY",
        authType: "bearer",
        apiFormat: "openai",
        timeoutMs: 60000,
        maxTokensDefault: 4096,
        defaultTemperature: 0.3,
        rateLimitPerMinute: 200,
        active: !!env.OPENAI_API_KEY,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "provider-anthropic",
        name: "Anthropic",
        type: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        secretRef: "ANTHROPIC_API_KEY",
        authType: "api-key",
        apiFormat: "anthropic",
        timeoutMs: 60000,
        maxTokensDefault: 4096,
        defaultTemperature: 0.3,
        rateLimitPerMinute: 200,
        active: !!env.ANTHROPIC_API_KEY,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "provider-gemini",
        name: "Google Gemini",
        type: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        secretRef: "GEMINI_API_KEY",
        authType: "api-key",
        apiFormat: "gemini",
        timeoutMs: 60000,
        maxTokensDefault: 4096,
        defaultTemperature: 0.3,
        rateLimitPerMinute: 200,
        active: !!env.GEMINI_API_KEY,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "provider-mock",
        name: "Mock AI",
        type: "mock",
        authType: "none",
        apiFormat: "custom",
        timeoutMs: 60000,
        maxTokensDefault: 4096,
        defaultTemperature: 0.3,
        rateLimitPerMinute: 1000,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    for (const p of defaults) {
      this.register(this.instantiate(p));
    }
    logger.info("ProviderRegistry booted", { providers: this.all().map((p) => p.id) });
  }
}

export const providerRegistry = new ProviderRegistry();
