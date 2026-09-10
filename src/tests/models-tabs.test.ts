import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";

let cleanup: (() => void) | undefined;
let app: FastifyInstance;
let container: Container;
let baseUrl: string;

const PROVIDER = "provider-mock";
const CAPS = { vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true };

function seedModels(n: number): string[] {
  const now = new Date().toISOString();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `model-tabqa-${i}`;
    container.modelRepo.upsert({
      id, providerId: PROVIDER, modelId: `tabqa-${i}`, displayName: `TabQA ${i}`,
      contextWindow: 128000, inputCostPer1k: 0, outputCostPer1k: 0, capabilities: { ...CAPS },
      active: true, priority: 100, fallbackPriority: 100, tags: ["tabqa"],
      createdAt: now, updatedAt: now,
    });
    ids.push(id);
  }
  return ids;
}

function seedBench(modelId: string, kind: "all-error" | "half-error" | "all-good" | "inactive-error", inactive = false) {
  if (inactive) {
    const row = container.modelRepo.findById(modelId);
    if (row) container.modelRepo.upsert({ ...row.data, active: false, updatedAt: new Date().toISOString() });
  }
  for (let i = 0; i < 4; i++) {
    const isErr = kind === "all-error" || kind === "inactive-error" ? true : kind === "half-error" ? i % 2 === 0 : false;
    container.benchRepo.record({
      benchmarkRunId: "run-tabqa", modelId, providerId: PROVIDER,
      problemId: `p-${i}`, problemKind: "arithmetic",
      question: "1+1", expectedAnswer: "2",
      modelAnswer: isErr ? "" : "2", correct: !isErr, answered: !isErr,
      latencyMs: 50, inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0,
      ...(isErr ? { error: kind === "inactive-error" ? "HTTP 500 boom" : "timeout after 60000ms" } : {}),
    });
  }
}

beforeAll(async () => {
  delete process.env.REQUIRE_AUTH;
  getEnvFresh();
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  const ids = seedModels(30);
  seedBench(ids[0], "all-error");
  seedBench(ids[1], "half-error");
  seedBench(ids[2], "all-good");
  seedBench(ids[3], "inactive-error", true);
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
  const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));
  await settle(1500);
  const doc = win.document;
  return { win, doc, errors, settle };
}

describe("models tabs + pagination + unresponsive", () => {
  it("stats endpoint includes inactive models and lastError", async () => {
    const r = await fetch(`${baseUrl}/models/benchmark/stats`).then((x) => x.json());
    const ids = (r.stats as any[]).map((s) => s.modelId);
    expect(ids).toContain("model-tabqa-0");
    expect(ids).toContain("model-tabqa-3"); // inactive but must show for cleanup
    const bad = (r.stats as any[]).find((s) => s.modelId === "model-tabqa-0");
    expect(bad.errorRate).toBe(1);
    expect(bad.lastError).toMatch(/timeout/);
  });

  it("renders tabs with a paginated models list", async () => {
    const { win, doc, errors, settle } = await boot();
    await settle(1200);
    const tabs = doc.querySelectorAll(".models-tabs .tab");
    expect(tabs.length).toBe(3);
    const labels = [...tabs].map((t: any) => t.textContent);
    expect(labels.join("|")).toMatch(/Models/);
    expect(labels.join("|")).toMatch(/Benchmark/);
    expect(labels.join("|")).toMatch(/Unresponsive/);
    // 33 models (30 + 3 seeds), 24 per page → pager visible, page 1 shows 24 cards
    const pager = doc.querySelector("#model-pager .pager");
    expect(pager, "models pager rendered").toBeTruthy();
    expect(pager.textContent).toMatch(/of\s*33/);
    expect(doc.querySelectorAll("#model-groups .model-card").length).toBe(24);
    // page 2 → remaining 9 cards
    win.modelsPager(2);
    expect(doc.querySelectorAll("#model-groups .model-card").length).toBe(9);
    expect(doc.querySelector("#model-pager .pager")?.textContent).toMatch(/25–33/);
    // search narrows + resets to page 1
    win.modelSearch("TabQA 1");
    expect(doc.querySelector("#model-search-summary")?.textContent).toMatch(/Showing 12 of 33/);
    win.modelSearchClear();
    expect(doc.querySelectorAll("#model-groups .model-card").length).toBe(24);
    expect(errors).toEqual([]);
  });

  it("benchmark tab shows a paginated ranking", async () => {
    const { win, doc, errors, settle } = await boot();
    win.modelsSwitchTab("benchmark");
    await settle(1500);
    const card = doc.querySelector("#model-bench-card");
    expect(card?.textContent).toMatch(/ranked by composite score/);
    // 4 stats, 15 per page → pager exists, all 4 rows shown
    const rows = doc.querySelectorAll("#model-bench-card tbody tr");
    expect(rows.length).toBe(4);
    expect(card?.textContent).toMatch(/Re-run benchmark/);
    // filter narrows the ranking
    win.benchSearch("tabqa-0");
    const rows2 = doc.querySelectorAll("#model-bench-card tbody tr");
    expect(rows2.length).toBe(1);
    win.benchSearchClear();
    expect(errors).toEqual([]);
  });

  it("unresponsive tab lists failing models and bulk-deletes them", async () => {
    const { win, doc, errors, settle } = await boot();
    win.modelsSwitchTab("unresponsive");
    await settle(1500);
    const bodyText = () => doc.querySelector("#models-tab-body")?.textContent ?? "";
    // default ≥50%: all-error + half-error + inactive-error = 3 rows
    expect(doc.querySelectorAll("#models-tab-body tbody tr").length).toBe(3);
    expect(bodyText()).toMatch(/3 of 33/);
    expect(bodyText()).toMatch(/timeout after 60000ms/);
    expect(bodyText()).toMatch(/HTTP 500 boom/);
    // 100% threshold → all-error + inactive-error = 2 rows
    win.unrespThresholdSet(1);
    expect(doc.querySelectorAll("#models-tab-body tbody tr").length).toBe(2);
    // include untested → +29 untested = 31 rows, paginated at 15
    win.unrespUntestedSet(true);
    expect(doc.querySelectorAll("#models-tab-body tbody tr").length).toBe(15);
    expect(doc.querySelector("#models-tab-body .pager")?.textContent).toMatch(/of\s*31/);
    win.unrespUntestedSet(false);
    // delete the two 100%-error models via checkbox selection
    win.unrespSelectAll();
    expect(doc.querySelector("#unresp-sel-count")?.textContent).toMatch(/2/);
    await win.unrespBulk("delete");
    await settle(1500);
    // list recomputed: 0 rows at 100% now
    expect(bodyText()).toMatch(/No unresponsive models/);
    const models = await fetch(`${baseUrl}/models`).then((x) => x.json());
    const ids = (models as any[]).map((m) => m.id);
    expect(ids).not.toContain("model-tabqa-0");
    expect(ids).not.toContain("model-tabqa-3");
    // their benchmark history was purged too
    const stats = await fetch(`${baseUrl}/models/benchmark/stats`).then((x) => x.json());
    expect((stats.stats as any[]).map((s) => s.modelId)).not.toContain("model-tabqa-0");
    expect(errors).toEqual([]);
  });
});
