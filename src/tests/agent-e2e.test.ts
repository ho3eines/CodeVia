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
    const workflows = container.workflowRepo.byProject(project.id);
    expect(workflows.map((w) => w.slug)).toContain("autonomous-development-loop");
    expect(workflows.map((w) => w.slug)).toContain("bug-diagnosis-loop");
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
    // Debugging is diagnosis-only (read-only agent): it must produce a
    // genuinely successful run — not a task that "succeeds" with a failed run.
    expect(first.status).toBe("succeeded");
    const labels = first.steps.map((s) => s.label).join(" | ");
    expect(labels).toContain("Diagnose root cause");
    expect(labels).toContain("Propose fix and responsible agent");
    expect(labels).not.toContain("Create pull request");
  });

  it("keeps agents isolated across multiple projects (no roster collision)", async () => {
    const a = await container.agentManager.createProject({
      name: "Project A",
      description: "A .NET accounting system",
      configRepo: "acme/a",
    });
    const b = await container.agentManager.createProject({
      name: "Project B",
      description: "A React storefront",
      configRepo: "acme/b",
    });
    const agentsA = container.agentRepo.byProject(a.id);
    const agentsB = container.agentRepo.byProject(b.id);
    expect(agentsA.length).toBeGreaterThanOrEqual(10);
    expect(agentsB.length).toBeGreaterThanOrEqual(10);
    // No shared agent id between projects.
    const idsA = new Set(agentsA.map((x) => x.id));
    const idsB = new Set(agentsB.map((x) => x.id));
    expect([...idsA].filter((id) => idsB.has(id))).toEqual([]);
    // Each project has its own backend + qa agents.
    expect(agentsA.some((x) => x.type === "backend-developer")).toBe(true);
    expect(agentsB.some((x) => x.type === "backend-developer")).toBe(true);
    // Running a task in project B must resolve a project-B agent (not A's).
    const task = container.agentManager.createTask({
      projectId: b.id,
      title: "Fix login bug",
      description: "login broken",
      agentType: "debugging",
    });
    const res = await container.agentManager.runTask(task.id);
    expect(res.status).toBe("succeeded");
    const runsB = container.runRepo.byProject(b.id);
    expect(runsB[0].agentId).not.toBe(agentsA.find((x) => x.type === "debugging")?.id);
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
