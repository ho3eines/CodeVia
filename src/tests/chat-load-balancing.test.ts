import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";
import { candidatesFor } from "../ai/model-router.js";

/* ------------------------------------------------------------------ *
 * Chat load distribution (end-to-end through the HTTP API).
 *
 * Reported symptom: "it always chats with one model" — with several registered
 * models, every message went to the same top-scored row, so one provider key
 * took all the traffic (and its rate limit) while the others idled. Chat now
 * goes through the load balancer: consecutive messages rotate over every
 * eligible model, and an explicitly chosen model still pins the answer.
 * ------------------------------------------------------------------ */

let cleanup: (() => void) | undefined;
let app: FastifyInstance;
let container: Container;

const CAPS = { vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true };

function seedChatModels(count: number): string[] {
  const now = new Date().toISOString();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `model-lb-${i}`;
    container.modelRepo.upsert({
      id,
      providerId: "provider-mock",
      modelId: `mock-lb-${i}`,
      displayName: `LB ${i}`,
      contextWindow: 128000,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      capabilities: { ...CAPS },
      active: true,
      priority: 100,
      fallbackPriority: 100,
      tags: ["lb"],
      createdAt: now,
      updatedAt: now,
    });
    ids.push(id);
  }
  return ids;
}

async function send(convId: string, body: Record<string, unknown>): Promise<string | undefined> {
  const res = await app.inject({ method: "POST", url: `/conversations/${convId}/messages`, payload: body });
  expect(res.statusCode).toBe(200);
  const conv = res.json() as { messages?: Array<{ role: string; metadata?: { modelId?: string; error?: boolean } }> };
  const answers = (conv.messages ?? []).filter((m) => m.role === "assistant" && !m.metadata?.error);
  return answers[answers.length - 1]?.metadata?.modelId;
}

beforeAll(async () => {
  delete process.env.REQUIRE_AUTH;
  getEnvFresh();
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
}, 30000);

beforeEach(() => {
  // Each case starts from an even playing field: no rotation history, no
  // cooldowns from a previous test.
  container.loadBalancer.reset();
});

afterAll(async () => {
  await app?.close();
  cleanup?.();
});

describe("chat rotates across the registered models", () => {
  it("successive messages in one conversation use different models", async () => {
    // Start from exactly three models: the seeded mock defaults would otherwise
    // join the pool and (correctly) take part of the traffic.
    for (const id of container.modelRepo.findMany().map((r) => r.data.id)) container.modelRepo.deleteById(id);
    const ids = seedChatModels(3);
    const conv = await app.inject({ method: "POST", url: "/conversations", payload: { title: "LB chat" } });
    const convId = conv.json().id as string;

    const used: (string | undefined)[] = [];
    for (let i = 0; i < 6; i++) used.push(await send(convId, { content: `question ${i}`, role: "user" }));

    // Every model answered at least once — nobody is idle, nobody is hot.
    expect(new Set(used).size).toBe(3);
    for (const id of ids) expect(used).toContain(id);
    // And no model took more than a third plus one of the traffic.
    for (const id of ids) expect(used.filter((u) => u === id).length).toBeLessThanOrEqual(2);
  });

  it("a model the user picked in the chat UI stays pinned", async () => {
    seedChatModels(3);
    const conv = await app.inject({ method: "POST", url: "/conversations", payload: { title: "Pinned chat" } });
    const convId = conv.json().id as string;
    for (let i = 0; i < 3; i++) {
      expect(await send(convId, { content: `hi ${i}`, role: "user", modelId: "model-lb-2" })).toBe("model-lb-2");
    }
    // Choosing "Auto" again clears the pin, so distribution resumes.
    expect(await send(convId, { content: "auto now", role: "user", modelId: "" })).toBeDefined();
    const after = await app.inject({ method: "GET", url: `/conversations/${convId}` });
    expect(after.json().modelId ?? "").toBe("");
    const others = new Set<string>();
    for (let i = 0; i < 3; i++) others.add((await send(convId, { content: `free ${i}`, role: "user" }))!);
    expect(others.size).toBeGreaterThan(1);
  });

  it("a single-model installation keeps answering (nothing is ever dropped)", async () => {
    for (const id of container.modelRepo.findMany().map((r) => r.data.id)) container.modelRepo.deleteById(id);
    seedChatModels(1);
    const conv = await app.inject({ method: "POST", url: "/conversations", payload: { title: "Solo" } });
    const convId = conv.json().id as string;
    for (let i = 0; i < 2; i++) expect(await send(convId, { content: `only ${i}`, role: "user" })).toBe("model-lb-0");
  });

  it("the streaming endpoint rotates too and reports the answering model", async () => {
    container.loadBalancer.configure({ policy: "round-robin" });
    for (const id of container.modelRepo.findMany().map((r) => r.data.id)) container.modelRepo.deleteById(id);
    seedChatModels(3);
    const conv = await app.inject({ method: "POST", url: "/conversations", payload: { title: "Stream LB" } });
    const convId = conv.json().id as string;
    const metas: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/conversations/${convId}/messages/stream`,
        payload: { content: `stream ${i}`, role: "user" },
      });
      const meta = /"type":"meta"[^\n]*/.exec(res.body);
      const modelId = meta ? /"modelId":"([^"]+)"/.exec(meta[0])?.[1] : undefined;
      if (modelId) metas.push(modelId);
    }
    expect(new Set(metas).size).toBe(metas.length);
    expect(metas.length).toBe(3);
    container.loadBalancer.configure({ policy: "adaptive" });
  });
});

describe("routing policy API", () => {
  it("exposes live distribution and lets the operator switch the policy", async () => {
    seedChatModels(2);
    const before = await app.inject({ method: "GET", url: "/models/routing" });
    expect(before.statusCode).toBe(200);
    const view = before.json() as { policy: string; policies: string[]; models: Array<{ modelId: string }> };
    expect(view.policies).toContain("round-robin");
    expect(view.policy).toBe("adaptive");

    const changed = await app.inject({ method: "PATCH", url: "/models/routing", payload: { policy: "least-loaded", maxConcurrencyPerModel: 2 } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().config.policy).toBe("least-loaded");
    expect(container.loadBalancer.config()).toMatchObject({ policy: "least-loaded", maxConcurrencyPerModel: 2 });

    const rejected = await app.inject({ method: "PATCH", url: "/models/routing", payload: { policy: "vibes" } });
    expect(rejected.statusCode).toBe(400);
    expect(container.loadBalancer.config().policy).toBe("least-loaded");

    // Persisted: the policy survives a restart of the process.
    container.loadBalancer.reset();
    expect(container.kv.get<{ policy: string }>("model-routing-config")?.policy).toBe("least-loaded");

    await app.inject({ method: "PATCH", url: "/models/routing", payload: { policy: "adaptive", maxConcurrencyPerModel: 0 } });
  });

  it("model rows carry their own weight and concurrency ceiling", async () => {
    seedChatModels(1);
    const patched = await app.inject({
      method: "PATCH",
      url: "/models/model-lb-0",
      payload: { loadWeight: 2.5, maxConcurrency: 3 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ loadWeight: 2.5, maxConcurrency: 3 });
    const cleared = await app.inject({ method: "PATCH", url: "/models/model-lb-0", payload: { loadWeight: null, maxConcurrency: null } });
    expect(cleared.json().loadWeight).toBeUndefined();
    expect(cleared.json().maxConcurrency).toBeUndefined();
    const bad = await app.inject({ method: "PATCH", url: "/models/model-lb-0", payload: { loadWeight: 99 } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("agent runs share the load but stay consistent inside one run", () => {
  it("different runs land on different models; steps of one run stay on theirs", () => {
    for (const id of container.modelRepo.findMany().map((r) => r.data.id)) container.modelRepo.deleteById(id);
    seedChatModels(3);
    container.loadBalancer.configure({ policy: "round-robin" });
    const models = candidatesFor(container.modelRepo.listActiveForOwner(undefined), () => undefined);
    const picks: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ask = () =>
        container.modelRouter.route(
          models,
          { primary: "", fallbacks: [], specialized: {} },
          "coding",
          { balance: { scope: "owner:platform:coding", affinityKey: `run:task-${i}`, affinityTtlMs: 600000 } },
          [],
        );
      const chosen = ask()[0].id;
      picks.push(chosen);
      // Committing the pick for the run is what the agent session does per call.
      container.loadBalancer.begin(chosen, { scope: "owner:platform:coding", affinityKey: `run:task-${i}` }).finish(true);
      // The next step of the SAME run keeps the same model — no mid-run voice switch.
      expect(ask()[0].id).toBe(chosen);
    }
    // Different runs, different models: the load is spread over the registry.
    expect(new Set(picks).size).toBe(3);
    container.loadBalancer.configure({ policy: "adaptive" });
  });
});
