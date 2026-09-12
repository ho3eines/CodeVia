import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../domain/entities.js";
import { ProviderRegistry } from "../ai/provider-registry.js";
import { buildChatEndpoint } from "../ai/provider-urls.js";
import { testModelChat, testProviderConnection } from "../ai/provider-test.js";
import { streamModelChat } from "../ai/model-stream.js";

const config: ModelProvider = {
  id: "direct",
  name: "Ptero",
  type: "custom-http",
  apiFormat: "custom",
  baseUrl: "https://ptero.pro/wp-json/mlp/v1/chat",
  authType: "bearer",
  secretRef: "MLP_API_KEY",
  timeoutMs: 1000,
  defaultTemperature: 0.3,
  maxTokensDefault: 4096,
  rateLimitPerMinute: 10,
  active: true,
  createdAt: "",
  updatedAt: "",
};
const messages = [{ role: "user" as const, content: "Hello" }];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function setup(payload: unknown = { text: "Hello back" }, status = 200) {
  vi.stubEnv("MLP_API_KEY", "test-only-key");
  const f = vi.fn(
    async () => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", f);
  return f;
}
describe("direct JSON chat", () => {
  it("uses the exact endpoint and minimal payload in runtime and model tests", async () => {
    const f = setup();
    const provider = new ProviderRegistry().resolve(config);
    expect((await provider.chat({ modelId: "codestral:free", messages })).content).toBe("Hello back");
    expect((await testModelChat(config, "codestral:free", { message: "Hello" })).responseText).toBe("Hello back");
    for (const args of f.mock.calls as unknown as [string, RequestInit][]) {
      expect(args[0]).toBe(config.baseUrl);
      expect(JSON.parse(String(args[1].body))).toEqual({ model: "codestral:free", messages });
      expect(new Headers(args[1].headers).get("authorization")).toBe("Bearer test-only-key");
    }
  });
  it("does not attempt a nonexistent catalog", async () => {
    const f = setup();
    const result = await testProviderConnection(config);
    expect(result.checked).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.urls).toEqual([config.baseUrl]);
    expect(f).not.toHaveBeenCalled();
  });
  it("delivers non-streaming JSON to the chat UI", async () => {
    setup();
    const events = [];
    for await (const event of streamModelChat(config, "codestral:free", { messages })) events.push(event);
    expect(events).toContainEqual({ type: "delta", text: "Hello back" });
    expect(events.at(-1)).toMatchObject({ type: "done", text: "Hello back" });
  });
  it("rejects malformed responses and native tool requests", async () => {
    const f = setup({ unexpected: true });
    const provider = new ProviderRegistry().resolve(config);
    await expect(provider.chat({ modelId: "codestral:free", messages })).rejects.toThrow("text field");
    expect((await testModelChat(config, "codestral:free")).ok).toBe(false);
    f.mockClear();
    await expect(
      provider.chat({ modelId: "codestral:free", messages, tools: [{ name: "run", parameters: {} }] }),
    ).rejects.toThrow("tool calling");
    expect(f).not.toHaveBeenCalled();
  });
  it("reports HTTP failures and preserves OpenAI URLs", async () => {
    setup({ message: "No route" }, 404);
    expect(await testModelChat(config, "codestral:free")).toMatchObject({
      ok: false,
      status: 404,
      url: config.baseUrl,
    });
    expect(buildChatEndpoint({ ...config, apiFormat: "openai", baseUrl: "https://example.com/v1" })).toBe(
      "https://example.com/v1/chat/completions",
    );
  });
});
