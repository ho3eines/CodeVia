# Provider Setup Guide

The platform is **provider-agnostic**. Agents depend on the `IModelProvider` interface; vendors are adapters. This means adding a provider does not require touching agent logic.

---

## Supported providers

| Provider | Type id | Adapter |
|----------|---------|---------|
| OpenAI | `openai` | OpenAI-compatible REST |
| Anthropic | `anthropic` | Anthropic Messages API |
| Google Gemini | `gemini` | Gemini `generateContent` |
| OpenRouter | `openrouter` | OpenAI-compatible REST |
| Azure OpenAI | `azure-openai` | OpenAI-compatible REST (Azure auth) |
| Ollama | `ollama` | OpenAI-compatible REST (local) |
| Custom OpenAI-compatible | `openai-compatible` | OpenAI-compatible REST |
| Custom HTTP | `custom-http` | OpenAI-compatible REST |
| Mock AI | `mock` | Offline, zero-cost (dev/test) |

---

## How to configure

1. Set the provider's API key as an environment variable (e.g. `OPENAI_API_KEY`). This is the **secret reference**.
2. Add a Provider in the UI (`Settings → Providers`) or via `POST /providers`:
   ```json
   {
     "name": "OpenAI",
     "type": "openai",
     "baseUrl": "https://api.openai.com/v1",
     "secretRef": "OPENAI_API_KEY",
     "authType": "bearer",
     "apiFormat": "openai",
     "timeoutMs": 60000,
     "maxTokensDefault": 4096,
     "defaultTemperature": 0.3,
     "rateLimitPerMinute": 200,
     "active": true
   }
   ```
   The stored config keeps only `secretRef`, never your key.

3. Register Models in the **Model Registry** (`Settings → Models` or `POST /models`) with `providerId`, `modelId`, cost, context window, and **capabilities** (vision/tools/structured output/code/reasoning/streaming).

4. Assign models to agents (primary / secondary / fallbacks / specialized) — the **Model Router** picks the best per task and auto-falls back on failure.

---

## Mock AI

The `MockProvider` is registered by default. It returns deterministic, zero-cost responses so the whole platform runs offline (development, tests, Simulation Mode). It is the safety net when no real provider key is configured.

---

## Adding a new provider

Implement the `IModelProvider` interface in `src/ai/`, register the adapter in `ProviderRegistry.instantiate()`, and add the entity type to `ModelProvider.type`. Because agents never see the vendor SDK, this is an isolated, low-risk change.
