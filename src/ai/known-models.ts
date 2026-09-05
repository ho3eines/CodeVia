import type { ModelProvider } from "../domain/entities.js";
import { detectModelInfo, type DetectedModelInfo } from "./provider-urls.js";

/**
 * Built-in catalog of well-known model ids, keyed by provider `type`.
 *
 * The platform's primary source of truth for a provider's models is the live
 * model-catalog call (`GET /v1/models` …). But that call needs a working key
 * AND outbound network access — neither of which is guaranteed the moment a
 * user adds or edits a provider (self-hosted boxes, air-gapped networks, keys
 * entered later, etc.). When the live catalog is unavailable we fall back to
 * this curated list so the Models section is still populated with the
 * provider's known models instead of staying empty.
 *
 * These are *suggestions*: live catalog results always win when present, and
 * every id is still de-duplicated against what is already in the Models
 * section for that provider. Provider types with user-defined model names
 * (azure-openai deployments, openai-compatible, custom-http) intentionally have
 * no entries — there is no sensible static list to fall back to.
 */
export const KNOWN_MODELS_BY_TYPE: Partial<Record<ModelProvider["type"], string[]>> = {
  openai: [
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "gpt-4",
    "gpt-3.5-turbo",
    "o1",
    "o1-mini",
    "o3-mini",
    "o4-mini",
    "gpt-4.5-preview",
  ],
  anthropic: [
    "claude-3-7-sonnet-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
    "claude-3-opus-latest",
    "claude-3-haiku-20240307",
    "claude-3-sonnet-20240229",
    "claude-3-opus-20240229",
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
  ],
  gemini: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.0-pro-exp",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
  openrouter: [
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "anthropic/claude-3.5-sonnet",
    "google/gemini-2.0-flash-001",
    "meta-llama/llama-3.1-8b-instruct",
    "meta-llama/llama-3.3-70b-instruct",
    "deepseek/deepseek-r1",
    "mistralai/mixtral-8x7b-instruct",
    "qwen/qwen2.5-72b-instruct",
  ],
  ollama: [
    "llama3.2",
    "llama3.1",
    "llama3",
    "mistral",
    "qwen2.5",
    "phi3",
    "gemma2",
    "deepseek-r1",
    "codellama",
  ],
};

/** Well-known model ids for a provider type, with auto-detected metadata. */
export function knownModelInfos(type: ModelProvider["type"]): DetectedModelInfo[] {
  const ids = KNOWN_MODELS_BY_TYPE[type];
  if (!ids || ids.length === 0) return [];
  return ids.map((id) => detectModelInfo(id));
}
