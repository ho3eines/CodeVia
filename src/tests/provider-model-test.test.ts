import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import {
  detectModelCapabilities,
  detectModelInfo,
  buildModelsEndpoint,
  buildChatEndpoint,
  buildAnthropicChatEndpoint,
  buildGeminiChatEndpoint,
  buildOllamaChatEndpoint,
  maskUrlSecrets,
} from "../ai/provider-urls.js";
import type { ModelProvider } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;
const ENV_KEYS = ["REQUIRE_AUTH", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"] as const;
let savedEnv: Record<string, string | undefined>;

async function boot(): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
  return app;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (app) {
    await app.close();
    app = undefined;
  }
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  cleanup?.();
});

/* ---------------- fetch stubbing helpers ---------------- */
interface CapturedRequest {
  url: string;
  method?: string;
  headers: Headers;
  body?: Record<string, unknown>;
}

/** Stub the global fetch; every call is captured and routed to `handler`. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  const fake = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> | undefined;
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    } catch {
      body = undefined;
    }
    captured.push({ url, method: init?.method, headers: new Headers(init?.headers), body });
    return handler(url, init);
  }) as typeof fetch;
  vi.stubGlobal("fetch", fake);
  return captured;
}

/** A fetch stub that fails loudly if anything tries to hit the network. */
function stubNoNetwork(): CapturedRequest[] {
  return stubFetch(() => {
    throw new Error("network must not be called in this test");
  });
}

const openAiChatReply = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200 });
const anthropicChatReply = (text: string) =>
  new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 } }), { status: 200 });
const geminiChatReply = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } }), { status: 200 });
const ollamaChatReply = (text: string) =>
  new Response(JSON.stringify({ message: { role: "assistant", content: text }, done: true }), { status: 200 });

describe("provider URL construction (no /v1 on Claude, /v1 on OpenAI)", () => {
  it("builds the OpenAI model catalog under /v1", () => {
    const p: ModelProvider = {
      id: "p", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1",
      secretRef: "OPENAI_API_KEY", authType: "bearer", apiFormat: "openai",
      timeoutMs: 5000, maxTokensDefault: 1024, defaultTemperature: 0.2, rateLimitPerMinute: 60,
      active: true, createdAt: "", updatedAt: "",
    };
    expect(buildModelsEndpoint(p).url).toBe("https://api.openai.com/v1/models");
    expect(buildChatEndpoint(p)).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("builds the Anthropic model catalog under /v1 even when the base URL omits /v1", () => {
    const p: ModelProvider = {
      id: "p", name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com",
      secretRef: "ANTHROPIC_API_KEY", authType: "api-key", apiFormat: "anthropic",
      timeoutMs: 5000, maxTokensDefault: 1024, defaultTemperature: 0.2, rateLimitPerMinute: 60,
      active: true, createdAt: "", updatedAt: "",
    };
    expect(buildModelsEndpoint(p).url).toBe("https://api.anthropic.com/v1/models?limit=50");
    expect(buildAnthropicChatEndpoint(p)).toBe("https://api.anthropic.com/v1/messages");
  });

  it("keeps Gemini under /v1beta and Ollama under /api/tags", () => {
    const gem: ModelProvider = {
      id: "g", name: "Gemini", type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      secretRef: "GEMINI_API_KEY", authType: "api-key", apiFormat: "gemini",
      timeoutMs: 5000, maxTokensDefault: 1024, defaultTemperature: 0.2, rateLimitPerMinute: 60,
      active: true, createdAt: "", updatedAt: "",
    };
    expect(buildModelsEndpoint(gem).url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(buildGeminiChatEndpoint(gem, "gemini-2.5-pro", "k")).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=k");

    const oll: ModelProvider = {
      id: "o", name: "Ollama", type: "ollama", baseUrl: "http://localhost:11434/v1",
      secretRef: undefined, authType: "none", apiFormat: "ollama",
      timeoutMs: 5000, maxTokensDefault: 1024, defaultTemperature: 0.2, rateLimitPerMinute: 60,
      active: true, createdAt: "", updatedAt: "",
    };
    expect(buildModelsEndpoint(oll).url).toBe("http://localhost:11434/api/tags");
    expect(buildOllamaChatEndpoint(oll)).toBe("http://localhost:11434/api/chat");
  });

  it("masks secrets embedded in URLs", () => {
    expect(maskUrlSecrets("https://x/models/g:generateContent?key=SECRET123")).toBe("https://x/models/g:generateContent?key=***");
    expect(maskUrlSecrets("https://x/chat?api_key=abc&x=1")).toBe("https://x/chat?api_key=***&x=1");
    expect(maskUrlSecrets("https://x/chat?x=1")).toBe("https://x/chat?x=1");
  });
});

describe("capability detection", () => {
  it("detects vision/structured/tools for gpt-4o", () => {
    const c = detectModelCapabilities("gpt-4o");
    expect(c.vision).toBe(true);
    expect(c.tools).toBe(true);
    expect(c.structuredOutput).toBe(true);
    expect(c.code).toBe(true);
    expect(c.streaming).toBe(true);
  });

  it("detects reasoning for o1/o3/claude", () => {
    expect(detectModelCapabilities("o1-preview").reasoning).toBe(true);
    expect(detectModelCapabilities("o3-mini").reasoning).toBe(true);
    expect(detectModelCapabilities("claude-sonnet-4-5").reasoning).toBe(true);
  });

  it("builds a full model info (display name + context window)", () => {
    const info = detectModelInfo("gemini-2.5-pro");
    expect(info.id).toBe("gemini-2.5-pro");
    expect(info.contextWindow).toBe(1_000_000);
    expect(info.capabilities.vision).toBe(true);
  });
});

describe("pre-registration provider test (never saves, always shows the destination)", () => {
  it("reports the exact endpoint in the message and says it cannot be tested when the key is missing", async () => {
    const srv = await boot();
    stubNoNetwork();
    const r = await srv.inject({
      method: "POST",
      url: "/providers/test",
      payload: { type: "openai-compatible", baseUrl: "https://llm.example/v1", authType: "bearer" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(false);
    expect(body.checked).toBe(false);
    expect(body.url).toBe("https://llm.example/v1/models");
    // The openai-compatible preset carries secretRef LLM_API_KEY, which is unset.
    expect(body.message).toMatch(/LLM_API_KEY/);
    // The message itself must say where the request WOULD go.
    expect(body.message).toContain("https://llm.example/v1/models");
    // Nothing was persisted.
    expect((await srv.inject({ method: "GET", url: "/providers" })).json()).toHaveLength(4);
  });

  it("explains a missing environment-variable secretRef and never saves", async () => {
    const srv = await boot();
    stubNoNetwork();
    const r = await srv.inject({
      method: "POST",
      url: "/providers/test",
      payload: { type: "openai", baseUrl: "https://api.openai.com/v1", secretRef: "NONEXISTENT_KEY", authType: "bearer" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(false);
    expect(body.url).toBe("https://api.openai.com/v1/models");
    expect(body.message).toMatch(/NONEXISTENT_KEY/);
    expect(body.message).toContain("https://api.openai.com/v1/models");
    expect((await srv.inject({ method: "GET", url: "/providers" })).json()).toHaveLength(4);
  });

  it("shows the destination of the live request when the key exists", async () => {
    const srv = await boot();
    const captured = stubFetch(() => new Response(JSON.stringify({ data: [{ id: "m-1" }] }), { status: 200 }));
    const r = await srv.inject({
      method: "POST",
      url: "/providers/test",
      payload: { type: "openai", baseUrl: "https://api.openai.com/v1", secretValue: "sk-test-123456", authType: "bearer" },
    });
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.checked).toBe(true);
    expect(captured[0]?.url).toBe("https://api.openai.com/v1/models");
    // Method + URL are part of the human-readable message.
    expect(body.message).toContain("GET https://api.openai.com/v1/models");
    expect(body.message).toMatch(/200/);
  });

  it("does not fabricate endpoints for the mock provider", async () => {
    const srv = await boot();
    const r = await srv.inject({ method: "POST", url: "/providers/provider-mock/test" });
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.checked).toBe(false);
    expect(body.message).toMatch(/Mock provider/);
    expect(body.message).toMatch(/no external request/i);
    // The mock provider talks to no one — no vendor URLs may be shown.
    expect(body.url).toBeUndefined();
    expect(body.catalogUrl).toBeUndefined();
    expect(body.chatUrl).toBeUndefined();
    expect(body.urls ?? []).toEqual([]);
  });
});

describe("model chat test — send a message, see the reply", () => {
  it("POSTs the message to the OpenAI chat endpoint and returns the model's reply", async () => {
    process.env.OPENAI_API_KEY = "sk-test-123456";
    const srv = await boot();
    const captured = stubFetch(() => openAiChatReply("OK"));
    const m = await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-openai", modelId: "gpt-4o-mini" } });
    const model = m.json();
    const r = await srv.inject({ method: "POST", url: `/models/${model.id}/test`, payload: { message: "سلام! این یک تست است" } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.checked).toBe(true);
    expect(body.transport).toBe("http");
    expect(body.method).toBe("POST");
    // Exactly where the message was sent.
    expect(body.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(body.message).toContain("POST https://api.openai.com/v1/chat/completions");
    expect(body.message).toMatch(/200/);
    // What the model answered.
    expect(body.responseText).toBe("OK");
    expect(body.modelId).toBe("gpt-4o-mini");
    // The outgoing request carried our message + the bearer key.
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(captured[0].method).toBe("POST");
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-test-123456");
    expect((captured[0].body?.messages as Array<Record<string, unknown>>)[0].content).toBe("سلام! این یک تست است");
    expect(captured[0].body?.model).toBe("gpt-4o-mini");
  });

  it("uses a default test message when none is provided", async () => {
    process.env.OPENAI_API_KEY = "sk-test-123456";
    const srv = await boot();
    const captured = stubFetch(() => openAiChatReply("OK"));
    const m = await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-openai", modelId: "gpt-4o" } });
    const r = await srv.inject({ method: "POST", url: `/models/${m.json().id}/test` });
    expect(r.json().ok).toBe(true);
    const sent = String((captured[0].body?.messages as Array<Record<string, unknown>>)[0].content);
    expect(sent).toMatch(/CodeVia/);
  });

  it("sends to the Anthropic messages endpoint before the model is saved (pre-registration)", async () => {
    process.env.ANTHROPIC_API_KEY = "ant-test-123";
    const srv = await boot();
    const captured = stubFetch(() => anthropicChatReply("pong"));
    const r = await srv.inject({
      method: "POST",
      url: "/models/test",
      payload: { providerId: "provider-anthropic", modelId: "claude-3-5-haiku", message: "ping" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.url).toBe("https://api.anthropic.com/v1/messages");
    expect(body.responseText).toBe("pong");
    expect(body.capabilities.reasoning).toBe(true);
    expect(captured[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured[0].headers.get("x-api-key")).toBe("ant-test-123");
    expect(captured[0].headers.get("anthropic-version")).toBe("2023-06-01");
    // Nothing was persisted by the pre-registration test (only the seeded mock models remain).
    const models = (await srv.inject({ method: "GET", url: "/models" })).json();
    expect(models).toHaveLength(3);
    expect(models.every((m: { providerId: string }) => m.providerId === "provider-mock")).toBe(true);
  });

  it("uses Gemini generateContent and never leaks the key in the surfaced URL", async () => {
    process.env.GEMINI_API_KEY = "super-secret-gemini-key";
    const srv = await boot();
    const captured = stubFetch(() => geminiChatReply("hello from gemini"));
    const r = await srv.inject({
      method: "POST",
      url: "/models/test",
      payload: { providerId: "provider-gemini", modelId: "gemini-2.0-flash", message: "hi" },
    });
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.url).toContain("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent");
    expect(body.url).toContain("key=***");
    expect(body.responseText).toBe("hello from gemini");
    // The real request did carry the key — but the response never leaks it.
    expect(captured[0].url).toContain(encodeURIComponent("super-secret-gemini-key"));
    expect(r.body).not.toContain("super-secret-gemini-key");
  });

  it("uses the Ollama native /api/chat endpoint (no /v1, no key)", async () => {
    const srv = await boot();
    const captured = stubFetch((url) => {
      if (url.includes("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "llama3.2" }] }), { status: 200 });
      return ollamaChatReply("hello from llama");
    });
    const created = await srv.inject({
      method: "POST",
      url: "/providers",
      payload: { name: "Local Ollama", type: "ollama", baseUrl: "http://localhost:11434", authType: "none", apiFormat: "ollama" },
    });
    expect(created.statusCode).toBe(201);
    const providerId = created.json().id;
    const m = await srv.inject({ method: "POST", url: "/models", payload: { providerId, modelId: "llama3.2" } });
    const r = await srv.inject({ method: "POST", url: `/models/${m.json().id}/test`, payload: { message: "hi llama" } });
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.url).toBe("http://localhost:11434/api/chat");
    expect(body.responseText).toBe("hello from llama");
    const chatCall = captured.find((c) => c.url.endsWith("/api/chat"));
    expect(chatCall).toBeDefined();
    expect(chatCall!.body?.model).toBe("llama3.2");
    expect(chatCall!.headers.get("authorization")).toBeNull();
  });

  it("sends nothing when the key is missing — but shows the chat URL it would use", async () => {
    const srv = await boot();
    const captured = stubNoNetwork();
    const m = await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-openai", modelId: "gpt-4o" } });
    const r = await srv.inject({ method: "POST", url: `/models/${m.json().id}/test` });
    const body = r.json();
    expect(body.ok).toBe(false);
    expect(body.checked).toBe(false);
    expect(body.method).toBe("POST");
    expect(body.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(body.message).toMatch(/OPENAI_API_KEY/);
    expect(body.message).toContain("https://api.openai.com/v1/chat/completions");
    expect(body.hint).toBeTruthy();
    expect(captured).toHaveLength(0);
  });

  it("answers locally for the mock provider without touching the network", async () => {
    const srv = await boot();
    const captured = stubNoNetwork();
    const m = await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-mock", modelId: "mock-fast" } });
    const r = await srv.inject({ method: "POST", url: `/models/${m.json().id}/test`, payload: { message: "hello mock" } });
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.transport).toBe("mock");
    expect(body.responseText).toContain("hello mock");
    expect(body.responseText).toMatch(/Mock/);
    expect(body.url).toMatch(/mock/i);
    expect(captured).toHaveLength(0);
  });

  it("reports provider HTTP errors with the status and the URL", async () => {
    process.env.OPENAI_API_KEY = "sk-invalid-123";
    const srv = await boot();
    stubFetch(() => new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 }));
    const m = await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-openai", modelId: "gpt-4o" } });
    const r = await srv.inject({ method: "POST", url: `/models/${m.json().id}/test` });
    const body = r.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe(401);
    expect(body.message).toContain("POST https://api.openai.com/v1/chat/completions → 401");
    expect(body.message).toContain("Incorrect API key provided");
    expect(body.hint).toMatch(/rejected/);
    expect(body.responseText).toBeUndefined();
  });

  it("/models/test without a message stays detection-only (no completion call)", async () => {
    const srv = await boot();
    const captured = stubNoNetwork();
    const r = await srv.inject({
      method: "POST",
      url: "/models/test",
      payload: { providerId: "provider-openai", modelId: "gpt-4o" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    // Cheap detection: capabilities + catalog membership, never a chat call.
    expect(body.capabilities.vision).toBe(true);
    expect(body.detectedCapabilities.vision).toBe(true);
    expect(body.found).toBeUndefined(); // catalog could not be enumerated (no key)
    expect(body.responseText).toBeUndefined();
    expect(captured).toHaveLength(0);
  });
});

describe("provider create + saved-provider tests", () => {
  it("auto-discovers and adds the provider's models right after create", async () => {
    const srv = await boot();
    const captured = stubFetch((url) =>
      url.endsWith("/models")
        ? new Response(JSON.stringify({ data: [{ id: "lm-1" }, { id: "lm-2" }] }), { status: 200 })
        : new Response("{}", { status: 404 }),
    );
    const r = await srv.inject({
      method: "POST",
      url: "/providers",
      payload: { name: "Local LLM", type: "openai-compatible", baseUrl: "http://localhost:9999/v1", authType: "none", apiFormat: "openai" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.active).toBe(true);
    // Models discovered from the live catalog and added automatically.
    expect(body.discoveredModels).toBe(2);
    expect(body.test.ok).toBe(true);
    expect(body.test.url).toBe("http://localhost:9999/v1/models");
    expect(body.message).toMatch(/2 model/);
    // They really landed in the Model Registry.
    const models = (await srv.inject({ method: "GET", url: "/models" })).json();
    expect(models.map((m: { modelId: string }) => m.modelId)).toEqual(expect.arrayContaining(["lm-1", "lm-2"]));
    expect(models.filter((m: { providerId: string }) => m.providerId === body.id)).toHaveLength(2);
    expect(captured[0].url).toBe("http://localhost:9999/v1/models");
  });

  it("edit-mode draft test reuses the stored key without re-typing it (and never persists)", async () => {
    const srv = await boot();
    stubFetch((url) =>
      url.endsWith("/models")
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response("{}", { status: 404 }),
    );
    const providersBefore = (await srv.inject({ method: "GET", url: "/providers" })).json().length;
    const created = await srv.inject({
      method: "POST",
      url: "/providers",
      payload: { name: "Keyed", type: "openai-compatible", baseUrl: "https://llm.example/v1", authType: "bearer", secretValue: "sk-stored-123456" },
    });
    expect(created.statusCode).toBe(201);
    const pid = created.json().id;
    // Test the CURRENT form values without retyping the key → stored key is used.
    const r = await srv.inject({
      method: "POST",
      url: "/providers/test",
      payload: { providerId: pid, type: "openai-compatible", baseUrl: "https://llm.example/v1", authType: "bearer" },
    });
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.keyPresent).toBe(true);
    expect(body.checked).toBe(true);
    expect(body.message).toContain("GET https://llm.example/v1/models");
    // Unknown providerId simply means no stored key to inherit.
    const r2 = await srv.inject({
      method: "POST",
      url: "/providers/test",
      payload: { providerId: "missing-id", type: "openai-compatible", baseUrl: "https://llm.example/v1", authType: "bearer" },
    });
    expect(r2.json().ok).toBe(false);
    expect(r2.json().keyPresent).toBe(false);
    // The draft test persisted nothing.
    expect((await srv.inject({ method: "GET", url: "/providers" })).json().length).toBe(providersBefore + 1);
  });

  it("auto-detects capabilities when the client omits them", async () => {
    const srv = await boot();
    const r = await srv.inject({
      method: "POST",
      url: "/models",
      payload: { providerId: "provider-openai", modelId: "gpt-4o", displayName: "GPT-4o" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.capabilities.vision).toBe(true);
    expect(body.capabilities.tools).toBe(true);
    expect(body.capabilities.structuredOutput).toBe(true);
    expect(body.detectedCapabilities.vision).toBe(true);
  });

  it("auto-discovery on provider create does not add models when the live test fails", async () => {
    const srv = await boot();
    stubNoNetwork();
    const r = await srv.inject({
      method: "POST",
      url: "/providers",
      payload: { name: "No Key LLM", type: "openai-compatible", baseUrl: "https://llm.example/v1", authType: "bearer" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.active).toBe(false);
    expect(body.discoveredModels).toBe(0);
    // Surfaces the endpoint the model catalog would be requested from.
    expect(body.test && body.test.url).toBe("https://llm.example/v1/models");
    expect(body.test.message).toContain("https://llm.example/v1/models");
  });

  it("returns both catalogUrl and chatUrl from the providers/test draft endpoint", async () => {
    const srv = await boot();
    const r = await srv.inject({
      method: "POST",
      url: "/providers/test",
      payload: { type: "anthropic", baseUrl: "https://api.anthropic.com", secretRef: "ANTHROPIC_API_KEY", authType: "api-key", apiFormat: "anthropic" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.catalogUrl).toBe("https://api.anthropic.com/v1/models?limit=50");
    expect(body.chatUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(body.urls).toEqual(expect.arrayContaining([body.catalogUrl, body.chatUrl]));
    expect(body.apiFormat).toBe("anthropic");
  });

  it("returns the documented Gemini URLs (no /v1, /v1beta is added by the platform)", async () => {
    const srv = await boot();
    const r = await srv.inject({
      method: "POST",
      url: "/providers/test",
      payload: { type: "gemini", baseUrl: "https://generativelanguage.googleapis.com", secretRef: "GEMINI_API_KEY", authType: "api-key", apiFormat: "gemini" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.catalogUrl).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(body.chatUrl).toContain("/v1beta/models/");
    expect(body.chatUrl).toContain(":generateContent");
  });

  it("returns the documented Ollama URLs (no /v1, /api/tags is used)", async () => {
    const srv = await boot();
    const r = await srv.inject({
      method: "POST",
      url: "/providers/test",
      payload: { type: "ollama", baseUrl: "http://localhost:11434", authType: "none", apiFormat: "ollama" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.catalogUrl).toBe("http://localhost:11434/api/tags");
    expect(body.chatUrl).toBe("http://localhost:11434/api/chat");
    expect(body.apiFormat).toBe("ollama");
  });

  it("GET /providers/:id/models returns the catalog + chat URLs (used by the Add-Model dropdown)", async () => {
    const srv = await boot();
    const r = await srv.inject({ method: "GET", url: "/providers/provider-openai/models" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.providerId).toBe("provider-openai");
    expect(body.catalogUrl).toBe("https://api.openai.com/v1/models");
    expect(body.chatUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(body.urls).toEqual(expect.arrayContaining([body.catalogUrl, body.chatUrl]));
    // When the key is missing, the catalog cannot be enumerated.
    expect(body.ok).toBe(false);
    expect(body.models).toEqual([]);
  });
});
