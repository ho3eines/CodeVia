import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Load-distribution panel on the Models page (jsdom, same harness as the
 * other Models tests): the operator must be able to see who is receiving
 * traffic and switch the policy without editing environment variables.
 * ------------------------------------------------------------------ */

let cleanup: (() => void) | undefined;
let app: FastifyInstance;
let container: Container;
let baseUrl: string;

const CAPS = { vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true };

beforeAll(async () => {
  delete process.env.REQUIRE_AUTH;
  getEnvFresh();
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i++) {
    container.modelRepo.upsert({
      id: `model-ui-lb-${i}`, providerId: "provider-mock", modelId: `ui-lb-${i}`, displayName: `Chat Rotate ${i}`,
      contextWindow: 128000, inputCostPer1k: 0, outputCostPer1k: 0, capabilities: { ...CAPS },
      active: true, priority: 100, fallbackPriority: 100, tags: ["lb-ui"], createdAt: now, updatedAt: now,
    });
  }
  // Three routed calls so the table has live numbers to show.
  for (let i = 0; i < 3; i++) {
    container.loadBalancer.begin(`model-ui-lb-${i}`, { scope: "owner:platform" }).finish(i !== 2);
  }
  app = (await buildServer(container)).app;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "http://127.0.0.1:3000";
}, 30000);

afterAll(async () => {
  await app?.close();
  cleanup?.();
});

async function boot() {
  const pub = resolve(process.cwd(), "public");
  const dom = new JSDOM(readFileSync(resolve(pub, "index.html"), "utf8"), {
    url: `${baseUrl}/#/models`, runScripts: "outside-only", pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, any>;
  win.fetch = (u: string, o?: RequestInit) => fetch(new URL(String(u), baseUrl), o);
  const errors: string[] = [];
  win.console.error = (...a: unknown[]) => errors.push(a.join(" "));
  win.addEventListener("error", (e: { message: string }) => errors.push(e.message));
  win.confirm = () => true;
  win.eval(readFileSync(resolve(pub, "app.js"), "utf8"));
  await new Promise((r) => setTimeout(r, 1500));
  return { win, doc: win.document as Document, errors, settle: (ms = 900) => new Promise((r) => setTimeout(r, ms)) };
}

describe("Models → load distribution panel", () => {
  it("shows the policy, the per-model traffic share and the error state", async () => {
    const { win, doc, errors, settle } = await boot();
    win.modelsSwitchTab("benchmark");
    await settle(900);

    const card = doc.querySelector("#model-routing-card");
    expect(card, "routing card rendered in the smart-routing tab").toBeTruthy();
    expect(card?.textContent).toMatch(/Load distribution/);
    const select = doc.querySelector("#model-routing-card select") as HTMLSelectElement | null;
    expect(select, "policy selector").toBeTruthy();
    expect(select?.value).toBe("adaptive");
    // One row per active model, with the traffic share of the three routed calls.
    const rows = doc.querySelectorAll("#model-routing-card table tbody tr");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(card?.textContent).toMatch(/available|at capacity/);
    // The model that answered with an error shows its streak instead of being hidden.
    expect(doc.querySelector("#model-routing-card")?.textContent).toMatch(/recent error|cooling|available/);
    expect(errors).toEqual([]);
  });

  it("switching the policy from the panel updates the router", async () => {
    const { win, settle } = await boot();
    win.modelsSwitchTab("benchmark");
    await settle(800);
    win.routingPolicySet("round-robin");
    await settle(900);
    expect(container.loadBalancer.config().policy).toBe("round-robin");
    const after = await fetch(`${baseUrl}/models/routing`).then((r) => r.json());
    expect(after.policy).toBe("round-robin");
    expect(after.models.find((m: any) => m.displayName === "Chat Rotate 0")).toBeTruthy();
    win.routingPolicySet("adaptive");
    await settle(600);
  });
});
