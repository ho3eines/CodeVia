import type { ModelProvider } from "../domain/entities.js";
import type { ChatMessage } from "./types.js";
import {
  buildChatEndpoint,
  buildAnthropicChatEndpoint,
  buildGeminiChatEndpoint,
  buildOllamaChatEndpoint,
  ensureVersionPath,
  maskUrlSecrets,
} from "./provider-urls.js";
import { resolveProviderKey, providerReadiness } from "./provider-test.js";
import { MockProvider } from "./mock-provider.js";

/** One event emitted while streaming a model answer. */
export type StreamEvent =
  | { type: "meta"; url: string; modelId: string; transport: "http" | "mock" }
  | { type: "delta"; text: string }
  | { type: "done"; text: string; latencyMs: number; status?: number }
  | { type: "error"; message: string; hint?: string; status?: number };

export interface StreamChatOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Drop `temperature` from the payload entirely (routes that reject it). */
  omitTemperature?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Gemini's SSE streaming endpoint for a model. */
function buildGeminiStreamEndpoint(config: ModelProvider, modelId: string, apiKey?: string): string {
  const base = ensureVersionPath(config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta", "/v1beta");
  const model = modelId.replace(/^models\//, "");
  const key = apiKey ? `&key=${encodeURIComponent(apiKey)}` : "";
  return `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse${key}`;
}

/** Build the streaming chat request (URL + headers + body) for an API format. */
export function buildStreamRequest(
  config: ModelProvider,
  modelId: string,
  opts: StreamChatOptions,
  apiKey?: string,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const temperature = opts.temperature ?? config.defaultTemperature ?? 0.3;
  const maxTokens = opts.maxTokens ?? config.maxTokensDefault ?? 1024;
  // Some model routes reject `temperature` outright — the field is then omitted.
  const temp = opts.omitTemperature ? {} : { temperature };
  const messages = opts.messages;
  switch (config.apiFormat) {
    case "anthropic": {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        accept: "text/event-stream",
      };
      if (apiKey) headers["x-api-key"] = apiKey;
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      return {
        url: buildAnthropicChatEndpoint(config),
        headers,
        body: {
          model: modelId,
          stream: true,
          max_tokens: maxTokens,
          ...temp,
          ...(system ? { system } : {}),
          messages: messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content })),
        },
      };
    }
    case "gemini": {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      return {
        url: buildGeminiStreamEndpoint(config, modelId, apiKey),
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: {
          contents: messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: { ...temp, maxOutputTokens: maxTokens },
        },
      };
    }
    case "ollama": {
      return {
        url: buildOllamaChatEndpoint(config),
        headers: { "content-type": "application/json" },
        body: {
          model: modelId,
          stream: true,
          ...(opts.omitTemperature ? {} : { options: { temperature } }),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        },
      };
    }
    case "openai":
    case "custom":
    default: {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
      if (apiKey) {
        if (config.authType === "api-key") headers["api-key"] = apiKey;
        else headers.authorization = `Bearer ${apiKey}`;
      }
      return {
        url: buildChatEndpoint(config),
        headers,
        body: {
          model: modelId,
          stream: true,
          ...temp,
          max_tokens: maxTokens,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        },
      };
    }
  }
}

/** Pull the incremental text out of one decoded stream chunk (per API format). */
export function extractStreamDelta(apiFormat: ModelProvider["apiFormat"], payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  switch (apiFormat) {
    case "anthropic": {
      if (obj.type === "content_block_delta") {
        const delta = obj.delta as Record<string, unknown> | undefined;
        return String(delta?.text ?? "");
      }
      return "";
    }
    case "gemini": {
      const candidates = Array.isArray(obj.candidates) ? (obj.candidates as Array<Record<string, unknown>>) : [];
      const parts = (candidates[0]?.content as Record<string, unknown> | undefined)?.parts;
      if (!Array.isArray(parts)) return "";
      return parts.map((p) => String((p as Record<string, unknown>)?.text ?? "")).join("");
    }
    case "ollama": {
      const message = obj.message as Record<string, unknown> | undefined;
      return String(message?.content ?? "");
    }
    case "openai":
    case "custom":
    default: {
      const choices = Array.isArray(obj.choices) ? (obj.choices as Array<Record<string, unknown>>) : [];
      const delta = (choices[0]?.delta ?? choices[0]?.message) as Record<string, unknown> | undefined;
      const content = delta?.content;
      if (typeof content === "string") return content;
      // Some gateways send content as an array of parts.
      if (Array.isArray(content)) {
        return content.map((c) => String((c as Record<string, unknown>)?.text ?? "")).join("");
      }
      return "";
    }
  }
}

/** Split a raw stream body chunk into JSON payload strings (SSE frames or NDJSON lines). */
function* parseFrames(buffer: string, sse: boolean): Generator<string> {
  for (const rawLine of buffer.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (sse) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      yield data;
    } else {
      yield line;
    }
  }
}

/**
 * Stream one chat completion from a provider + model, yielding incremental
 * `delta` events (ChatGPT-style typing) and a final `done` event.
 * Never throws — transport problems are yielded as an `error` event.
 */
export async function* streamModelChat(
  config: ModelProvider,
  modelId: string,
  opts: StreamChatOptions,
): AsyncGenerator<StreamEvent> {
  const apiKey = resolveProviderKey(config);

  // Mock provider: simulate a token-by-token stream locally, no network.
  if (config.type === "mock") {
    const started = Date.now();
    yield { type: "meta", url: "mock://local (no external request)", modelId, transport: "mock" };
    const mock = new MockProvider(config.id);
    const res = await mock.chat({
      modelId,
      messages: opts.messages,
      temperature: opts.temperature ?? 0,
      maxTokens: opts.maxTokens ?? 512,
    });
    const words = res.content.split(/(\s+)/);
    let acc = "";
    for (const w of words) {
      if (opts.signal?.aborted) break;
      acc += w;
      yield { type: "delta", text: w };
      await new Promise((r) => setTimeout(r, 15));
    }
    yield { type: "done", text: acc, latencyMs: Date.now() - started };
    return;
  }

  const readiness = providerReadiness(config);
  const { url, headers, body } = buildStreamRequest(config, modelId, opts, apiKey);
  const displayUrl = maskUrlSecrets(url);
  yield { type: "meta", url: displayUrl, modelId, transport: "http" };
  if (!readiness.ready) {
    yield {
      type: "error",
      message: `${readiness.reason ?? "Provider not ready"}. No request was sent — the message would be POSTed to ${displayUrl}`,
      hint: readiness.hint,
    };
    return;
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.max(5_000, opts.timeoutMs ?? config.timeoutMs ?? 60_000);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const text = await res.text();
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
          detail = parsed.error?.message ?? parsed.message ?? text.slice(0, 400);
        } catch {
          detail = text.slice(0, 400) || detail;
        }
      } catch {
        /* ignore */
      }
      yield {
        type: "error",
        status: res.status,
        message: `POST ${displayUrl} → ${res.status}: ${detail}`,
        hint:
          res.status === 401 || res.status === 403
            ? `The API key was rejected — check that it is valid and has access to "${modelId}".`
            : res.status === 404
              ? `Endpoint or model not found — check the Base URL, API format, and that "${modelId}" exists.`
              : undefined,
      };
      return;
    }
    const sse = config.apiFormat !== "ollama";
    let full = "";
    const bodyStream = res.body as ReadableStream<Uint8Array> | null;
    if (!bodyStream) {
      // Provider ignored `stream: true` — fall back to the full body at once.
      const text = await res.text();
      for (const frame of parseFrames(text, sse)) {
        try {
          full += extractStreamDelta(config.apiFormat, JSON.parse(frame));
        } catch {
          /* skip malformed frame */
        }
      }
      if (full) yield { type: "delta", text: full };
      yield { type: "done", text: full, latencyMs: Date.now() - started, status: res.status };
      return;
    }
    const reader = bodyStream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      // Keep the last (possibly partial) line in the buffer.
      const lastBreak = pending.lastIndexOf("\n");
      if (lastBreak === -1) continue;
      const ready = pending.slice(0, lastBreak);
      pending = pending.slice(lastBreak + 1);
      for (const frame of parseFrames(ready, sse)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame);
        } catch {
          continue;
        }
        const delta = extractStreamDelta(config.apiFormat, parsed);
        if (delta) {
          full += delta;
          yield { type: "delta", text: delta };
        }
      }
    }
    for (const frame of parseFrames(pending, sse)) {
      try {
        const delta = extractStreamDelta(config.apiFormat, JSON.parse(frame));
        if (delta) {
          full += delta;
          yield { type: "delta", text: delta };
        }
      } catch {
        /* ignore trailing garbage */
      }
    }
    yield { type: "done", text: full, latencyMs: Date.now() - started, status: res.status };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    yield {
      type: "error",
      message: aborted
        ? `POST ${displayUrl} → timed out or cancelled after ${Date.now() - started}ms`
        : `POST ${displayUrl} → network error: ${err instanceof Error ? err.message : String(err)}`,
      hint: aborted ? undefined : "The server could not reach the provider — check the Base URL or outbound network access.",
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
