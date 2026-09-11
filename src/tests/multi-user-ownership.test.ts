import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { signSession } from "../auth/github-oauth.js";
import { freshDb } from "./test-helpers.js";
import { AiTextService } from "../ai/text-service.js";
import { ModelRouter } from "../ai/model-router.js";
import type { Model, ModelProvider } from "../domain/entities.js";
import type { ChatRequest, ChatResponse } from "../ai/types.js";
import type { ProviderRegistry } from "../ai/provider-registry.js";

/* ------------------------------------------------------------------ *
 * Per-account isolation of the AI registry (models + providers).
 *
 * The model registry used to be one global table: every signed-in account
 * saw every other account's providers and models, could edit them, delete
 * them, and — worst — route agent runs and chat through them, spending
 * somebody else's API key. On the project side, "shared/unowned" projects
 * were visible to every account, which is how one account opened another
 * account's repository and errored out on the first GitHub call made with
 * its own token.
 * ------------------------------------------------------------------ */

const ENV_KEYS = ["REQUIRE_AUTH", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "AUTH_SECRET"] as const;

let savedEnv: Record<string, string | undefined>;
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

interface TestUser {
  id: string;
  token: string;
  bearer: Record<string, string>;
}

function makeUser(idNumber: number, login: string): TestUser {
  const { user } = container.userRepo.upsertGitHubUser({ id: idNumber, login, name: login, email: `${login}@x.test` });
  const token = signSession(user.id);
  return { id: user.id, token, bearer: { authorization: `Bearer ${token}` } };
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_SECRET = "multi-user-ownership-tests-secret-0123456789";
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
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  getEnvFresh();
  cleanup?.();
  cleanup = undefined;
});

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */
describe("providers are per-account", () => {
  /** Create a provider through the API as `user` (mock type = no network). */
  async function createProvider(srv: FastifyInstance, user: TestUser, name: string): Promise<ModelProvider> {
    const res = await srv.inject({
      method: "POST",
      url: "/providers",
      headers: user.bearer,
      payload: { type: "mock", name },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as ModelProvider;
  }

  it("hides another account's provider from list, read and every mutation", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(11, "prov-alice");
    const bob = makeUser(12, "prov-bob");
    const provider = await createProvider(srv, alice, "Alice Private");
    expect(provider.ownerId).toBe(alice.id);

    // Bob's list contains the shared platform rows but never Alice's provider.
    const bobList = (await srv.inject({ method: "GET", url: "/providers", headers: bob.bearer })).json() as Array<{ id: string }>;
    expect(bobList.some((p) => p.id === provider.id)).toBe(false);
    expect(bobList.some((p) => p.id === "provider-mock")).toBe(true);

    // Read + every mutation reads as 404 (no existence leak, nothing changed).
    for (const attempt of [
      { method: "GET", url: `/providers/${provider.id}` },
      { method: "PATCH", url: `/providers/${provider.id}`, payload: { name: "hijacked" } },
      { method: "DELETE", url: `/providers/${provider.id}?cascade=true` },
      { method: "POST", url: `/providers/${provider.id}/activate` },
      { method: "POST", url: `/providers/${provider.id}/deactivate` },
      { method: "POST", url: `/providers/${provider.id}/test`, payload: {} },
      { method: "POST", url: `/providers/${provider.id}/sync-models`, payload: {} },
      { method: "POST", url: `/providers/${provider.id}/duplicate`, payload: {} },
      { method: "GET", url: `/providers/${provider.id}/models` },
    ] as const) {
      const res = await srv.inject({ ...attempt, url: attempt.url, headers: bob.bearer, payload: "payload" in attempt ? attempt.payload : undefined });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }

    // Bulk actions skip it instead of acting on someone else's row.
    const bulk = (await srv.inject({ method: "POST", url: "/providers/bulk", headers: bob.bearer, payload: { action: "delete", ids: [provider.id], cascade: true } })).json() as { affected: string[]; missing: string[] };
    expect(bulk.affected).toBe(0);
    expect(bulk.missing).toContain(provider.id);

    // Untouched for its owner.
    const own = (await srv.inject({ method: "GET", url: `/providers/${provider.id}`, headers: alice.bearer })).json() as ModelProvider;
    expect(own.name).toBe("Alice Private");
  });

  it("editing a shared platform row hands it to the acting account", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(13, "adopt-alice");
    const bob = makeUser(14, "adopt-bob");

    // Seeded rows have no owner: both accounts see them.
    expect((await srv.inject({ method: "GET", url: "/providers", headers: bob.bearer })).json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "provider-openai" })]),
    );

    // Alice configures it → it becomes hers (a shared row is visible to
    // everyone, so an in-place edit would expose her key to other accounts).
    const patched = await srv.inject({
      method: "PATCH",
      url: "/providers/provider-openai",
      headers: alice.bearer,
      payload: { secretValue: "sk-alice-secret-123456" },
    });
    expect(patched.statusCode).toBe(200);
    expect(container.providerRepo.findById("provider-openai")?.data.ownerId).toBe(alice.id);

    const bobList = (await srv.inject({ method: "GET", url: "/providers", headers: bob.bearer })).json() as Array<{ id: string }>;
    expect(bobList.some((p) => p.id === "provider-openai")).toBe(false);
    const aliceList = (await srv.inject({ method: "GET", url: "/providers", headers: alice.bearer })).json() as Array<{ id: string; secretValuePresent: boolean }>;
    expect(aliceList.find((p) => p.id === "provider-openai")?.secretValuePresent).toBe(true);
  });

  it("keeps the built-in offline fallback shared and undeletable", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(15, "mock-alice");
    const bob = makeUser(16, "mock-bob");

    // Editing the offline fallback must not hand it to one account.
    const patched = await srv.inject({ method: "PATCH", url: "/providers/provider-mock", headers: alice.bearer, payload: { timeoutMs: 12345 } });
    expect(patched.statusCode).toBe(200);
    expect(container.providerRepo.findById("provider-mock")?.data.ownerId).toBeUndefined();

    // …and it stays available to every account.
    const bobList = (await srv.inject({ method: "GET", url: "/providers", headers: bob.bearer })).json() as Array<{ id: string }>;
    expect(bobList.some((p) => p.id === "provider-mock")).toBe(true);

    // Deleting it (or its models) is refused: that would take the offline path
    // away from everyone else.
    expect((await srv.inject({ method: "DELETE", url: "/providers/provider-mock", headers: alice.bearer, query: { cascade: "true" } })).statusCode).toBe(400);
    const delModel = await srv.inject({ method: "DELETE", url: "/models/model-mock-fast", headers: alice.bearer });
    expect(delModel.statusCode).toBe(409);
    const bulk = (await srv.inject({ method: "POST", url: "/models/bulk", headers: alice.bearer, payload: { action: "delete", ids: ["model-mock-fast", "model-mock-strong"] } })).json() as { affected: string[]; skipped: Array<{ id: string }> };
    expect(bulk.affected).toBe(0);
    expect(bulk.skipped.map((s) => s.id)).toEqual(["model-mock-fast", "model-mock-strong"]);
    expect(container.modelRepo.findById("model-mock-fast")).toBeDefined();
  });

  it("still shows every row to the single-user demo identity", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(17, "demo-alice");
    const provider = await createProvider(srv, alice, "Alice Private");

    // No session ⇒ demo owner (auth off / single-user install): nothing
    // disappears from an installation that never had accounts.
    const list = (await srv.inject({ method: "GET", url: "/providers" })).json() as Array<{ id: string }>;
    expect(list.some((p) => p.id === provider.id)).toBe(true);
    expect((await srv.inject({ method: "GET", url: `/providers/${provider.id}` })).statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * Models
 * ------------------------------------------------------------------ */
describe("models are per-account", () => {
  async function aliceModel(srv: FastifyInstance, alice: TestUser): Promise<{ provider: ModelProvider; model: Model }> {
    const provider = (await srv.inject({ method: "POST", url: "/providers", headers: alice.bearer, payload: { type: "mock", name: "Alice Models" } })).json() as ModelProvider;
    const model = (await srv.inject({ method: "POST", url: "/models", headers: alice.bearer, payload: { providerId: provider.id, modelId: "alice-private-model" } })).json() as Model;
    return { provider, model };
  }

  it("attaches a model to its provider's owner and hides it from other accounts", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(21, "model-alice");
    const bob = makeUser(22, "model-bob");
    const { provider, model } = await aliceModel(srv, alice);
    expect(model.ownerId).toBe(alice.id);

    const bobModels = (await srv.inject({ method: "GET", url: "/models", headers: bob.bearer })).json() as Array<{ id: string }>;
    expect(bobModels.some((m) => m.id === model.id)).toBe(false);

    for (const attempt of [
      { method: "GET", url: `/models/${model.id}` },
      { method: "PATCH", url: `/models/${model.id}`, payload: { displayName: "hijacked" } },
      { method: "DELETE", url: `/models/${model.id}` },
      { method: "POST", url: `/models/${model.id}/activate`, payload: {} },
      { method: "POST", url: `/models/${model.id}/deactivate`, payload: {} },
      { method: "POST", url: `/models/${model.id}/test`, payload: { message: "hi" } },
    ] as const) {
      const res = await srv.inject({ ...attempt, headers: bob.bearer });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }

    // Bulk actions skip foreign rows.
    const bulk = (await srv.inject({ method: "POST", url: "/models/bulk", headers: bob.bearer, payload: { action: "delete", ids: [model.id] } })).json() as { affected: string[]; missing: string[] };
    expect(bulk.affected).toBe(0);
    expect(bulk.missing).toContain(model.id);

    // The owner keeps full control, and the provider's model count is scoped.
    expect((await srv.inject({ method: "GET", url: `/models/${model.id}`, headers: alice.bearer })).statusCode).toBe(200);
    const counts = (await srv.inject({ method: "GET", url: "/providers", headers: alice.bearer })).json() as Array<{ id: string; modelCount: number }>;
    expect(counts.find((p) => p.id === provider.id)?.modelCount).toBe(1);
  });

  it("never routes a call through another account's provider", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(23, "route-alice");
    const bob = makeUser(24, "route-bob");

    const mkProvider = (ownerId: string, name: string): ModelProvider =>
      container.providerRepo.create({
        ownerId,
        name,
        type: "openai",
        baseUrl: "https://example.test/v1",
        secretRef: "OPENAI_API_KEY",
        authType: "bearer",
        apiFormat: "openai",
        timeoutMs: 60000,
        maxTokensDefault: 4096,
        defaultTemperature: 0.3,
        rateLimitPerMinute: 200,
        active: true,
      });
    const mkModel = (provider: ModelProvider, modelId: string): Model =>
      container.modelRepo.create({
        ownerId: provider.ownerId,
        providerId: provider.id,
        modelId,
        displayName: modelId,
        contextWindow: 128000,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        capabilities: { vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true },
        active: true,
        priority: 1,
        fallbackPriority: 1,
        tags: [],
      });

    const aliceProvider = mkProvider(alice.id, "Alice LLM");
    const bobProvider = mkProvider(bob.id, "Bob LLM");
    mkModel(aliceProvider, "alice-model");
    mkModel(bobProvider, "bob-model");

    // A registry that records which provider was actually called.
    const called: string[] = [];
    const fakeRegistry = {
      resolve: (config: ModelProvider) => ({
        id: config.id,
        type: config.type,
        name: config.name,
        chat: async (req: ChatRequest): Promise<ChatResponse> => {
          called.push(config.id);
          return { content: "ok", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, modelId: req.modelId, providerId: config.id };
        },
        listModels: async () => [],
        resolveApiKey: () => "sk-test",
        health: async () => true,
      }),
      invalidate: () => undefined,
    } as unknown as ProviderRegistry;

    const aiText = new AiTextService({
      modelRepo: container.modelRepo,
      providerRepo: container.providerRepo,
      providerRegistry: fakeRegistry,
      modelRouter: new ModelRouter(),
      costRepo: container.costRepo,
      benchRepo: container.benchRepo,
    });

    // Alice's chat may only ever reach Alice's provider…
    await aiText.complete({ messages: [{ role: "user", content: "hi" }], ownerId: alice.id });
    expect(called).toEqual([aliceProvider.id]);

    // …and Bob's only Bob's.
    called.length = 0;
    await aiText.complete({ messages: [{ role: "user", content: "hi" }], ownerId: bob.id });
    expect(called).toEqual([bobProvider.id]);
  });
});

/* ------------------------------------------------------------------ *
 * Projects / dashboard / search
 * ------------------------------------------------------------------ */
describe("projects, dashboard and search are per-account", () => {
  async function createProject(srv: FastifyInstance, user: TestUser, name: string): Promise<string> {
    const res = await srv.inject({
      method: "POST",
      url: "/projects",
      headers: user.bearer,
      payload: { name, configRepo: `acme/${name.toLowerCase()}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  it("scopes the dashboard counters and global search to the account's own projects", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(31, "dash-alice");
    const bob = makeUser(32, "dash-bob");
    const aliceProject = await createProject(srv, alice, "DashboardAlice");
    await createProject(srv, bob, "DashboardBob");

    const aliceDash = (await srv.inject({ method: "GET", url: "/dashboard", headers: alice.bearer })).json() as { totalProjects: number };
    const bobDash = (await srv.inject({ method: "GET", url: "/dashboard", headers: bob.bearer })).json() as { totalProjects: number };
    expect(aliceDash.totalProjects).toBe(1);
    expect(bobDash.totalProjects).toBe(1);

    const aliceSearch = (await srv.inject({ method: "GET", url: "/search?q=dashboard", headers: alice.bearer })).json() as { results: Array<{ id: string }> };
    expect(aliceSearch.results.some((r) => r.id === aliceProject)).toBe(true);
    expect(aliceSearch.results.length).toBe(1);

    const bobSearch = (await srv.inject({ method: "GET", url: "/search?q=dashboard", headers: bob.bearer })).json() as { results: Array<{ id: string }> };
    expect(bobSearch.results.some((r) => r.id === aliceProject)).toBe(false);
  });

  it("never spends another account's project budget or lists its tasks and runs", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(33, "task-alice");
    const bob = makeUser(34, "task-bob");
    const aliceProject = await createProject(srv, alice, "TasksAlice");
    const task = (await srv.inject({
      method: "POST",
      url: "/tasks",
      headers: alice.bearer,
      payload: { projectId: aliceProject, title: "Alice task", description: "private" },
    })).json() as { id: string };

    const bobTasks = (await srv.inject({ method: "GET", url: "/tasks", headers: bob.bearer })).json() as Array<{ id: string }>;
    expect(bobTasks.some((t) => t.id === task.id)).toBe(false);
    const bobRuns = (await srv.inject({ method: "GET", url: "/runs", headers: bob.bearer })).json() as Array<{ projectId: string }>;
    expect(bobRuns.some((r) => r.projectId === aliceProject)).toBe(false);
    const bobCosts = (await srv.inject({ method: "GET", url: "/costs", headers: bob.bearer })).json() as Array<{ projectId?: string }>;
    expect(bobCosts.some((c) => c.projectId === aliceProject)).toBe(false);
  });
});
