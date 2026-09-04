import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { testProviderConnection, providerReadiness } from "../ai/provider-test.js";
import type { ModelProvider } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Multi-select / multi-repo project creation and the provider approval
 * flow (activate / deactivate / test / delete) that the UI relies on.
 * ------------------------------------------------------------------ */

let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;
const ENV_KEYS = ["REQUIRE_AUTH", "OPENAI_API_KEY", "TEST_PROVIDER_KEY"] as const;
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
  getEnvFresh();
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
  getEnvFresh();
  cleanup?.();
});

describe("projects API — multi-repo + multi-select capabilities", () => {
  it("serves the option catalog before the :id route", async () => {
    const srv = await boot();
    const res = await srv.inject({ method: "GET", url: "/projects/options" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.platforms.length).toBeGreaterThan(3);
    expect(body.agentTypes.length).toBe(18);
    expect(body.coreAgentTypes).toContain("orchestrator");
  });

  it("creates a project with several repositories and multi-valued capabilities", async () => {
    const srv = await boot();
    const res = await srv.inject({
      method: "POST",
      url: "/projects",
      payload: {
        name: "Storefront Suite",
        description: "shop",
        repositories: [
          { repo: "acme/storefront", branch: "main", role: "backend", isConfigRepo: true },
          { repo: "acme/mobile-app", branch: "develop", role: "mobile" },
        ],
        capabilities: {
          platforms: ["web", "mobile-ios"],
          languages: ["typescript", "swift"],
          frameworks: ["nextjs"],
          databases: ["postgresql", "redis"],
          deploymentTargets: ["kubernetes"],
          features: ["payments"],
          integrations: ["stripe"],
          agentTypes: ["backend-developer", "frontend-developer"],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.configRepo).toBe("acme/storefront");
    expect(p.branch).toBe("main");
    expect(p.repositories).toHaveLength(2);
    expect(p.repositories[1]).toMatchObject({ repo: "acme/mobile-app", branch: "develop", role: "mobile", isConfigRepo: false });
    expect(p.capabilities.databases).toEqual(["postgresql", "redis"]);
    expect(p.capabilities.platforms).toEqual(["web", "mobile-ios"]);
    expect(p.framework).toBe("Next.js");
    expect(p.database).toBe("PostgreSQL");
    expect(p.githubConnection.kind).toBe("mock");

    const agents = (await srv.inject({ method: "GET", url: `/projects/${p.id}/agents` })).json() as Array<{ type: string; enabled: boolean }>;
    const enabled = agents.filter((a) => a.enabled).map((a) => a.type).sort();
    expect(enabled).toContain("backend-developer");
    expect(enabled).toContain("frontend-developer");
    expect(enabled).toContain("orchestrator");
    expect(enabled).not.toContain("devops");

    // GET returns the hydrated document
    const got = (await srv.inject({ method: "GET", url: `/projects/${p.id}` })).json();
    expect(got.repositories).toHaveLength(2);
    expect(got.capabilities.frameworks).toEqual(["nextjs"]);

    // repositories sub-resource: link, re-point config, unlink
    const linked = (await srv.inject({ method: "POST", url: `/projects/${p.id}/repositories`, payload: { repo: "acme/accounting", role: "library" } })).json();
    expect(linked.repositories.map((r: { repo: string }) => r.repo)).toEqual(["acme/storefront", "acme/mobile-app", "acme/accounting"]);
    const moved = (await srv.inject({ method: "PATCH", url: `/projects/${p.id}/repositories/acme/accounting`, payload: { isConfigRepo: true, branch: "release" } })).json();
    expect(moved.configRepo).toBe("acme/accounting");
    expect(moved.branch).toBe("release");
    expect(moved.repositories.filter((r: { isConfigRepo: boolean }) => r.isConfigRepo)).toHaveLength(1);
    const removed = await srv.inject({ method: "DELETE", url: `/projects/${p.id}/repositories/acme/mobile-app` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().repositories).toHaveLength(2);
    const bad = await srv.inject({ method: "DELETE", url: `/projects/${p.id}/repositories/nope/nothing` });
    expect(bad.statusCode).toBe(404);
  });

  it("re-onboards when capabilities change via PATCH and disables agents outside the roster", async () => {
    const srv = await boot();
    const p = (await srv.inject({ method: "POST", url: "/projects", payload: { name: "Roster", configRepo: "acme/roster" } })).json();
    const before = (await srv.inject({ method: "GET", url: `/projects/${p.id}/agents` })).json() as Array<{ enabled: boolean }>;
    expect(before.filter((a) => a.enabled)).toHaveLength(18); // nothing selected → all agents
    const patched = await srv.inject({ method: "PATCH", url: `/projects/${p.id}`, payload: { capabilities: { agentTypes: ["devops"] } } });
    expect(patched.statusCode).toBe(200);
    const after = (await srv.inject({ method: "GET", url: `/projects/${p.id}/agents` })).json() as Array<{ type: string; enabled: boolean }>;
    expect(after).toHaveLength(18); // never deleted
    const enabled = after.filter((a) => a.enabled).map((a) => a.type).sort();
    expect(enabled).toEqual(["code-reviewer", "debugging", "devops", "orchestrator", "project-manager", "qa-test"]);
  });

  it("rejects invalid input with real status codes", async () => {
    const srv = await boot();
    expect((await srv.inject({ method: "POST", url: "/projects", payload: { name: "" } })).statusCode).toBe(400);
    expect((await srv.inject({ method: "POST", url: "/projects", payload: { name: "X" } })).statusCode).toBe(400);
    const badRepo = await srv.inject({ method: "POST", url: "/projects", payload: { name: "X", configRepo: "not a repo" } });
    expect(badRepo.statusCode).toBe(400);
    expect(badRepo.json().error).toMatch(/owner\/name/);
    expect((await srv.inject({ method: "POST", url: "/projects", payload: { name: "Dup", configRepo: "a/b" } })).statusCode).toBe(201);
    expect((await srv.inject({ method: "POST", url: "/projects", payload: { name: "Dup", configRepo: "a/c" } })).statusCode).toBe(409);
    expect((await srv.inject({ method: "GET", url: "/projects/does-not-exist" })).statusCode).toBe(404);
  });

  it("still accepts the legacy single-value payload (framework/database strings)", async () => {
    const srv = await boot();
    const res = await srv.inject({ method: "POST", url: "/projects", payload: { name: "Legacy", configRepo: "acme/legacy", framework: ".NET", database: "SQL Server", branch: "dev" } });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.repositories).toEqual([expect.objectContaining({ repo: "acme/legacy", branch: "dev", isConfigRepo: true })]);
    expect(p.capabilities.frameworks).toEqual(["dotnet"]);
    expect(p.capabilities.databases).toEqual(["sqlserver"]);
  });
});

describe("providers API — approval flow", () => {
  it("lists providers with readiness and refuses to activate one without its key", async () => {
    const srv = await boot();
    const list = (await srv.inject({ method: "GET", url: "/providers" })).json() as Array<ModelProvider & { readiness: { ready: boolean }; keyPresent: boolean }>;
    const openai = list.find((p) => p.id === "provider-openai")!;
    expect(openai.active).toBe(false);
    expect(openai.readiness.ready).toBe(false);
    expect(openai.keyPresent).toBe(false);

    const denied = await srv.inject({ method: "POST", url: "/providers/provider-openai/activate" });
    expect(denied.statusCode).toBe(422);
    expect(denied.json().hint).toMatch(/OPENAI_API_KEY/);

    const forced = await srv.inject({ method: "POST", url: "/providers/provider-openai/activate?force=true" });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().active).toBe(true);

    // once the key exists, activation is allowed normally
    process.env.OPENAI_API_KEY = "sk-test";
    await srv.inject({ method: "POST", url: "/providers/provider-openai/deactivate" });
    const ok = await srv.inject({ method: "POST", url: "/providers/provider-openai/activate" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ active: true, keyPresent: true, readiness: { ready: true } });
  });

  it("creates providers from presets, validates secretRef and prevents duplicates", async () => {
    const srv = await boot();
    const presets = (await srv.inject({ method: "GET", url: "/providers/presets" })).json();
    expect(presets.types).toContain("ollama");
    const created = await srv.inject({ method: "POST", url: "/providers", payload: { name: "Local Ollama", type: "ollama" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ baseUrl: "http://localhost:11434/v1", authType: "none", active: true });
    expect((await srv.inject({ method: "POST", url: "/providers", payload: { name: "Local Ollama", type: "ollama" } })).statusCode).toBe(409);
    const literal = await srv.inject({ method: "POST", url: "/providers", payload: { name: "Leak", type: "openai", secretRef: "sk-live-abcdef" } });
    expect(literal.statusCode).toBe(400);
    expect(literal.json().error).toMatch(/environment variable NAME/);
    expect((await srv.inject({ method: "POST", url: "/providers", payload: { name: "Bad", type: "nope" } })).statusCode).toBe(400);
    // new provider without key is saved inactive, never "confirmed" silently
    const noKey = (await srv.inject({ method: "POST", url: "/providers", payload: { name: "OpenRouter", type: "openrouter" } })).json();
    expect(noKey.active).toBe(false);
    expect(noKey.readiness.ready).toBe(false);
  });

  it("tests, invalidates the adapter cache and deletes providers (cascade to models)", async () => {
    const srv = await boot();
    const mockTest = (await srv.inject({ method: "POST", url: "/providers/provider-mock/test" })).json();
    expect(mockTest.ok).toBe(true);
    const openaiTest = (await srv.inject({ method: "POST", url: "/providers/provider-openai/test" })).json();
    expect(openaiTest.ok).toBe(false);
    expect(openaiTest.checked).toBe(false);
    expect(openaiTest.hint).toMatch(/OPENAI_API_KEY/);

    // PATCH refreshes the cached adapter so the new config is used
    container.providerRegistry.resolve(container.providerRepo.findById("provider-openai")!.data);
    expect(container.providerRegistry.get("provider-openai")).toBeDefined();
    await srv.inject({ method: "PATCH", url: "/providers/provider-openai", payload: { baseUrl: "https://proxy.example/v1" } });
    expect(container.providerRegistry.get("provider-openai")).toBeUndefined();

    const model = (await srv.inject({ method: "POST", url: "/models", payload: { providerId: "provider-openai", modelId: "gpt-test" } })).json();
    expect(model.id).toBeDefined();
    expect((await srv.inject({ method: "POST", url: "/models", payload: { providerId: "missing", modelId: "x" } })).statusCode).toBe(400);
    const blocked = await srv.inject({ method: "DELETE", url: "/providers/provider-openai" });
    expect(blocked.statusCode).toBe(409);
    const deleted = await srv.inject({ method: "DELETE", url: "/providers/provider-openai?cascade=true" });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().deletedModels).toBe(1);
    expect((await srv.inject({ method: "GET", url: `/models/${model.id}` })).statusCode).toBe(404);
    expect((await srv.inject({ method: "DELETE", url: "/providers/provider-mock" })).statusCode).toBe(400);
  });
});

describe("testProviderConnection", () => {
  const base: ModelProvider = {
    id: "p",
    name: "Test",
    type: "openai-compatible",
    baseUrl: "https://llm.example/v1",
    secretRef: "TEST_PROVIDER_KEY",
    authType: "bearer",
    apiFormat: "openai",
    timeoutMs: 5000,
    maxTokensDefault: 1024,
    defaultTemperature: 0.2,
    rateLimitPerMinute: 60,
    active: true,
    createdAt: "",
    updatedAt: "",
  };

  it("short-circuits without a key and reports readiness", async () => {
    expect(providerReadiness(base).ready).toBe(false);
    const r = await testProviderConnection(base, { fetchImpl: (() => { throw new Error("must not be called"); }) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, checked: false, keyPresent: false });
  });

  it("calls the model catalog with the bearer key and surfaces model ids", async () => {
    process.env.TEST_PROVIDER_KEY = "k-123";
    let seen: { url: string; auth: string | null } | undefined;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
      return new Response(JSON.stringify({ data: [{ id: "m-1" }, { id: "m-2" }] }), { status: 200 });
    }) as typeof fetch;
    const r = await testProviderConnection(base, { fetchImpl });
    expect(seen).toEqual({ url: "https://llm.example/v1/models", auth: "Bearer k-123" });
    expect(r).toMatchObject({ ok: true, checked: true, status: 200, models: ["m-1", "m-2"] });
  });

  it("explains 401s from the provider", async () => {
    process.env.TEST_PROVIDER_KEY = "bad";
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })) as unknown as typeof fetch;
    const r = await testProviderConnection(base, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.message).toMatch(/Incorrect API key/);
    expect(r.hint).toMatch(/TEST_PROVIDER_KEY/);
  });
});
