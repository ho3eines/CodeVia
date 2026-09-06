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
type El = { textContent: string | null; querySelectorAll(sel: string): { length: number } & Iterable<El>; querySelector(sel: string): El | null; hidden: boolean; dataset: Record<string, string | undefined>; click(): void; hasAttribute(a: string): boolean; getAttribute(a: string): string | null; dispatchEvent(e: unknown): boolean };

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

  it("renders project detail tabs and operational controls", async () => {
    const project = await container.agentManager.createProject({
      name: "Project Detail QA",
      description: "Seeded by the UI test to verify project sub-pages.",
      configRepo: "acme/project-detail-qa",
      branch: "main",
      framework: "Node.js",
      database: "PostgreSQL",
    });
    const { go } = await boot();
    for (const suffix of ["", "/agents", "/repositories", "/workflows", "/tasks", "/runs", "/tests", "/issues", "/pull-requests", "/skills", "/memory"]) {
      const content = await go(`#/projects/${project.id}${suffix}`);
      const text = content.textContent ?? "";
      expect(text, `project route ${suffix || "/"} rendered an error state`).not.toMatch(/Something went wrong/);
      expect(text).toContain("Project Detail QA");
      expect(content.querySelectorAll(".project-tabs .tab").length).toBeGreaterThanOrEqual(10);
      expect(text).toContain("Ask AI");
      expect(text).toContain("Edit");
    }
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

  it("switches and persists the dark/light theme", async () => {
    const { win } = await boot();
    const root = win.document.documentElement;
    expect(root.getAttribute("data-theme")).toBe("dark");

    // The sidebar exposes an explicit two-option switch, not a blind toggle.
    (win.document.querySelector('[data-theme-set="light"]') as El).click();
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(win.localStorage.getItem("cv-theme")).toBe("light");

    (win.document.querySelector('[data-theme-set="dark"]') as El).click();
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(win.localStorage.getItem("cv-theme")).toBe("dark");
  }, 30000);

  it("keeps the live pill's status dot intact when connectivity flips", async () => {
    const { win } = await boot();
    const pill = win.document.querySelector("#live-pill") as El;
    // Regression: the old code wrote the label into the pill's *last span*,
    // which is the status dot — flipping connectivity destroyed the indicator.
    win.setLivePill(false);
    expect(pill.querySelectorAll(".dot").length).toBe(1);
    expect((pill.querySelector("#live-label") as El).textContent).toBe("Offline");
    expect(pill.getAttribute("class")).toContain("offline");

    win.setLivePill(true);
    expect(pill.querySelectorAll(".dot").length).toBe(1);
    expect((pill.querySelector("#live-label") as El).textContent).toBe("Live");
    expect(pill.getAttribute("class")).not.toContain("offline");
  }, 30000);
});

describe("theming", () => {
  const css = readFileSync(resolve(process.cwd(), "public", "app.css"), "utf8");

  /** Pull the custom-property block for a theme selector. */
  function tokensFor(selector: string): Record<string, string> {
    const i = css.indexOf(selector);
    expect(i, `${selector} block is missing`).toBeGreaterThan(-1);
    const block = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/([a-z-]+(?:-[a-z0-9]+)*)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
    return out;
  }

  it("defines a complete, independent light palette", () => {
    const dark = tokensFor(':root,\n[data-theme="dark"]');
    const light = tokensFor('[data-theme="light"]');
    // Light mode must redefine the colour-bearing tokens rather than inherit
    // dark values, otherwise it reads as a washed-out dark theme.
    for (const key of ["--bg", "--text", "--text-muted", "--surface", "--stroke", "--primary", "--ok", "--warn", "--err", "--glass"]) {
      expect(light[key], `light mode is missing ${key}`).toBeTruthy();
      expect(light[key], `${key} is identical in both themes`).not.toBe(dark[key]);
    }
    expect(light["color-scheme"]).toBe("light");
    expect(dark["color-scheme"]).toBe("dark");
  });

  it("keeps body text readable against the canvas in both themes", () => {
    const hex = (v: string) => {
      const m = /#([0-9a-f]{6})/i.exec(v);
      if (!m) throw new Error("not a hex colour: " + v);
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    // WCAG relative luminance + contrast ratio.
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    for (const sel of [':root,\n[data-theme="dark"]', '[data-theme="light"]']) {
      const t = tokensFor(sel);
      expect(ratio(t["--text"], t["--bg"]), `--text on --bg in ${sel}`).toBeGreaterThan(7);
      expect(ratio(t["--text-muted"], t["--bg"]), `--text-muted on --bg in ${sel}`).toBeGreaterThan(4.5);
    }
  });

  it("routes palette actions to theme changes instead of navigation", async () => {
    const { win } = await boot();
    win.setTheme("light", false);
    expect(win.document.documentElement.getAttribute("data-theme")).toBe("light");
    win.setTheme("dark", false);
    expect(win.document.documentElement.getAttribute("data-theme")).toBe("dark");
    // an unknown value must be ignored rather than corrupting the attribute
    win.setTheme("neon", false);
    expect(win.document.documentElement.getAttribute("data-theme")).toBe("dark");
  }, 30000);
});

describe("dialogs and navigation drawer", () => {
  it("closes dialogs only via the × button or Escape, never an outside click", async () => {
    const { win } = await boot();
    const backdrop = win.document.querySelector("#modal-backdrop") as El;

    win.openModal("Edit provider", "<input id='draft' value='half-typed'/>");
    expect(backdrop.hasAttribute("hidden")).toBe(false);

    // A click on the backdrop itself must NOT discard the form.
    backdrop.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(backdrop.hasAttribute("hidden"), "outside click closed the dialog").toBe(false);
    expect((win.document.querySelector("#draft") as El).getAttribute("value")).toBe("half-typed");

    // The × button closes it.
    (win.document.querySelector("#modal-close") as El).click();
    expect(backdrop.hasAttribute("hidden")).toBe(true);
  }, 30000);

  it("unwinds stacked layers one at a time with Escape", async () => {
    const { win } = await boot();
    const esc = () => win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const hidden = (id: string) => (win.document.querySelector(id) as El).hasAttribute("hidden");

    win.openModal("Form", "<p>body</p>");
    win.showTestVerdict({ ok: true, message: "All good" }, { title: "Passed" });
    expect(hidden("#verdict-backdrop")).toBe(false);
    expect(hidden("#modal-backdrop")).toBe(false);

    esc(); // closes the verdict only
    expect(hidden("#verdict-backdrop")).toBe(true);
    expect(hidden("#modal-backdrop"), "Escape closed both layers at once").toBe(false);

    esc(); // now closes the form
    expect(hidden("#modal-backdrop")).toBe(true);
  }, 30000);

  it("opens and closes the mobile drawer from every affordance", async () => {
    const { win } = await boot();
    const sidebar = win.document.querySelector("#sidebar") as El;
    const scrim = win.document.querySelector("#sidebar-scrim") as El;
    const isOpen = () => (sidebar.getAttribute("class") ?? "").includes("open");

    // menu button opens, scrim becomes available
    (win.document.querySelector("#menu-toggle") as El).click();
    expect(isOpen()).toBe(true);
    expect(scrim.hasAttribute("hidden")).toBe(false);

    // the scrim closes it (this is what RTL users had no way to do)
    scrim.click();
    expect(isOpen()).toBe(false);
    expect(scrim.hasAttribute("hidden")).toBe(true);

    // the × inside the drawer closes it
    (win.document.querySelector("#menu-toggle") as El).click();
    expect(isOpen()).toBe(true);
    (win.document.querySelector("#sidebar-close") as El).click();
    expect(isOpen()).toBe(false);

    // Escape closes it
    (win.document.querySelector("#menu-toggle") as El).click();
    expect(isOpen()).toBe(true);
    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isOpen()).toBe(false);
  }, 30000);

  it("pins the drawer to the inline-start edge so RTL can reach it", () => {
    const css = readFileSync(resolve(process.cwd(), "public", "app.css"), "utf8");
    const block = css.slice(css.indexOf("@media (max-width: 900px)", css.indexOf("30. Responsive")));
    // Without an explicit inline-start offset a fixed drawer keeps its static
    // position, which stranded the RTL menu off its edge and unreachable.
    expect(block).toMatch(/\.sidebar\s*{[^}]*inset-inline-start:\s*0/);
    expect(block).toMatch(/\[dir="rtl"\]\s*\.sidebar\s*{[^}]*translateX\(100%\)/);
  });
});

describe("test verdict dialog", () => {
  it("renders an animated tick with the model reply up front", async () => {
    const { win } = await boot();
    win.showTestVerdict(
      { ok: true, message: "Model responded", responseText: "OK", latencyMs: 412, status: 200 },
      { modelId: "gpt-4o-mini" },
    );
    const body = win.document.querySelector("#verdict-body") as El;
    expect(body.querySelectorAll(".verdict.ok").length).toBe(1);
    // the checkmark path, not the cross
    expect(body.querySelectorAll(".vm-path").length).toBe(1);
    expect((body.querySelector(".verdict-reply") as El).textContent).toContain("OK");
    const text = body.textContent ?? "";
    expect(text).toContain("412 ms");
    expect(text).toContain("gpt-4o-mini");
  }, 30000);

  it("renders a failure cross and tucks diagnostics away", async () => {
    const { win } = await boot();
    win.showTestVerdict({
      ok: false,
      message: "401 Unauthorized",
      hint: "Check that the API key is set.",
      status: 401,
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
    });
    const body = win.document.querySelector("#verdict-body") as El;
    expect(body.querySelectorAll(".verdict.err").length).toBe(1);
    expect((body.textContent ?? "")).toContain("401 Unauthorized");
    expect((body.querySelector(".verdict-hint") as El).textContent).toContain("Check that the API key is set.");
    // noisy endpoint list is collapsed, not dumped inline
    const details = body.querySelector(".verdict-details") as El;
    expect(details, "diagnostics should be collapsible").not.toBeNull();
    expect(details.textContent).toContain("api.openai.com");
  }, 30000);

  it("stacks over an open form without destroying it", async () => {
    const { win } = await boot();
    win.openModal("Add provider", "<input id='pv-name' value='My provider'/>");
    win.showTestPending("Testing connection", "Using the values in the form…");
    // the form modal is still mounted underneath with its value intact
    expect((win.document.querySelector("#modal-backdrop") as El).hasAttribute("hidden")).toBe(false);
    expect((win.document.querySelector("#pv-name") as El).getAttribute("value")).toBe("My provider");
    expect((win.document.querySelector("#verdict-body") as El).querySelectorAll(".verdict-spinner").length).toBe(1);

    win.closeVerdict();
    expect((win.document.querySelector("#verdict-backdrop") as El).hasAttribute("hidden")).toBe(true);
    expect((win.document.querySelector("#pv-name") as El).getAttribute("value")).toBe("My provider");
  }, 30000);
});

describe("link styling", () => {
  it("covers every anchor-based control with an explicit no-underline rule", async () => {
    // NOTE: getComputedStyle is useless here — jsdom does not apply the user
    // agent stylesheet that actually draws the underline, so it reports "none"
    // even when the rule is missing. The real guarantee is that each control
    // class an anchor can carry is named in the reset, so assert that directly.
    const { win, go } = await boot();
    await go("#/dashboard");

    const css = readFileSync(resolve(process.cwd(), "public", "app.css"), "utf8");
    // Only the base (non-:hover) reset counts: a rule that fires solely on
    // hover would still ship an underlined control at rest.
    const region = css.slice(css.indexOf("a { color: var(--primary)"), css.indexOf("hr {"));
    const resetBlock = region
      .split("}")
      .filter((rule) => rule.includes("text-decoration") && !rule.includes(":hover"))
      .join("}");

    const anchors = [...win.document.querySelectorAll("a[class]")] as El[];
    expect(anchors.length, "expected anchor-based controls to audit").toBeGreaterThan(3);
    for (const el of anchors) {
      const classes = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
      // A styled anchor is a control; at least one of its classes (or an
      // ancestor-scoped selector) must appear in the no-underline reset.
      const covered = classes.some((c) => resetBlock.includes(`a.${c}`) || resetBlock.includes(`.${c} a`));
      expect(covered, `<a class="${classes.join(" ")}"> is not covered by the underline reset`).toBe(true);
    }
  }, 30000);

  it("keeps the stylesheet free of per-component underline workarounds", () => {
    // The rule belongs in one place; scattered inline overrides mean a new
    // anchor-based component silently ships underlined.
    const js = readFileSync(resolve(process.cwd(), "public", "app.js"), "utf8");
    expect(js).not.toContain("text-decoration:none");

    const css = readFileSync(resolve(process.cwd(), "public", "app.css"), "utf8");
    // Base anchors opt out of decoration, and hover opts back in for prose.
    expect(css).toMatch(/\na \{[^}]*text-decoration:\s*none/);
    expect(css).toMatch(/\na:hover \{[^}]*text-decoration:\s*underline/);
  });
});
