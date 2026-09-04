import type { ModelCapabilities, ModelProvider } from "../domain/entities.js";

/**
 * Centralized, provider-type-aware URL construction.
 *
 * Different vendors expect the version segment in different places, and users
 * often type the base URL in (or out) of `/v1` depending on the provider's docs.
 * Rather than a naive `${baseUrl}/models` that silently 404s, every endpoint is
 * built from the *documented* path for that API format:
 *
 *  - OpenAI & friends  → `{base}/v1/models`   (base should carry `/v1`)
 *  - Anthropic         → `{base}/v1/models`   (base may omit `/v1`)
 *  - Gemini            → `{base}/v1beta/models`
 *  - Ollama            → `{base}/api/tags`
 */
export function stripTrailingSlash(s: string): string {
  return (s ?? "").trim().replace(/\/+$/, "");
}

/** Ensure the base URL ends with a specific version segment (e.g. `/v1`). */
export function ensureVersionPath(base: string, versionPath: string): string {
  const b = stripTrailingSlash(base);
  if (!b) return b;
  return b.endsWith(versionPath) ? b : b + versionPath;
}

/** Remove a trailing version segment (used when the API wants a different path). */
export function stripVersionPath(base: string, versionPath = "/v1"): string {
  const b = stripTrailingSlash(base);
  return b.endsWith(versionPath) ? b.slice(0, -versionPath.length) : b;
}

/** Build the model-catalog endpoint (+ headers) for a provider configuration. */
export function buildModelsEndpoint(
  config: ModelProvider,
  apiKey?: string,
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { accept: "application/json" };
  switch (config.apiFormat) {
    case "anthropic": {
      const base = ensureVersionPath(config.baseUrl ?? "", "/v1");
      if (apiKey) headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      return { url: `${base}/models?limit=50`, headers };
    }
    case "gemini": {
      const base = ensureVersionPath(config.baseUrl ?? "", "/v1beta");
      return { url: `${base}/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`, headers };
    }
    case "ollama": {
      const base = stripVersionPath(config.baseUrl ?? "", "/v1");
      return { url: `${base}/api/tags`, headers };
    }
    case "openai":
    case "custom":
    default: {
      const base = ensureVersionPath(config.baseUrl ?? "", "/v1");
      if (apiKey) headers.authorization = config.authType === "api-key" ? apiKey : `Bearer ${apiKey}`;
      if (apiKey && config.authType === "api-key") headers["api-key"] = apiKey;
      return { url: `${base}/models`, headers };
    }
  }
}

/** Build the chat-completions URL for an OpenAI-compatible provider. */
export function buildChatEndpoint(config: ModelProvider): string {
  const base = ensureVersionPath(config.baseUrl ?? "https://api.openai.com/v1", "/v1");
  return `${base}/chat/completions`;
}

/** Build the Anthropic Messages URL. */
export function buildAnthropicChatEndpoint(config: ModelProvider): string {
  const base = ensureVersionPath(config.baseUrl ?? "https://api.anthropic.com/v1", "/v1");
  return `${base}/messages`;
}

/** Build the Gemini generateContent URL for a specific model. */
export function buildGeminiChatEndpoint(config: ModelProvider, modelId: string, apiKey?: string): string {
  const base = ensureVersionPath(config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta", "/v1beta");
  const model = modelId.replace(/^models\//, "");
  return `${base}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`;
}

/* ------------------------------------------------------------------ *
 * Capability / metadata inference for a model id.
 * Most model-catalog endpoints return little more than an id, so we infer
 * the ModelCapabilities ("what can a model do") from well-known name
 * conventions. This is what lets the platform stop asking the user to
 * tick capability boxes manually.
 * ------------------------------------------------------------------ */
const has = (id: string, ...keys: string[]) => keys.some((k) => id.includes(k));

export function detectModelCapabilities(modelId: string): ModelCapabilities {
  const id = String(modelId || "").toLowerCase();

  // Vision — image/vision capable families.
  const vision = has(
    id,
    "vision",
    "4o",
    "gpt-4.1",
    "gpt-4",
    "gpt4",
    "llava",
    "pixtral",
    "phi-3-vision",
    "phi-4",
    "gemini",
    "claude",
    "qwen-vl",
    "qwen2-vl",
    "minicpm-v",
    "idefics",
    "image",
  );

  // Reasoning / extended thinking.
  const reasoning = has(
    id,
    "reasoning",
    "reasoner",
    "o1",
    "o3",
    "o4",
    "r1",
    "think",
    "deepseek-reasoner",
    "claude",
    "opus",
    "sonnet",
    "qwen3",
    "kimi-k2",
    "grok",
  );

  // Structured output / tool calling (JSON mode, function calling).
  const structuredOutput = has(
    id,
    "4o",
    "gpt-4.1",
    "gpt-4",
    "claude",
    "gemini",
    "o1",
    "o3",
    "json",
    "structured",
    "function",
    "tool",
    "llama-3",
    "qwen",
    "mistral",
    "command-r",
  );

  return {
    vision,
    tools: true,
    structuredOutput,
    code: true,
    reasoning,
    streaming: true,
  };
}

export function estimateContextWindow(modelId: string): number {
  const id = String(modelId || "").toLowerCase();
  if (has(id, "gemini")) return 1_000_000;
  if (has(id, "claude")) return 200_000;
  if (has(id, "gpt-4.1", "gpt-4.5", "gpt-4o")) return 128_000;
  if (has(id, "o1", "o3", "o4", "r1", "reasoning", "deepseek")) return 200_000;
  if (has(id, "llama-3.1", "llama-3.3")) return 128_000;
  return 128_000;
}

export function displayNameFromModelId(modelId: string): string {
  const id = String(modelId || "").replace(/^models\//, "").trim();
  if (!id) return id;
  const pretty = id
    .replace(/[-_/]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return pretty.length <= 40 ? pretty : id;
}

export interface DetectedModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  capabilities: ModelCapabilities;
}

/** Build a full model descriptor (id + inferred metadata) for a vendor model id. */
export function detectModelInfo(modelId: string): DetectedModelInfo {
  const id = String(modelId || "").replace(/^models\//, "").trim();
  return {
    id,
    displayName: displayNameFromModelId(id),
    contextWindow: estimateContextWindow(id),
    capabilities: detectModelCapabilities(id),
  };
}
