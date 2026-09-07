import { describe, it, expect } from "vitest";
import { AgentRouter } from "../agents/router.js";
import { defaultPlanFor } from "../agents/plan.js";
import { scaffoldFor } from "../agents/generator.js";
import { ContextEngine } from "../ai/context-engine.js";
import type { Agent, Project, Task } from "../domain/entities.js";

const router = new AgentRouter();

describe("AgentRouter (Autonomous Error Routing)", () => {
  it("routes database errors to the database agent", () => {
    expect(router.route("SQL connection failed during migration")).toBe("database");
  });
  it("routes login/bug fixes to the debugging agent", () => {
    expect(router.route("Fix the login bug — exception thrown")).toBe("debugging");
  });
  it("routes security findings to the security agent", () => {
    expect(router.route("Found an XSS injection in the search endpoint")).toBe("security");
  });
  it("routes test failures to QA", () => {
    expect(router.route("regression: unit test failed")).toBe("qa-test");
  });
  it("routes UI issues to UI/UX", () => {
    expect(router.route("the login page is not responsive on mobile")).toBe("uiux");
  });
  it("routes Persian project requests to the right specialist", () => {
    expect(router.route("قسمت بک‌اند لاگین را بررسی کن و اگر خطا داشت درستش کن")).toBe("debugging");
    expect(router.route("ظاهر صفحه پروژه در موبایل خراب است و باید راست چین شود")).toBe("uiux");
    expect(router.route("تست کامل احراز هویت را اجرا کن")).toBe("qa-test");
    expect(router.route("مایگریشن دیتابیس و اسکیما را بررسی کن")).toBe("database");
  });
  it("defaults to backend for ambiguous tasks", () => {
    expect(router.route("improve the CRUD ordering")).toBe("backend-developer");
  });
});

function agent(type: Agent["type"]): Agent {
  const now = new Date().toISOString();
  // Realistic toolbox + permissions (same scaffold onboarding uses), because
  // plans are permission-aware: read-only agents must not get write steps.
  const scaffold = scaffoldFor(type);
  return {
    id: "a1", projectId: "p1", type, name: "Agent", slug: type, role: "", description: "",
    systemPrompt: "", skills: [...scaffold.skills], tools: [...scaffold.tools], permissions: [...scaffold.permissions],
    models: { primary: "m", fallbacks: [], specialized: {} },
    maxIterations: 5, timeoutMs: 1000, tokenBudget: 100, memorySources: [],
    enabled: true, version: 1, createdAt: now, updatedAt: now,
  };
}
function task(): Task {
  const now = new Date().toISOString();
  return {
    id: "t1", projectId: "p1", title: "Fix login", description: "login broken", status: "created",
    correlationId: "c", input: {}, createdAt: now, updatedAt: now,
  };
}

describe("defaultPlanFor", () => {
  it("starts with understand + inspect repository and ends with a PR step", () => {
    const plan = defaultPlanFor(agent("backend-developer"), task());
    expect(plan[0].label).toBe("Understand request");
    expect(plan[1].tool).toBe("list_branches");
    expect(plan[plan.length - 1].tool).toBe("create_pull_request");
    expect(plan[plan.length - 1].requiresApproval).toBe(true);
  });

  it("produces a QA plan that includes classifying failures", () => {
    const plan = defaultPlanFor(agent("qa-test"), task());
    expect(plan.map((s) => s.label.toLowerCase()).join(" ")).toContain("classify failures");
  });

  it("gives read-only agents executable plans (no write/PR steps they cannot run)", () => {
    for (const type of ["research", "qa-test", "security", "code-reviewer", "debugging"] as const) {
      const a = agent(type);
      const plan = defaultPlanFor(a, task());
      const tools = plan.map((s) => s.tool).filter(Boolean) as string[];
      expect(tools).not.toContain("write_file");
      expect(tools).not.toContain("create_pull_request");
      for (const t of tools) expect(a.tools).toContain(t);
    }
  });

  it("gives the debugging agent a diagnosis plan that hands off to a fixer", () => {
    const plan = defaultPlanFor(agent("debugging"), task());
    const labels = plan.map((s) => s.label).join(" | ");
    expect(labels).toContain("Diagnose root cause");
    expect(labels).toContain("Propose fix and responsible agent");
    expect(plan.find((s) => s.label.includes("Propose fix"))?.chainTo).toBe("backend-developer");
  });
});

describe("ContextEngine project request contract", () => {
  it("injects the user's request and safe operating rules into agent context", async () => {
    const now = new Date().toISOString();
    const project: Project = {
      id: "p1",
      slug: "accounting",
      name: "Accounting",
      description: "Persian-friendly accounting system",
      configRepo: "acme/accounting",
      branch: "main",
      repositories: [{ repo: "acme/accounting", branch: "main", role: "primary", isConfigRepo: true }],
      capabilities: { platforms: ["web"], languages: ["csharp"], frameworks: ["dotnet"], databases: ["sqlserver"], deploymentTargets: [], features: [], integrations: [], agentTypes: [] },
      primaryLanguage: "csharp",
      framework: "dotnet",
      database: "sqlserver",
      settings: { environment: "development", notifications: [], rules: [], skills: [], workflows: [], budget: { maxTokensPerRun: 1000, maxCallsPerRun: 5, maxCostUsdPerRun: 1, maxDurationMs: 10000 }, permissions: {} as never, metadata: {} },
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    const req = { ...task(), title: "بررسی بک‌اند لاگین", description: "طبق پرامپ پروژه اول ریپو را بررسی کن، تست بگیر و اگر لازم بود PR بساز." };
    const engine = new ContextEngine();
    const built = await engine.build({
      project,
      agent: agent("backend-developer"),
      task: req,
      github: { getFile: async () => undefined, listCommits: async () => [] } as never,
      memory: { search: async () => [] } as never,
    });
    expect(built.context).toContain("## task-request");
    expect(built.context).toContain("بررسی بک‌اند لاگین");
    expect(built.context).toContain("Inspect repository context before proposing or making code/config changes");
    expect(built.context).toContain("Never write plaintext secrets");
  });
});
