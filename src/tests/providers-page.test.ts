import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Providers page control surface: model counts on every provider, the
 * dashboard summary, on-demand catalog sync, bulk multi-select actions
 * and provider duplication.
 * ------------------------------------------------------------------ */

let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;

/** Empty catalog keeps create/edit auto-discovery fast and offline. */
function stubEmptyCatalog(): void {
  vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch);
}

/** A catalog with two models, so sync-models has something to import. */
function stubCatalog(ids: string[]): void {
  vi.stubGlobal(
    "fetch",
    (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })) as typeof fetch,
  );
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
  process.env.OPENAI_API_KEY = "sk-test-key-1234567890";
  getEnvFresh();
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  if (app) {
    await app.close();
    app = undefined;
  }
  cleanup?.();
  cleanup = undefined;
});

describe("providers: model counts and summary", () => {
  it("reports how many models are attached to each provider", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-openai", modelId: "gpt-count-a" } });
    const off = (await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-openai", modelId: "gpt-count-b" } })).json();
    await srv.inject({ method: "POST", url: `/models/${off.id}/deactivate` });

    const list = (await srv.inject({ method: "GET", url: "/providers" })).json() as Array<{ id: string; modelCount: number; activeModelCount: number }>;
    const openai = list.find((p) => p.id === "provider-openai")!;
    expect(openai.modelCount).toBe(2);
    expect(openai.activeModelCount).toBe(1);
  });

  it("summarises providers for the page header", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const s = (await srv.inject({ method: "GET", url: "/providers/summary" })).json();
    const providers = container.providerRepo.findMany();
    expect(s.total).toBe(providers.length);
    expect(s.active + s.inactive).toBe(s.total);
    expect(s.ready).toBeGreaterThanOrEqual(1); // the mock provider is always ready
    expect(s.byType.mock).toBe(1);
  });
});

describe("providers: on-demand model sync", () => {
  it("imports catalog models missing from the Models section", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    expect(container.modelRepo.findMany().filter((m) => m.data.providerId === "provider-openai")).toHaveLength(0);

    stubCatalog(["gpt-sync-1", "gpt-sync-2"]);
    const first = (await srv.inject({ method: "POST", url: "/providers/provider-openai/sync-models" })).json();
    expect(first.added).toBe(2);
    expect(container.modelRepo.findMany().filter((m) => m.data.providerId === "provider-openai")).toHaveLength(2);

    // Running it again is a no-op — models are de-duplicated per provider.
    const second = (await srv.inject({ method: "POST", url: "/providers/provider-openai/sync-models" })).json();
    expect(second.added).toBe(0);
    expect(container.modelRepo.findMany().filter((m) => m.data.providerId === "provider-openai")).toHaveLength(2);
  });

  it("404s for an unknown provider", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    expect((await srv.inject({ method: "POST", url: "/providers/nope/sync-models" })).statusCode).toBe(404);
  });
});

describe("providers: bulk actions", () => {
  it("activates, deactivates and skips providers that have no key", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    // anthropic/gemini have no key in the environment => not ready.
    const ids = ["provider-openai", "provider-anthropic", "provider-gemini"];
    await srv.inject({ method: "POST", url: "/providers/bulk", payload: { action: "deactivate", ids } });

    const res = (await srv.inject({ method: "POST", url: "/providers/bulk", payload: { action: "activate", ids } })).json();
    expect(res.ids).toContain("provider-openai");
    expect(res.skipped.map((s: { id: string }) => s.id).sort()).toEqual(["provider-anthropic", "provider-gemini"]);
    expect(container.providerRepo.findById("provider-openai")!.data.active).toBe(true);
    expect(container.providerRepo.findById("provider-anthropic")!.data.active).toBe(false);

    // force overrides the readiness gate
    const forced = (await srv.inject({ method: "POST", url: "/providers/bulk", payload: { action: "activate", ids, force: true } })).json();
    expect(forced.affected).toBe(3);
    expect(container.providerRepo.findById("provider-anthropic")!.data.active).toBe(true);
  });

  it("deletes with cascade, protects the mock provider and reports missing ids", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-openai", modelId: "gpt-doomed" } });

    const blocked = (await srv.inject({ method: "POST", url: "/providers/bulk", payload: { action: "delete", ids: ["provider-openai"] } })).json();
    expect(blocked.affected).toBe(0);
    expect(blocked.skipped[0].reason).toMatch(/model/i);

    const res = (await srv.inject({
      method: "POST",
      url: "/providers/bulk",
      payload: { action: "delete", ids: ["provider-openai", "provider-mock", "ghost"], cascade: true },
    })).json();
    expect(res.ids).toEqual(["provider-openai"]);
    expect(res.deletedModels).toBe(1);
    expect(res.missing).toEqual(["ghost"]);
    expect(res.skipped[0].id).toBe("provider-mock");
    expect(container.providerRepo.findById("provider-mock")).toBeDefined();
  });

  it("rejects unknown actions and empty id lists", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    expect((await srv.inject({ method: "POST", url: "/providers/bulk", payload: { action: "explode", ids: ["x"] } })).statusCode).toBe(400);
    expect((await srv.inject({ method: "POST", url: "/providers/bulk", payload: { action: "activate", ids: [] } })).statusCode).toBe(400);
  });

  it("runs a health check across many providers in one call", async () => {
    stubCatalog(["m1"]);
    const srv = await boot();
    const res = (await srv.inject({ method: "POST", url: "/providers/bulk", payload: { action: "test", ids: ["provider-mock", "provider-openai"] } })).json();
    expect(res.results).toHaveLength(2);
    expect(res.results.every((r: { name: string; message: string }) => r.name && r.message)).toBe(true);
  });
});

describe("providers: duplicate", () => {
  it("clones a provider inactive with a unique name and the stored key", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const stored = (await srv.inject({
      method: "POST",
      url: "/providers",
      payload: { name: "Origin", type: "openai-compatible", baseUrl: "https://llm.example/v1", secretValue: "sk-abcdef123456" },
    })).json();

    const copy = (await srv.inject({ method: "POST", url: `/providers/${stored.id}/duplicate`, payload: {} })).json();
    expect(copy.name).toBe("Origin (copy)");
    expect(copy.active).toBe(false);
    expect(copy.baseUrl).toBe("https://llm.example/v1");
    expect(copy.secretValuePresent).toBe(true);
    expect(copy.id).not.toBe(stored.id);

    // A second copy must not collide with the first one's name.
    const copy2 = (await srv.inject({ method: "POST", url: `/providers/${stored.id}/duplicate`, payload: {} })).json();
    expect(copy2.name).toBe("Origin (copy) 2");

    expect((await srv.inject({ method: "POST", url: "/providers/ghost/duplicate", payload: {} })).statusCode).toBe(404);
  });

  it("lets a duplicate of the built-in mock provider be deleted", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const copy = (await srv.inject({ method: "POST", url: "/providers/provider-mock/duplicate", payload: {} })).json();
    // Only the seeded row (fixed id) is protected — its clone is an ordinary provider.
    expect((await srv.inject({ method: "DELETE", url: `/providers/${copy.id}?cascade=true` })).statusCode).toBe(200);
    expect((await srv.inject({ method: "DELETE", url: "/providers/provider-mock?cascade=true" })).statusCode).toBe(400);
  });
});
