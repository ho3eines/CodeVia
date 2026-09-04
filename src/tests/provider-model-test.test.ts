import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
} from "../ai/provider-urls.js";
import type { ModelProvider } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;
const ENV_KEYS = ["REQUIRE_AUTH", "OPENAI_API_KEY"] as const;
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

describe("pre-registration provider test (never saves)", () => {
  it("reports the exact endpoint and says it cannot be tested when the key is missing", async () => {
    const srv = await boot();
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
    // Nothing was persisted.
    expect((await srv.inject({ method: "GET", url: "/providers" })).json()).toHaveLength(4);
  });

  it("explains a missing environment-variable secretRef and never saves", async () => {
    const srv = await boot();
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
    expect((await srv.inject({ method: "GET", url: "/providers" })).json()).toHaveLength(4);
  });

  it("reveals the models catalog url on the mock provider test", async () => {
    const srv = await boot();
    const r = await srv.inject({ method: "POST", url: "/providers/provider-mock/test" });
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.checked).toBe(false);
    expect(body.message).toMatch(/Mock provider/);
  });
});

describe("model test + auto-detected capabilities", () => {
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

  it("tests a specific model and reports whether it is in the catalog", async () => {
    const srv = await boot();
    // provider-openai has no key → not ready, but the URL is still surfaced.
    const m = await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-openai", modelId: "gpt-4o" } });
    const model = m.json();
    const r = await srv.inject({ method: "POST", url: `/models/${model.id}/test` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.providerId).toBe("provider-openai");
    expect(body.modelId).toBe("gpt-4o");
    expect(body.url).toContain("/v1/models");
    // The catalog could not be enumerated (no key) so `found` is unknown, not false.
    expect(body.found).toBeUndefined();
    expect(body.capabilities.vision).toBe(true);
  });

  it("auto-discovery on provider create does not add models when the live test fails", async () => {
    const srv = await boot();
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
  });
});
