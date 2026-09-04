import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Container } from "../app/container.js";
import { freshDb } from "./test-helpers.js";

describe("AgentManager end-to-end (mock GitHub + mock AI)", () => {
  let fx: ReturnType<typeof freshDb>;
  let container: Container;

  beforeEach(async () => {
    fx = freshDb();
    container = new Container();
    await container.ensureSeed();
  });
  afterEach(() => fx.cleanup());

  it("onboards a project and auto-generates the agent roster + skills", async () => {
    const project = await container.agentManager.createProject({
      name: "Accounting App",
      description: "A .NET + SQL Server accounting system",
      configRepo: "acme/accounting",
      framework: ".NET",
      database: "SQL Server",
    });
    const agents = container.agentRepo.byProject(project.id);
    expect(agents.length).toBeGreaterThanOrEqual(10);
    expect(agents.some((a) => a.type === "backend-developer")).toBe(true);
    expect(agents.some((a) => a.type === "qa-test")).toBe(true);
    expect(container.skillRepo.count()).toBeGreaterThan(0);
  });

  it("runs a task end-to-end and produces a successful run with steps", async () => {
    const project = await container.agentManager.createProject({
      name: "Accounting App",
      description: "A .NET + SQL Server accounting system",
      configRepo: "acme/accounting",
    });
    const task = container.agentManager.createTask({
      projectId: project.id,
      title: "Fix login bug after last commit",
      description: "Login is broken after the last commit. Investigate the authentication module and backend.",
      agentType: "debugging",
    });
    const result = await container.agentManager.runTask(task.id);

    const runs = container.runRepo.byProject(project.id);
    expect(runs.length).toBeGreaterThan(0);
    const first = runs[0];
    // The routed agent should be debugging (as requested).
    expect(first.agentType).toBe("debugging");
    expect(result.status).toBe("succeeded");
    // Steps should include a commit + a created PR.
    const labels = first.steps.map((s) => s.label).join(" | ");
    expect(labels).toContain("Implement the change");
    expect(labels).toContain("Create pull request");
  });

  it("records cost usage from the model call", async () => {
    const project = await container.agentManager.createProject({
      name: "Accounting App",
      description: "A .NET + SQL Server accounting system",
      configRepo: "acme/accounting",
    });
    const task = container.agentManager.createTask({
      projectId: project.id,
      title: "Analyze architecture",
      agentType: "system-architect",
    });
    await container.agentManager.runTask(task.id);
    const cost = container.costRepo.totals({ projectId: project.id });
    // MockProvider produces simulated token counts.
    expect(cost.calls).toBeGreaterThan(0);
    expect(cost.tokens).toBeGreaterThan(0);
  });
});
