import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Front-end shell smoke test. The SPA is a single large script driven
 * by hash routes; this boots it in jsdom against the real Fastify app
 * so a broken template literal or a renamed helper fails CI instead of
 * silently showing "Something went wrong" in the browser.
 * ------------------------------------------------------------------ */

const ROUTES = [
  "/dashboard", "/projects", "/agents", "/models", "/providers", "/skills",
  "/workflows", "/tasks", "/runs", "/approvals", "/logs", "/memory",
  "/github", "/telegram", "/settings", "/admin", "/search",
];

let cleanup: (() => void) | undefined;
let app: FastifyInstance;
let container: Container;
let baseUrl: string;

beforeAll(async () => {
  delete process.env.REQUIRE_AUTH;
  getEnvFresh();
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "http://127.0.0.1:3000";
}, 30000);

afterAll(async () => {
  await app?.close();
  cleanup?.();
});

/** Minimal structural stand-ins — tsconfig uses the Node lib, not DOM. */
type El = { textContent: string | null; querySelectorAll(sel: string): { length: number } & Iterable<El>; querySelector(sel: string): El | null; hidden: boolean; dataset: Record<string, string | undefined>; click(): void; hasAttribute(a: string): boolean; getAttribute(a: string): string | null };

/** Boot the SPA in jsdom and return helpers to drive it. */
async function boot() {
  const pub = resolve(process.cwd(), "public");
  const dom = new JSDOM(readFileSync(resolve(pub, "index.html"), "utf8"), {
    url: `${baseUrl}/#/dashboard`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, any>;
  // Route the SPA's relative fetches at the live test server.
  win.fetch = (u: string, o?: RequestInit) => fetch(new URL(String(u), baseUrl), o);
  const errors: string[] = [];
  win.console.error = (...a: unknown[]) => errors.push(a.join(" "));
  win.addEventListener("error", (e: { message: string }) => errors.push(e.message));
  win.eval(readFileSync(resolve(pub, "app.js"), "utf8"));
  const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
  await settle();
  const go = async (hash: string) => {
    win.location.hash = hash;
    win.dispatchEvent(new win.Event("hashchange"));
    await settle();
    return win.document.querySelector("#content") as El;
  };
  return { win, errors, go, settle };
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("UI shell", () => {
  it("renders every top-level route without an error state", async () => {
    const { go, errors } = await boot();
    for (const route of ROUTES) {
      const content = await go("#" + route);
      const text = content.textContent ?? "";
      expect(text, `route ${route} rendered an error state`).not.toMatch(/Something went wrong/);
      expect(content.querySelectorAll("*").length, `route ${route} rendered nothing`).toBeGreaterThan(3);
    }
    expect(errors).toEqual([]);
  }, 60000);

  it("draws SVG dashboard charts and opens the analytics modal", async () => {
    const { win, go } = await boot();
    const content = await go("#/dashboard");
    // line chart + donut are always present; the runs sparkline may be empty
    expect(content.querySelectorAll("svg.cv-chart").length).toBeGreaterThanOrEqual(2);

    win.openDashboardDetails();
    const body = win.document.querySelector("#modal-body") as El;
    expect(win.document.querySelector("#modal-backdrop")?.hasAttribute("hidden")).toBe(false);
    expect(body.querySelectorAll(".tab").length).toBe(3);

    // tab switching flips panel visibility without a re-render
    win.switchTab("dashx", "usage");
    const panels = [...body.querySelectorAll("[data-tab-panel]")] as El[];
    const usagePanel = panels.find((p) => p.dataset.tabPanel === "dashx:usage")!;
    expect(usagePanel.hidden).toBe(false);
    expect(panels.filter((p) => !p.hidden)).toHaveLength(1);
    win.closeModal();
    expect(win.document.querySelector("#modal-backdrop")?.hasAttribute("hidden")).toBe(true);
  }, 30000);

  it("exposes every admin area as a modal", async () => {
    const { win, go } = await boot();
    const content = await go("#/admin");
    expect(content.querySelectorAll(".admin-tile").length).toBe(6);
    for (const area of ["health", "usage", "auth", "users", "storage", "backup"]) {
      win.adminOpen(area);
      const body = win.document.querySelector("#modal-body") as El;
      expect((body.textContent ?? "").length, `admin modal ${area} was empty`).toBeGreaterThan(10);
      win.closeModal();
    }
  }, 30000);

  it("persists the dark/light theme choice", async () => {
    const { win } = await boot();
    const root = win.document.documentElement;
    expect(root.getAttribute("data-theme")).toBe("dark");
    (win.document.querySelector("#theme-toggle") as El).click();
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(win.localStorage.getItem("cv-theme")).toBe("light");
    (win.document.querySelector("#theme-toggle") as El).click();
    expect(root.getAttribute("data-theme")).toBe("dark");
  }, 30000);
});
