import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { extractStreamDelta, buildStreamRequest, streamModelChat } from "../ai/model-stream.js";
import type { ModelProvider } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Models page features: manual model ids, bulk multi-select actions,
 * and the ChatGPT-style SSE streaming endpoint.
 * ------------------------------------------------------------------ */

let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;

function stubEmptyCatalog(): void {
  vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch);
}

async function boot(): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
  return app;
}

beforeEach(() => {
  delete process.env.REQUIRE_AUTH;
  getEnvFresh();
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (app) {
    await app.close();
    app = undefined;
  }
  cleanup?.();
  cleanup = undefined;
});

const mockProviderId = (): string =>
  container.providerRepo.findMany().find((p) => p.data.type === "mock")!.data.id;

describe("models: manual model ids", () => {
  it("accepts a model id typed by hand that is not in any catalog", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const res = await srv.inject({
      method: "POST",
      url: "/models",
      payload: { providerId: mockProviderId(), modelId: "meta-llama/llama-3.3-70b-instruct:free" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ modelId: "meta-llama/llama-3.3-70b-instruct:free" });
  });

  it("strips a pasted `models/` prefix and is idempotent per provider", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const providerId = mockProviderId();
    const first = await srv.inject({ method: "POST", url: "/models", payload: { providerId, modelId: "models/gemini-2.0-flash-exp" } });
    expect(first.json().modelId).toBe("gemini-2.0-flash-exp");
    const dup = await srv.inject({ method: "POST", url: "/models", payload: { providerId, modelId: "gemini-2.0-flash-exp" } });
    expect(dup.json()).toMatchObject({ id: first.json().id, duplicate: true });
    expect(container.modelRepo.findMany().filter((m) => m.data.modelId === "gemini-2.0-flash-exp")).toHaveLength(1);
  });
});

describe("models: bulk multi-select actions", () => {
  it("deactivates and deletes many models in one call", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const providerId = mockProviderId();
    const ids: string[] = [];
    for (const modelId of ["bulk-a", "bulk-b", "bulk-c"]) {
      const r = await srv.inject({ method: "POST", url: "/models", payload: { providerId, modelId } });
      ids.push(r.json().id);
    }
    const off = await srv.inject({ method: "POST", url: "/models/bulk", payload: { action: "deactivate", ids } });
    expect(off.json()).toMatchObject({ ok: true, affected: 3 });
    expect(ids.every((id) => container.modelRepo.findById(id)!.data.active === false)).toBe(true);

    const del = await srv.inject({ method: "POST", url: "/models/bulk", payload: { action: "delete", ids: [...ids, "ghost"] } });
    expect(del.json()).toMatchObject({ affected: 3, missing: ["ghost"] });
    expect(ids.every((id) => container.modelRepo.findById(id) === undefined)).toBe(true);
  });

  it("rejects unknown actions and empty selections", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    expect((await srv.inject({ method: "POST", url: "/models/bulk", payload: { action: "nuke", ids: ["x"] } })).statusCode).toBe(400);
    expect((await srv.inject({ method: "POST", url: "/models/bulk", payload: { action: "delete", ids: [] } })).statusCode).toBe(400);
  });
});

describe("models: streaming chat", () => {
  it("streams SSE frames (meta → delta… → done) for a saved model", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const model = container.modelRepo.findMany().find((m) => m.data.modelId === "mock-fast")!.data;
    const res = await srv.inject({
      method: "POST",
      url: `/models/${model.id}/stream`,
      payload: { messages: [{ role: "user", content: "سلام، حالت چطوره؟" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = res.body
      .split("\n\n")
      .filter((b) => b.startsWith("data:"))
      .map((b) => JSON.parse(b.slice(5).trim()) as { type: string; text?: string });
    expect(events[0].type).toBe("meta");
    expect(events.some((e) => e.type === "delta")).toBe(true);
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.text).toContain("Mock");
  });

  it("requires a message and a known model", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const model = container.modelRepo.findMany().find((m) => m.data.modelId === "mock-fast")!.data;
    expect((await srv.inject({ method: "POST", url: `/models/${model.id}/stream`, payload: {} })).statusCode).toBe(400);
    expect((await srv.inject({ method: "POST", url: "/models/nope/stream", payload: { message: "hi" } })).statusCode).toBe(404);
  });
});

describe("model-stream helpers", () => {
  const base: ModelProvider = {
    id: "p1",
    name: "P",
    type: "openai",
    baseUrl: "https://api.example.com/v1",
    secretRef: "TEST_KEY",
    authType: "bearer",
    apiFormat: "openai",
    timeoutMs: 30000,
    maxTokensDefault: 512,
    defaultTemperature: 0.2,
    rateLimitPerMinute: 60,
    active: true,
    createdAt: "",
    updatedAt: "",
  };

  it("asks each API format to stream", () => {
    const msgs = [{ role: "user" as const, content: "hi" }];
    expect(buildStreamRequest(base, "gpt-4o", { messages: msgs }).body.stream).toBe(true);
    const anthropic = buildStreamRequest({ ...base, apiFormat: "anthropic" }, "claude", { messages: msgs });
    expect(anthropic.body.stream).toBe(true);
    const gemini = buildStreamRequest({ ...base, apiFormat: "gemini", baseUrl: "https://g.example/v1beta" }, "gemini-pro", { messages: msgs });
    expect(gemini.url).toContain(":streamGenerateContent?alt=sse");
  });

  it("extracts incremental text per API format", () => {
    expect(extractStreamDelta("openai", { choices: [{ delta: { content: "He" } }] })).toBe("He");
    expect(extractStreamDelta("anthropic", { type: "content_block_delta", delta: { text: "llo" } })).toBe("llo");
    expect(extractStreamDelta("gemini", { candidates: [{ content: { parts: [{ text: "!" }] } }] })).toBe("!");
    expect(extractStreamDelta("ollama", { message: { content: "hey" } })).toBe("hey");
    expect(extractStreamDelta("openai", { choices: [{}] })).toBe("");
  });

  it("reassembles SSE frames split across network chunks", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi',
      'ces":[{"delta":{"content":"lo wor"}}]}\n\ndata: {"choices":[{"delta":{"content":"ld"}}]}\n\ndata: [DONE]\n\n',
    ];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(encoder.encode(c));
        ctrl.close();
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    process.env.TEST_KEY = "k-123";
    const out: string[] = [];
    let final = "";
    for await (const ev of streamModelChat(base, "gpt-4o", { messages: [{ role: "user", content: "hi" }], fetchImpl })) {
      if (ev.type === "delta") out.push(ev.text);
      if (ev.type === "done") final = ev.text;
    }
    delete process.env.TEST_KEY;
    expect(out).toEqual(["Hel", "lo wor", "ld"]);
    expect(final).toBe("Hello world");
  });

  it("reports provider errors as an error event instead of throwing", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as unknown as typeof fetch;
    process.env.TEST_KEY = "k-123";
    const events = [];
    for await (const ev of streamModelChat(base, "gpt-4o", { messages: [{ role: "user", content: "hi" }], fetchImpl })) {
      events.push(ev);
    }
    delete process.env.TEST_KEY;
    const err = events.find((e) => e.type === "error") as { message: string } | undefined;
    expect(err?.message).toContain("bad key");
  });
});

describe("models: editing and per-model tuning", () => {
  it("patches every editable field, including capabilities and tags", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const providerId = mockProviderId();
    const created = (await srv.inject({ method: "POST", url: "/models", payload: { providerId, modelId: "edit-me" } })).json();
    const res = await srv.inject({
      method: "PATCH",
      url: `/models/${created.id}`,
      payload: {
        displayName: "Renamed",
        modelId: "models/edit-me-2",
        contextWindow: 32000,
        priority: 5,
        inputCostPer1k: 1.5,
        capabilities: { vision: true },
        tags: ["free", " fast "],
        active: false,
        notes: "route only accepts temperature 1.0",
      },
    });
    expect(res.json()).toMatchObject({
      displayName: "Renamed",
      modelId: "edit-me-2",
      contextWindow: 32000,
      priority: 5,
      inputCostPer1k: 1.5,
      active: false,
      tags: ["free", "fast"],
      notes: "route only accepts temperature 1.0",
    });
    expect(res.json().capabilities.vision).toBe(true);
  });

  it("stores, validates and clears the temperature override", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const providerId = mockProviderId();
    const m = (await srv.inject({ method: "POST", url: "/models", payload: { providerId, modelId: "tuned" } })).json();

    const set = await srv.inject({ method: "PATCH", url: `/models/${m.id}`, payload: { temperature: 1, maxTokens: 2048 } });
    expect(set.json()).toMatchObject({ temperature: 1, maxTokens: 2048 });

    expect((await srv.inject({ method: "PATCH", url: `/models/${m.id}`, payload: { temperature: 5 } })).statusCode).toBe(400);
    expect((await srv.inject({ method: "PATCH", url: `/models/${m.id}`, payload: { maxTokens: 0 } })).statusCode).toBe(400);

    const cleared = await srv.inject({ method: "PATCH", url: `/models/${m.id}`, payload: { temperature: null, maxTokens: null } });
    expect(cleared.json().temperature).toBeUndefined();
    expect(cleared.json().maxTokens).toBeUndefined();
  });

  it("rejects a rename that collides with another model of the same provider", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const providerId = mockProviderId();
    const a = (await srv.inject({ method: "POST", url: "/models", payload: { providerId, modelId: "aaa" } })).json();
    await srv.inject({ method: "POST", url: "/models", payload: { providerId, modelId: "bbb" } });
    expect((await srv.inject({ method: "PATCH", url: `/models/${a.id}`, payload: { modelId: "bbb" } })).statusCode).toBe(409);
  });

  it("sends the model's saved temperature to the provider instead of a hardcoded 0", async () => {
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", (async (_url: string, init?: RequestInit) => {
      if (init?.body) seen.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    }) as unknown as typeof fetch);
    process.env.OPENAI_API_KEY = "sk-test-123";
    const srv = await boot();
    const m = (await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-openai", modelId: "tuned-route", temperature: 1 } })).json();
    expect(m.temperature).toBe(1);
    await srv.inject({ method: "POST", url: `/models/${m.id}/test`, payload: { message: "hi" } });
    const chatBody = seen.find((b) => b.model === "tuned-route")!;
    expect(chatBody.temperature).toBe(1);

    // With omitTemperature the field must disappear from the payload entirely.
    await srv.inject({ method: "PATCH", url: `/models/${m.id}`, payload: { omitTemperature: true } });
    seen.length = 0;
    await srv.inject({ method: "POST", url: `/models/${m.id}/test`, payload: { message: "hi" } });
    const second = seen.find((b) => b.model === "tuned-route")!;
    expect("temperature" in second).toBe(false);
    delete process.env.OPENAI_API_KEY;
  });

  it("hints at the Edit form when a route rejects the temperature parameter", async () => {
    vi.stubGlobal("fetch", (async () =>
      new Response(
        JSON.stringify({ error: { message: "The value 0.0 for 'temperature' is not supported by this model route. Supported values are between 1.0 and 1.0." } }),
        { status: 400 },
      )) as unknown as typeof fetch);
    process.env.OPENAI_API_KEY = "sk-test-123";
    const srv = await boot();
    const m = (await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-openai", modelId: "picky-route" } })).json();
    const r = (await srv.inject({ method: "POST", url: `/models/${m.id}/test`, payload: { message: "hi" } })).json();
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/Edit/);
    expect(r.hint).toMatch(/Temperature/);
    delete process.env.OPENAI_API_KEY;
  });
});
