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
type El = { className: string; textContent: string | null; querySelectorAll(sel: string): { length: number } & Iterable<El>; querySelector(sel: string): El | null; hidden: boolean; dataset: Record<string, string | undefined>; click(): void; hasAttribute(a: string): boolean; getAttribute(a: string): string | null; dispatchEvent(e: unknown): boolean };

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
    // Give async route handlers (chat mount, sub-resource fetches) time to settle.
    // Chat tab does parallel fetches for conversations/models/agents/benchmark so
    // a longer settle is needed on first project navigation.
    await settle(1800);
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

  it("wires every project action-bar button to a complete, callable handler", async () => {
    const project = await container.agentManager.createProject({
      name: "Action Bar QA",
      description: "Seeded to verify the project toolbar buttons actually fire.",
      configRepo: "acme/action-bar-qa",
      branch: "main",
    });
    const { win, go } = await boot();
    const content = await go(`#/projects/${project.id}`);
    const bar = content.querySelector(".action-row") as El;
    expect(bar, "project action bar rendered").toBeTruthy();
    const buttons = [...bar.querySelectorAll("button")] as Array<El & { textContent: string | null; getAttribute(a: string): string | null; click(): void }>;
    // ❓ Ask AI · ▶ Run Agent · ＋ Create Task · 🔀 Run Workflow · 🧪 Dry Run · 📏 Rules
    // ↻ Load / fill missing · ⬇ Pull · 📱 Telegram · ⇩ Export · ⇧ Import · ⏸ Deactivate · ⚙ Edit
    expect(buttons.length).toBeGreaterThanOrEqual(13);
    const called = new Map<string, unknown[]>();
    for (const btn of buttons) {
      const attr = btn.getAttribute("onclick");
      expect(attr, `button "${btn.textContent?.trim()}" has an onclick handler`).toBeTruthy();
      // Regression: an unescaped ${JSON.stringify(id)} inside the double-quoted
      // onclick attribute made the HTML parser truncate the handler (e.g. to
      // `projectRun(`), so the click threw a SyntaxError and nothing happened.
      const m = /^([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/.exec(attr!);
      expect(m, `handler for "${btn.textContent?.trim()}" is a complete call, got: ${attr}`).toBeTruthy();
      const fn = m![1];
      const original = win[fn];
      expect(typeof original, `${fn} is defined on window`).toBe("function");
      let args: unknown[] | undefined;
      win[fn] = (...a: unknown[]) => { args = a; called.set(fn, a); };
      // jsdom with runScripts:"outside-only" never executes inline handler
      // attributes on click, so run the exact code the browser would run.
      // With the old truncated markup this throws a SyntaxError instead.
      try { win.eval(attr!); } finally { win[fn] = original; }
      expect(args, `${fn} was invoked by clicking "${btn.textContent?.trim()}"`).toBeDefined();
      expect(args![0], `${fn} receives the project id`).toBe(project.id);
    }
    // The toggle button passes the *next* active state as a plain boolean.
    const toggle = called.get("projectToggleActive");
    expect(toggle, "projectToggleActive fired").toBeTruthy();
    expect(typeof toggle![1]).toBe("boolean");
    expect(toggle![1]).toBe(!project.active);
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
    // All legacy deep links must render; top-level tabs are now Chat/Project/Settings (3)
    // but sub-resource pages (agents/tasks/...) reuse the Settings tab and render their own content card.
    for (const suffix of ["", "/project", "/settings", "/agents", "/repositories", "/workflows", "/tasks", "/runs", "/tests", "/issues", "/pull-requests", "/skills", "/memory"]) {
      const content = await go(`#/projects/${project.id}${suffix}`);
      const text = content.textContent ?? "";
      if (!content.querySelector(".project-tabs")) {
        console.error(`route ${suffix || "/"} missing tabs; content preview:`, (content as any).innerHTML?.slice(0, 500));
      }
      expect(text, `project route ${suffix || "/"} rendered an error state`).not.toMatch(/Something went wrong/);
      expect(text).toContain("Project Detail QA");
      // Top-level tab count is now 3 (Chat/Project/Settings); deep links land on Settings for legacy sections
      const topTabs = content.querySelectorAll(".project-tabs .tab");
      expect(topTabs.length).toBeGreaterThanOrEqual(3);
      expect(text).toContain("Ask AI");
    }
  }, 60000);

  it("shows the planned owners, criteria and task-local skills in task details and run evidence", async () => {
    const project = await container.agentManager.createProject({ name: "Skill Trace UI", description: "Store", configRepo: "acme/skill-trace-ui", capabilities: { platforms: ["web"], languages: ["typescript"], frameworks: ["react"] } });
    const task = container.agentManager.createTask({ projectId: project.id, title: "Add login page and API", description: "Session login", input: { executionMode: "autonomous" } });
    await container.agentManager.runTask(task.id);
    const child = container.taskRepo.findMany({ parentId: task.id }).find((r) => r.data.agentType === "frontend-developer")!.data;
    const { win, go, errors } = await boot();
    await win.projectViewTask(task.id);
    expect(win.document.querySelector(".task-plan").textContent).toContain("frontend-developer");
    expect(win.document.querySelector("#modal-body").textContent).toContain("Skills");
    const childButton = [...win.document.querySelectorAll("#modal-body button")].find((el: any) => el.getAttribute("onclick")?.includes(child.id)) as any;
    expect(childButton.getAttribute("onclick")).toBe(`projectViewTask(${JSON.stringify(child.id)})`);
    await win.projectViewTask(child.id);
    const modal = win.document.querySelector("#modal-body");
    expect(modal.textContent).toContain(child.assignedAgentId);
    expect(modal.querySelector(".task-criteria").textContent).toContain("Acceptance criteria");
    expect(modal.querySelector(".task-skills").textContent).toContain("React");
    expect(modal.querySelector(".task-skills").textContent).toContain("Task application");
    expect(modal.querySelector(".task-skills").textContent).not.toContain("Blazor");
    win.closeModal();
    const run = container.runRepo.byTask(child.id)[0];
    const content = await go(`#/runs/${run.id}/console`);
    expect(content.querySelector(".task-skills")?.textContent).toContain("Base instructions");
    expect(errors).toEqual([]);
    win.close();
  }, 30000);

  it("auto-detects Persian text direction in the model chat", async () => {
    const { win, go, settle } = await boot();
    await go("#/models");
    const models = await fetch(`${baseUrl}/models`).then((r) => r.json() as Promise<Array<{ id: string; providerId: string }>>);
    const mock = models.find((m) => m.providerId === "provider-mock") ?? models[0];
    expect(mock).toBeTruthy();

    win.openModelChat(mock.id);
    const input = win.document.querySelector("#chat-input") as any;
    input.value = "سلام، لطفاً وضعیت پروژه را بررسی کن";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(input.getAttribute("dir")).toBe("rtl");

    (win.document.querySelector("#chat-send") as El).click();
    await settle(1200);
    const userBubble = win.document.querySelector(".chat-msg.user") as El;
    expect(userBubble.getAttribute("dir")).toBe("rtl");
    expect((userBubble.querySelector(".chat-text") as El).getAttribute("dir")).toBe("rtl");
    expect(userBubble.textContent).toContain("سلام");
  }, 30000);

  it("keeps mixed English/Persian replies readable (direction follows the first strong character)", async () => {
    const { win, go, settle } = await boot();
    // jsdom's AbortController is not a Node AbortSignal, so feed the stream
    // route a canned SSE reply instead of hitting the live mock.
    const realFetch = win.fetch;
    const reply = "[Mock Assistant]\nReceived: متن تست test میباشد\n\nThis is a simulated response";
    win.fetch = (u: string, o?: RequestInit) => {
      if (String(u).includes("/stream")) {
        const sse = [
          `data: ${JSON.stringify({ type: "delta", text: reply })}`,
          "",
          `data: ${JSON.stringify({ type: "done", text: reply, latencyMs: 12, status: 200 })}`,
          "",
        ].join("\n");
        const enc = new TextEncoder();
        let sent = false;
        return Promise.resolve({
          ok: true,
          statusText: "OK",
          body: {
            getReader: () => ({
              read: async () => {
                if (sent) return { done: true };
                sent = true;
                return { done: false, value: enc.encode(sse) };
              },
            }),
          },
        });
      }
      return realFetch(u, o);
    };
    // jsdom lacks TextDecoder; the SPA decodes SSE chunks with it.
    win.TextDecoder = TextDecoder;
    win.TextEncoder = TextEncoder;
    await go("#/models");
    const models = await fetch(`${baseUrl}/models`).then((r) => r.json() as Promise<Array<{ id: string; providerId: string }>>);
    const mock = models.find((m) => m.providerId === "provider-mock") ?? models[0];
    win.openModelChat(mock.id);
    const input = win.document.querySelector("#chat-input") as any;
    input.value = "متن تست test میباشد";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    (win.document.querySelector("#chat-send") as El).click();
    await settle(1200);

    // The user's own message is Persian-first: bubble stays RTL (right-aligned)
    // even with an embedded English word.
    const user = win.document.querySelector(".chat-msg.user") as El;
    expect(user.getAttribute("dir")).toBe("rtl");

    // The mock reply echoes the Persian phrase inside mostly-English text. Its
    // first strong character is Latin, so it must stay LTR (left-aligned and
    // readable) instead of being forced RTL by the Persian words in the middle.
    const assistant = [...win.document.querySelectorAll(".chat-msg.assistant")].pop() as El;
    expect(assistant.getAttribute("dir")).toBe("ltr");
    expect(assistant.textContent).toContain("متن تست");
    expect(assistant.textContent).toContain("[Mock Assistant]");
    win.close();
  }, 30000);

  it("keeps the AI bubble on the left (text right-aligned) and the send button clear of the right edge", async () => {
    const { win, go, settle } = await boot();
    await go("#/models");
    const models = await fetch(`${baseUrl}/models`).then((r) => r.json() as Promise<Array<{ id: string; providerId: string }>>);
    const mock = models.find((m) => m.providerId === "provider-mock") ?? models[0];
    win.openModelChat(mock.id);
    const input = win.document.querySelector("#chat-input") as any;
    input.value = "سلام، لطفاً وضعیت پروژه را بررسی کن";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    (win.document.querySelector("#chat-send") as El).click();
    await settle(1200);

    // Assistant bubble: pinned to the left side (iMessage style) while the
    // Persian text inside stays right-aligned.
    const assistant = win.document.querySelector(".chat-msg.assistant") as El;
    expect(assistant).toBeTruthy();
    // jsdom does not compute flex alignment from the stylesheet, so assert the
    // bubble side from the class contract: assistant stays flex-start (left),
    // user flex-end (right). The RTL class keeps Persian text right-aligned.
    expect(assistant.className).toContain("assistant");

    const user = win.document.querySelector(".chat-msg.user") as El;
    expect(user.className).toContain("user");
    expect(user.className).toContain("rtl");

    // Stylesheet contract: assistant bubbles are pinned left, the composer bar
    // keeps the send button clear of the right edge (away from the scrollbar).
    const css = readFileSync(resolve(process.cwd(), "public", "app.css"), "utf8");
    const alignRule = css.match(/\.chat-msg\.assistant\s*{[^}]*align-self:\s*flex-start/);
    expect(alignRule).toBeTruthy();
    const userAlign = css.match(/\.chat-msg\.user\s*{[^}]*align-self:\s*flex-end/);
    expect(userAlign).toBeTruthy();
    const barPad = css.match(/\.chat-composer-bar\s*{[^}]*padding:\s*[^;]*/);
    expect(barPad![0]).toMatch(/5px 12px/);
    const sendMargin = css.match(/\.chat-send-btn\s*{[^}]*margin-right:\s*2px/);
    expect(sendMargin).toBeTruthy();
  }, 30000);

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

  it("Done closes the verdict via closeVerdict, never closeModal", async () => {
    const { win } = await boot();
    // Regression: the verdict's Done button called closeModal(), which hides
    // the *form* modal underneath and left the verdict stuck open.
    win.openModal("Add provider", "<input id='pv-name' value='My provider'/>");
    win.showTestVerdict({ ok: true, message: "Provider reachable" }, { title: "✓ Provider reachable" });
    const hidden = (id: string) => (win.document.querySelector(id) as El).hasAttribute("hidden");

    const done = [...(win.document.querySelectorAll("#verdict-body button") as unknown as El[])].find(
      (b) => (b.textContent ?? "").trim() === "Done",
    );
    expect(done).toBeTruthy();
    // The bug: the button called closeModal() (hid the form, left the verdict
    // stuck). It must target the verdict's own layer.
    expect((done as El).getAttribute("onclick")).toBe("closeVerdict()");
    // jsdom's "outside-only" mode does not run inline handlers on .click(), so
    // execute the attribute exactly as the browser would.
    win.eval((done as El).getAttribute("onclick") as string);
    expect(hidden("#verdict-backdrop"), "Done must close the verdict").toBe(true);
    expect(hidden("#modal-backdrop"), "Done must NOT close the form underneath").toBe(false);
    expect((win.document.querySelector("#pv-name") as El).getAttribute("value")).toBe("My provider");
  }, 30000);
});

describe("no-reload refresh behavior", () => {
  it("never ships a full page reload anywhere in the SPA", () => {
    const js = readFileSync(resolve(process.cwd(), "public", "app.js"), "utf8");
    expect(js).not.toContain("location.reload");
    expect(js).not.toContain("location.reload(");
    expect(js).not.toContain(".reload()");
  });

  it("refreshCurrent is silent: it must not show the skeleton", async () => {
    const { win, go } = await boot();
    await go("#/providers");
    const content = win.document.querySelector("#content") as unknown as { innerHTML: string };
    const before = content.innerHTML ?? "";
    expect(before).toContain("provider-card"); // real content, not a skeleton

    // Spy on showSkeleton: a silent refresh must never call it. It is internal
    // to the IIFE, so detect it by watching the skeleton markup appearing.
    const p = win.refreshCurrent();
    expect(p && typeof p.then).toBe("function");
    await p;
    const after = content.innerHTML ?? "";
    // Content was refreshed (fresh fetch) but no skeleton placeholder remained.
    expect(after).toContain("provider-card");
    expect(after).not.toContain("skeleton-line");
  });

  it("retry button on the error state refreshes in place, not via reload", () => {
    const js = readFileSync(resolve(process.cwd(), "public", "app.js"), "utf8");
    expect(js).toMatch(/onclick=\"refreshCurrent\(\)\"/);
  });
});

describe("inline event handler markup", () => {
  it("never interpolates raw JSON.stringify into a quoted HTML attribute", () => {
    // Inline handlers are written inside double-quoted attributes. A raw
    // ${JSON.stringify(value)} injects unescaped double quotes, the HTML
    // parser truncates the attribute, and the button silently dies with a
    // SyntaxError on click. Every interpolation must go through esc().
    const js = readFileSync(resolve(process.cwd(), "public", "app.js"), "utf8");
    const raw = [...js.matchAll(/on\w+="[^"]*\$\{JSON\.stringify\(/g)].map((m) => m[0]);
    expect(raw).toEqual([]);
  });

  it("keeps template literals balanced around esc(JSON.stringify(...))", () => {
    // A previous bulk edit wrapped the opening side only, producing
    // ${esc(JSON.stringify(x)} inside the templates — a syntax error. Every
    // interpolation must close esc() as well as stringify(), i.e. end "))}"
    // right before the template placeholder closes.
    const js = readFileSync(resolve(process.cwd(), "public", "app.js"), "utf8");
    const needle = "${esc(JSON.stringify(";
    const broken: string[] = [];
    for (let i = js.indexOf(needle); i !== -1; i = js.indexOf(needle, i + 1)) {
      let depth = 0, j = i + 1; // j sits on the "{" of "${"
      for (; j < js.length; j++) {
        if (js[j] === "{") depth++;
        else if (js[j] === "}") { depth--; if (depth === 0) break; }
      }
      const expr = js.slice(i, j + 1);
      if (!/\)\)\}$/.test(expr)) broken.push(expr);
    }
    expect(broken).toEqual([]);
  });
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

  it("meter rows never overflow: long status badges wrap inside the row", () => {
    // Regression: .meter-row .val had min-width:62px and badges were
    // white-space:nowrap, so "missing — set GITHUB_CLIENT_SECRET in env"
    // pushed the admin row (and the modal) past the viewport edge.
    const css = readFileSync(resolve(process.cwd(), "public", "app.css"), "utf8");
    expect(css).toMatch(/\.meter-row \.val \{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.meter-row \.val \{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.meter-row \.val \.badge \{[^}]*white-space:\s*normal/);
  });

  it("card grids shrink on mobile: grid children never push the page wide", () => {
    // Regression: the GitHub page put a wide repository table inside a
    // .grid-3 column, and the column's intrinsic min-width stretched every
    // card past the viewport (574px in a 442px column). Grid columns must
    // use minmax(0,1fr) and children min-width:0 so tables scroll in place.
    const css = readFileSync(resolve(process.cwd(), "public", "app.css"), "utf8");
    expect(css).toMatch(/\.grid-3 \{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/\.grid-2 > \*,\s*\.grid-3 > \*,\s*\.admin-hero > \* \{[^}]*min-width:\s*0/);
  });
});
