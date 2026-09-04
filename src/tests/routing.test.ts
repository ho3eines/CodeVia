import { describe, it, expect } from "vitest";
import { AgentRouter } from "../agents/router.js";
import { defaultPlanFor } from "../agents/plan.js";
import type { Agent, Task } from "../domain/entities.js";

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
  it("defaults to backend for ambiguous tasks", () => {
    expect(router.route("improve the CRUD ordering")).toBe("backend-developer");
  });
});

describe("defaultPlanFor", () => {
  function agent(type: Agent["type"]): Agent {
    const now = new Date().toISOString();
    return {
      id: "a1", projectId: "p1", type, name: "Agent", slug: type, role: "", description: "",
      systemPrompt: "", skills: [], tools: [], permissions: [],
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
});
