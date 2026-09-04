import type { ModelProvider } from "../domain/entities.js";
import { decryptSecret } from "../auth/encrypted-secrets.js";
import {
  buildModelsEndpoint,
  buildChatEndpoint,
  buildAnthropicChatEndpoint,
  buildGeminiChatEndpoint,
  buildOllamaChatEndpoint,
  buildChatUrlForModel,
  maskUrlSecrets,
} from "./provider-urls.js";
import type { DetectedModelInfo } from "./provider-urls.js";
import { detectModelInfo } from "./provider-urls.js";
import { MockProvider } from "./mock-provider.js";

export interface ProviderTestResult {
  ok: boolean;
  /** Whether the secret referenced by `secretRef` is present in the server environment. */
  keyPresent: boolean;
  /** Whether a live network check was attempted. */
  checked: boolean;
  status?: number;
  latencyMs?: number;
  message: string;
  hint?: string;
  /** HTTP method of the live request (always present when `url` is). */
  method?: "GET" | "POST";
  /** Exact URL the provider's model catalog was requested from (so the user can verify it). */
  url?: string;
  /** Every URL the test touched (catalog + chat). Surfaced to the UI so the user can see what is being hit. */
  urls?: string[];
  /** Catalog endpoint — used by Add-Model to populate a dropdown. */
  catalogUrl?: string;
  /** Chat / completion endpoint — the URL a real call will be made to. */
  chatUrl?: string;
  /** Provider type that produced these URLs (so the UI can label them). */
  apiFormat?: ModelProvider["apiFormat"];
  /** True when the chat endpoint was also called. */
  chatChecked?: boolean;
  /** Model ids discovered from the provider (best effort, capped). */
  models?: string[];
  /** Discovered models with inferred capabilities (id + metadata). */
  modelInfos?: DetectedModelInfo[];
}

/** Result of sending one real chat message to a provider + model. */
export interface ModelChatTestResult {
  ok: boolean;
  keyPresent: boolean;
  /** Whether a live request was attempted (false for mock / not-ready configs). */
  checked: boolean;
  /** How the message travelled — real HTTP or the built-in mock. */
  transport: "http" | "mock";
  method: "POST";
  /** Exact chat URL the message was (or would be) POSTed to — secrets masked. */
  url: string;
  status?: number;
  latencyMs?: number;
  message: string;
  hint?: string;
  modelId: string;
  /** The text the model actually replied with. */
  responseText?: string;
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/** Short, cheap prompt used when the user does not type their own test message. */
export const DEFAULT_MODEL_TEST_MESSAGE = "This is a connectivity test from CodeVia. Reply with exactly: OK";

/**
 * Build the *full* set of URLs the platform will hit for a provider — the
 * catalog (for /v1/models, /v1beta/models, /api/tags) and the chat endpoint
 * for the vendor's documented format. Surfaced everywhere we test a provider
 * (saved, draft, pre-registration) so the user can verify what is hit.
 */
export function buildAllEndpoints(
  config: ModelProvider,
  apiKey?: string,
): { catalogUrl: string; chatUrl: string; urls: string[] } {
  const cat = buildModelsEndpoint(config, apiKey);
  const chat = buildChatUrlForModel(config, "detect", apiKey);
  return {
    catalogUrl: cat.url,
    chatUrl: chat,
    urls: Array.from(new Set([cat.url, chat])),
  };
}

/** Mask any embedded secrets (Gemini's `?key=...`) for safe display/logging. */
function maskEndpoints(eps: { catalogUrl: string; chatUrl: string; urls: string[] }): {
  catalogUrl: string;
  chatUrl: string;
  urls: string[];
} {
  return {
    catalogUrl: maskUrlSecrets(eps.catalogUrl),
    chatUrl: maskUrlSecrets(eps.chatUrl),
    urls: eps.urls.map(maskUrlSecrets),
  };
}

/**
 * Resolve the API key for a provider config. A stored secret value (typed into
 * the UI and encrypted at rest) wins over the environment variable reference so
 * providers can be configured without a deploy-time env var.
 */
export function resolveProviderKey(config: ModelProvider): string | undefined {
  const stored = decryptSecret(config.secretValueEnc, "provider-secret");
  if (stored) return stored;
  return config.secretRef ? process.env[config.secretRef] : undefined;
}

/** True when a non-network readable secret material exists for a provider. */
export function providerHasSecret(config: ModelProvider): boolean {
  if (config.authType === "none" || config.type === "mock") return true;
  return !!config.secretValueEnc || (!!config.secretRef && !!process.env[config.secretRef]);
}

export function providerNeedsKey(config: ModelProvider): boolean {
  return config.type !== "mock" && config.authType !== "none";
}

/** Non-network validation: does this provider have what it needs to be usable? */
export function providerReadiness(config: ModelProvider): { ready: boolean; reason?: string; hint?: string } {
  if (config.type === "mock") return { ready: true };
  if (providerNeedsKey(config)) {
    if (!config.secretRef && !config.secretValueEnc) {
      return {
        ready: false,
        reason: "No API key configured",
        hint: "Set 'Secret Ref' to the name of an environment variable holding the API key (e.g. OPENAI_API_KEY), or paste the key in the 'API key' field (stored encrypted).",
      };
    }
    if (!resolveProviderKey(config)) {
      return {
        ready: false,
        reason: config.secretRef ? `Environment variable ${config.secretRef} is not set on the server` : "Stored API key can no longer be decrypted",
        hint: config.secretRef
          ? `Add ${config.secretRef}=<your key> to the server environment (.env / docker-compose) and restart, or paste the key directly in the provider form.`
          : "AUTH_SECRET may have changed — re-enter the API key in the provider form.",
      };
    }
  }
  if (!config.baseUrl) {
    return { ready: false, reason: "Base URL is required", hint: "Enter the provider's API base URL (e.g. https://api.openai.com/v1)." };
  }
  return { ready: true };
}

function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const list = (Array.isArray(obj.data) && obj.data) || (Array.isArray(obj.models) && obj.models) || [];
  return (list as Array<Record<string, unknown>>)
    .map((m) => String(m.id ?? m.name ?? m.model ?? ""))
    .filter(Boolean)
    .map((id) => id.replace(/^models\//, ""))
    .slice(0, 100);
}

/** Build a best-effort `ProviderTestResult` for a request that could not be attempted. */
export function providerTestNotReady(
  config: ModelProvider,
  url: string | undefined,
): ProviderTestResult {
  const keyPresent = !!resolveProviderKey(config);
  const readiness = providerReadiness(config);
  const eps = maskEndpoints(buildAllEndpoints(config, keyPresent ? resolveProviderKey(config) : undefined));
  return {
    ok: false,
    keyPresent,
    checked: false,
    method: "GET",
    url: url ? maskUrlSecrets(url) : url,
    urls: eps.urls,
    catalogUrl: eps.catalogUrl,
    chatUrl: eps.chatUrl,
    apiFormat: config.apiFormat,
    // Always state WHERE the request would go — the user must never be left
    // guessing which endpoint the platform is targeting.
    message: `${readiness.reason ?? "Provider not ready"}. No request was sent — it would go to GET ${eps.catalogUrl}`,
    hint: readiness.hint,
  };
}

/**
 * Live connectivity test for a provider: verifies the key is present, then calls
 * the provider's cheapest read-only endpoint (model catalog) with a short timeout.
 * Never throws; always returns a structured result the UI can display, including
 * the exact URL that was requested and the models (with inferred capabilities)
 * that were discovered.
 */
export async function testProviderConnection(
  config: ModelProvider,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProviderTestResult> {
  const keyPresent = !!resolveProviderKey(config);
  const apiKey = resolveProviderKey(config);
  if (config.type === "mock") {
    // The mock provider never touches the network — do NOT fabricate URLs for
    // it (showing e.g. an OpenAI endpoint here would be plain wrong).
    return {
      ok: true,
      keyPresent: false,
      checked: false,
      apiFormat: config.apiFormat,
      message: "Mock provider is always available — no external request is sent (offline mode).",
    };
  }
  const readiness = providerReadiness(config);
  // Raw endpoints carry the key (Gemini puts it in the query string) and are
  // used for the actual request; everything surfaced to the user is masked.
  const raw = buildAllEndpoints(config, apiKey);
  const eps = maskEndpoints(raw);
  if (!readiness.ready) {
    return providerTestNotReady(config, raw.catalogUrl);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.min(opts.timeoutMs ?? 10_000, config.timeoutMs || 10_000);
  const { headers } = buildModelsEndpoint(config, apiKey);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(raw.catalogUrl, { method: "GET", headers, signal: ctrl.signal });
    const latencyMs = Date.now() - started;
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (res.ok) {
      const modelIds = extractModelIds(body);
      const modelInfos = modelIds.map((id) => detectModelInfo(id));
      return {
        ok: true,
        keyPresent,
        checked: true,
        status: res.status,
        latencyMs,
        method: "GET",
        url: eps.catalogUrl,
        urls: eps.urls,
        catalogUrl: eps.catalogUrl,
        chatUrl: eps.chatUrl,
        apiFormat: config.apiFormat,
        message: `GET ${eps.catalogUrl} → ${res.status} in ${latencyMs}ms — ${modelIds.length} model(s) visible`,
        models: modelIds,
        modelInfos,
      };
    }
    const apiMessage =
      (body && typeof body === "object" && ((body as { error?: { message?: string } }).error?.message ?? (body as { message?: string }).message)) || res.statusText;
    const hint =
      res.status === 401 || res.status === 403
        ? `The key in ${config.secretRef} was rejected by the provider — check that it is valid and has API access.`
        : res.status === 404
          ? "Endpoint not found — check the Base URL and API format."
          : undefined;
    return {
      ok: false,
      keyPresent,
      checked: true,
      status: res.status,
      latencyMs,
      method: "GET",
      url: eps.catalogUrl,
      urls: eps.urls,
      catalogUrl: eps.catalogUrl,
      chatUrl: eps.chatUrl,
      apiFormat: config.apiFormat,
      message: `GET ${eps.catalogUrl} → ${res.status}: ${apiMessage}`,
      hint,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      keyPresent,
      checked: true,
      latencyMs: Date.now() - started,
      method: "GET",
      url: eps.catalogUrl,
      urls: eps.urls,
      catalogUrl: eps.catalogUrl,
      chatUrl: eps.chatUrl,
      apiFormat: config.apiFormat,
      message: `GET ${eps.catalogUrl} → ${aborted ? `timed out after ${timeoutMs}ms` : `network error: ${err instanceof Error ? err.message : String(err)}`}`,
      hint: "The server could not reach the provider — check the Base URL, outbound network access, or proxy settings.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Live model chat test — sends ONE real message to a provider + model
 * and reports the exact chat URL plus the text the model replied with.
 * This is the difference vs. testProviderConnection (which only reads
 * the model catalog): here we verify the model actually answers.
 * ------------------------------------------------------------------ */

/** Build the request parts for a single chat message, per API format. */
function buildChatRequest(
  config: ModelProvider,
  modelId: string,
  message: string,
  apiKey?: string,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  switch (config.apiFormat) {
    case "anthropic": {
      const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
      if (apiKey) headers["x-api-key"] = apiKey;
      return {
        url: buildAnthropicChatEndpoint(config),
        headers,
        body: { model: modelId, max_tokens: 64, temperature: 0, messages: [{ role: "user", content: message }] },
      };
    }
    case "gemini": {
      return {
        url: buildGeminiChatEndpoint(config, modelId, apiKey),
        headers: { "content-type": "application/json" },
        body: {
          contents: [{ role: "user", parts: [{ text: message }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 64 },
        },
      };
    }
    case "ollama": {
      return {
        url: buildOllamaChatEndpoint(config),
        headers: { "content-type": "application/json" },
        body: { model: modelId, stream: false, messages: [{ role: "user", content: message }] },
      };
    }
    case "openai":
    case "custom":
    default: {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey) {
        if (config.authType === "api-key") headers["api-key"] = apiKey;
        else headers.authorization = `Bearer ${apiKey}`;
      }
      return {
        url: buildChatEndpoint(config),
        headers,
        body: {
          model: modelId,
          temperature: 0,
          max_tokens: 64,
          stream: false,
          messages: [{ role: "user", content: message }],
        },
      };
    }
  }
}

/** Extract the reply text from a chat response body, per API format. */
function extractChatReply(apiFormat: ModelProvider["apiFormat"], payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  try {
    switch (apiFormat) {
      case "anthropic": {
        const content = Array.isArray(obj.content) ? (obj.content as Array<Record<string, unknown>>) : [];
        return content
          .filter((b) => b?.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("")
          .trim();
      }
      case "gemini": {
        const candidates = Array.isArray(obj.candidates) ? (obj.candidates as Array<Record<string, unknown>>) : [];
        const parts = (candidates[0]?.content as Record<string, unknown> | undefined)?.parts;
        if (!Array.isArray(parts)) return "";
        return parts
          .map((p) => String((p as Record<string, unknown>)?.text ?? ""))
          .join("")
          .trim();
      }
      case "ollama": {
        const message = obj.message as Record<string, unknown> | undefined;
        return String(message?.content ?? "").trim();
      }
      case "openai":
      case "custom":
      default: {
        const choices = Array.isArray(obj.choices) ? (obj.choices as Array<Record<string, unknown>>) : [];
        const message = choices[0]?.message as Record<string, unknown> | undefined;
        return String(message?.content ?? "").trim();
      }
    }
  } catch {
    return "";
  }
}

/**
 * Send a single real chat message to `modelId` on `config` and report what came
 * back. Always returns a structured result (never throws) that surfaces:
 *   - the EXACT chat URL the message was POSTed to (secrets masked),
 *   - the HTTP status + latency,
 *   - the text the model replied with.
 * For `mock` providers the reply is generated locally (no network).
 */
export async function testModelChat(
  config: ModelProvider,
  modelId: string,
  opts: { message?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ModelChatTestResult> {
  const message = (opts.message ?? DEFAULT_MODEL_TEST_MESSAGE).trim() || DEFAULT_MODEL_TEST_MESSAGE;
  const apiKey = resolveProviderKey(config);
  const keyPresent = !!apiKey;
  const chatUrl = maskUrlSecrets(buildChatUrlForModel(config, modelId, apiKey));

  // Mock provider: answer locally, never hit the network.
  if (config.type === "mock") {
    const mock = new MockProvider(config.id);
    const started = Date.now();
    const res = await mock.chat({
      modelId,
      messages: [{ role: "user", content: message }],
      temperature: 0,
      maxTokens: 64,
    });
    const latencyMs = Date.now() - started;
    return {
      ok: true,
      keyPresent: false,
      checked: false,
      transport: "mock",
      method: "POST",
      url: "mock://local (no external request)",
      latencyMs,
      modelId,
      responseText: res.content,
      finishReason: res.finishReason,
      usage: res.usage,
      message: `Mock model answered locally in ${latencyMs}ms (no external request)`,
    };
  }

  const readiness = providerReadiness(config);
  if (!readiness.ready) {
    return {
      ok: false,
      keyPresent,
      checked: false,
      transport: "http",
      method: "POST",
      url: chatUrl,
      modelId,
      message: `${readiness.reason ?? "Provider not ready"}. No request was sent — the message would be POSTed to ${chatUrl}`,
      hint: readiness.hint,
    };
  }

  const { url, headers, body } = buildChatRequest(config, modelId, message, apiKey);
  const displayUrl = maskUrlSecrets(url);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.min(opts.timeoutMs ?? 15_000, config.timeoutMs || 15_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const latencyMs = Date.now() - started;
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }
    if (res.ok) {
      const reply = extractChatReply(config.apiFormat, payload);
      return {
        ok: true,
        keyPresent,
        checked: true,
        transport: "http",
        method: "POST",
        url: displayUrl,
        status: res.status,
        latencyMs,
        modelId,
        responseText: reply,
        message: reply
          ? `POST ${displayUrl} → ${res.status} in ${latencyMs}ms — model replied (${reply.length} chars)`
          : `POST ${displayUrl} → ${res.status} in ${latencyMs}ms — connected but the model returned an empty reply`,
      };
    }
    const apiMessage =
      (payload && typeof payload === "object" && (((payload as { error?: { message?: string } }).error?.message) ?? (payload as { message?: string }).message)) ||
      res.statusText;
    const hint =
      res.status === 401 || res.status === 403
        ? `The API key was rejected by the provider — check that it is valid and has access to "${modelId}".`
        : res.status === 404
          ? `Endpoint or model not found — check the Base URL, API format, and that "${modelId}" exists for this provider.`
          : undefined;
    return {
      ok: false,
      keyPresent,
      checked: true,
      transport: "http",
      method: "POST",
      url: displayUrl,
      status: res.status,
      latencyMs,
      modelId,
      message: `POST ${displayUrl} → ${res.status}: ${apiMessage}`,
      hint,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      keyPresent,
      checked: true,
      transport: "http",
      method: "POST",
      url: displayUrl,
      latencyMs: Date.now() - started,
      modelId,
      message: `POST ${displayUrl} → ${aborted ? `timed out after ${timeoutMs}ms` : `network error: ${err instanceof Error ? err.message : String(err)}`}`,
      hint: "The server could not reach the provider — check the Base URL, outbound network access, or proxy settings.",
    };
  } finally {
    clearTimeout(timer);
  }
}
