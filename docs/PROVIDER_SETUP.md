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
   The stored config keeps only `secretRef`, never your key (a literal key in
   `secretRef` is rejected with `400`). `GET /providers/presets` returns the
   per-type defaults the **Add Provider** form pre-fills, so usually only a
   name is needed.

   **Endpoint conventions (per docs).** The base URL you type is *documented*
   per provider, and the platform builds the request path accordingly:

   - **OpenAI / OpenRouter / custom-compatible** — the base URL carries `/v1`
     (`https://api.openai.com/v1`) and the platform requests `{base}/models` and
     `{base}/chat/completions`.
   - **Anthropic (Claude)** — the base URL does **not** carry `/v1`
     (`https://api.anthropic.com`); the platform appends `/v1` for you
     (`/v1/models`, `/v1/messages`). Either form works if you type it, but the
     default omits `/v1`.
   - **Gemini** — `{base}/v1beta/models`.
   - **Ollama** — `{base}/api/tags`.

   **Approving a provider.** A provider is only usable when it is *active*.
   New providers auto-activate when they are immediately usable (key present
   or `authType: none` such as Ollama); otherwise they are saved **inactive**
   with a `readiness.reason`/`hint` (e.g. `OPENAI_API_KEY is not set on the
   server`). On the Providers page use:

   - **Test connection (before saving)** → `POST /providers/test` — run from the
     **Add Provider** form. It never persists anything; it verifies the *draft*
     config and returns the exact requested URL plus the discovered models. If it
     cannot be tested (e.g. missing key) it says so directly and still shows the
     endpoint it would hit.
   - **✓ Activate** → `POST /providers/:id/activate` — refuses with `422` while
     the key is missing (`?force=true` overrides),
   - **Deactivate** → `POST /providers/:id/deactivate` — the runner then skips
     the provider even if its models are still active,
   - **Test connection** → `POST /providers/:id/test` — checks the key and calls
     the provider's model catalog (`/v1/models`, Anthropic `/v1/models`, Gemini
     `/v1beta/models`, Ollama `/api/tags`) with a short timeout; returns
     `{ok, status, latencyMs, message, hint, url, models, modelInfos}` where
     `modelInfos` includes each model's **auto-detected** capabilities,
   - **Edit** → `PATCH /providers/:id` (the cached adapter is refreshed),
   - **Delete** → `DELETE /providers/:id?cascade=true` (removes its models too;
     the built-in mock provider cannot be deleted).

3. Register Models in the **Model Registry** (`Settings → Models` or `POST /models`). Capabilities are **auto-detected** from the model id (vision / tools / reasoning / structured output / code / streaming) — you do not tick them manually. Use **Test** on the Models page (`POST /models/:id/test`) or the **Add Model** form (`POST /models/test`) to verify a model, see the exact endpoint, and confirm whether it is in the provider's catalog.
   ```json
   { "providerId": "provider-openai", "modelId": "gpt-4o", "displayName": "GPT-4o" }
   ```
   `modelId`, cost, and context window are stored; `capabilities` fall back to the detected values when omitted.

4. Assign models to agents (primary / secondary / fallbacks / specialized) — the **Model Router** picks the best per task and auto-falls back on failure.

---

## Mock AI

The `MockProvider` is registered by default. It returns deterministic, zero-cost responses so the whole platform runs offline (development, tests, Simulation Mode). It is the safety net when no real provider key is configured.

---

## Adding a new provider

Implement the `IModelProvider` interface in `src/ai/`, register the adapter in `ProviderRegistry.instantiate()`, and add the entity type to `ModelProvider.type`. Because agents never see the vendor SDK, this is an isolated, low-risk change.
