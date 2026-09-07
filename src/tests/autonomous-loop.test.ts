import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Container } from "../app/container.js";
import { AutonomousOrchestrator, deterministicBreakdown, type PhaseExecutor } from "../agents/orchestrator.js";
import { extractJson } from "../agents/llm.js";
import type { Agent, Project, Run, Task } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Autonomous task loop: task → research → breakdown → implementers
 * (code → git → PR) → QA gate → bounded fix loop → done.
 * ------------------------------------------------------------------ */

function stubRun(task: Task, status: Run["status"], failedLabel?: string): Run {
  return {
    id: `run-${task.id}`,
    taskId: task.id,
    projectId: task.projectId,
    agentType: task.agentType ?? "backend-developer",
    status,
    steps: failedLabel
      ? [{ index: 0, label: "Do work", status: "running" }, { index: 1, label: failedLabel, status: "failed", detail: "boom: assertion failed" }]
      : [{ index: 0, label: "Do work", status: "succeeded" }],
  } as Run;
}

describe("extractJson", () => {
  it("parses raw JSON", () => {
    expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it("parses fenced JSON", () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
  it("extracts JSON embedded in prose", () => {
    expect(extractJson('Here you go: {"a": [1,2]} thanks')).toEqual({ a: [1, 2] });
  });
  it("returns undefined for non-JSON", () => {
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
  });
});

describe("deterministicBreakdown", () => {
  const project = { capabilities: {} } as Project;
  const task = (title: string, description = ""): Task => ({ id: "t1", title, description }) as Task;

  it("always includes a backend implementer", () => {
    const items = deterministicBreakdown(project, task("Add login API", "REST endpoint"));
    expect(items.map((i) => i.agentType)).toContain("backend-developer");
  });
  it("adds frontend for UI-ish work", () => {
    const items = deterministicBreakdown(project, task("Fix the login page layout on mobile"));
    expect(items.map((i) => i.agentType)).toEqual(expect.arrayContaining(["backend-developer", "frontend-developer"]));
  });
  it("adds database for schema-ish work", () => {
    const items = deterministicBreakdown(project, task("Add user migration", "new table for sessions"));
    expect(items.map((i) => i.agentType)).toContain("database");
  });
  it("targets one file per item", () => {
    const items = deterministicBreakdown(project, task("Add login API"));
    for (const i of items) expect(i.files.length).toBeGreaterThanOrEqual(1);
  });
});

describe("AutonomousOrchestrator with stub executor", () => {
  let fx: ReturnType<typeof freshDb>;
  let container: Container;

  beforeEach(async () => {
    fx = freshDb();
    container = new Container();
    await container.ensureSeed();
  });
  afterEach(() => fx.cleanup());

  function build(script: (task: Task, agent: Agent) => Run): AutonomousOrchestrator {
    const executor: PhaseExecutor = async (task, agent, _project, _plan) => script(task, agent);
    return new AutonomousOrchestrator({
      projectRepo: container.projectRepo,
      taskRepo: container.taskRepo,
      agentRepo: container.agentRepo,
      agentRunner: container.agentRunner,
      agentRouter: container.agentRouter,
      github: container.github,
      modelRepo: container.modelRepo,
      providerRepo: container.providerRepo,
      executor,
      maxFixLoops: 2,
    });
  }

  async function parentTask(): Promise<Task> {
    const project = await container.agentManager.createProject({
      name: "Loop App", description: "app", configRepo: "acme/loop",
    });
    return container.agentManager.createTask({
      projectId: project.id, title: "Add login page and API", description: "full login feature",
    });
  }

  it("runs research → build → QA and succeeds when QA passes", async () => {
    const parent = await parentTask();
    const seen: string[] = [];
    const orch = build((task) => {
      seen.push(`${task.agentType}:${task.title.slice(0, 12)}`);
      return stubRun(task, "succeeded");
    });
    const summary = await orch.run(parent.id);
    expect(summary.fixLoops).toBe(0);
    expect(summary.usedRealAi).toBe(false);
    expect(summary.buildTaskIds.length).toBeGreaterThanOrEqual(2); // backend + frontend
    expect(summary.qaTaskIds.length).toBe(1);
    expect(seen[0]).toMatch(/^research:/);
    const kids = container.taskRepo.findMany({ parentId: parent.id });
    expect(kids.length).toBe(1 + summary.buildTaskIds.length + summary.qaTaskIds.length);
    expect(kids.every((k) => k.data.status === "succeeded")).toBe(true);
  });

  it("routes QA failures back to an implementer and re-verifies", async () => {
    const parent = await parentTask();
    let qaRuns = 0;
    const orch = build((task) => {
      if (task.agentType === "qa-test") {
        qaRuns += 1;
        return stubRun(task, qaRuns === 1 ? "failed" : "succeeded", qaRuns === 1 ? "Run test suite" : undefined);
      }
      return stubRun(task, "succeeded");
    });
    const summary = await orch.run(parent.id);
    expect(summary.fixLoops).toBe(1);
    expect(summary.qaTaskIds.length).toBe(2);
    const kids = container.taskRepo.findMany({ parentId: parent.id }).map((k) => k.data);
    expect(kids.some((k) => k.title.startsWith("Fix (attempt 1)"))).toBe(true);
    expect(kids.filter((k) => k.agentType === "qa-test").length).toBe(2);
  });

  it("gives up after maxFixLoops and reports the QA error", async () => {
    const parent = await parentTask();
    const orch = build((task) => stubRun(task, task.agentType === "qa-test" ? "failed" : "succeeded", task.agentType === "qa-test" ? "Run test suite" : undefined));
    await expect(orch.run(parent.id)).rejects.toThrow(/QA still failing after 2 fix loop/);
    const kids = container.taskRepo.findMany({ parentId: parent.id }).map((k) => k.data);
    expect(kids.filter((k) => k.title.startsWith("Fix (attempt")).length).toBe(2);
    expect(kids.filter((k) => k.agentType === "qa-test").length).toBe(3);
  });

  it("fails fast when an implementer fails", async () => {
    const parent = await parentTask();
    const orch = build((task) => stubRun(task, task.agentType === "backend-developer" ? "failed" : "succeeded", task.agentType === "backend-developer" ? "Implement the change" : undefined));
    await expect(orch.run(parent.id)).rejects.toThrow(/failed/);
  });
});

describe("autonomous loop end-to-end (mock AI + mock GitHub)", () => {
  let fx: ReturnType<typeof freshDb>;
  let container: Container;

  beforeEach(async () => {
    fx = freshDb();
    container = new Container();
    await container.ensureSeed();
  });
  afterEach(() => fx.cleanup());

  it("completes a task through research, implementers, git and QA", async () => {
    const project = await container.agentManager.createProject({
      name: "E2E App", description: "A web app", configRepo: "acme/e2e",
    });
    const task = container.agentManager.createTask({
      projectId: project.id,
      title: "Add login page and API",
      description: "Build the login screen and the session endpoint",
      input: { executionMode: "autonomous" },
    });
    const done = await container.agentManager.runTask(task.id);
    expect(done.status).toBe("succeeded");

    const kids = container.taskRepo.findMany({ parentId: task.id }).map((k) => k.data);
    const types = kids.map((k) => k.agentType);
    expect(types).toContain("research");
    expect(types).toContain("backend-developer");
    expect(types).toContain("frontend-developer");
    expect(types).toContain("qa-test");
    expect(kids.every((k) => k.status === "succeeded")).toBe(true);

    // Every phase produced a successful run…
    const runs = container.runRepo.byProject(project.id);
    expect(runs.length).toBeGreaterThanOrEqual(kids.length);
    expect(runs.every((r) => r.status === "succeeded")).toBe(true);

    // …and the implementers committed their files + opened PRs on GitHub.
    const [owner, ...rest] = project.configRepo.split("/");
    const repo = { owner, name: rest.join("/") };
    const files = await container.github.listFiles(repo, project.branch);
    expect(files.some((f) => f.path.includes(task.id))).toBe(true);
    const pulls = await container.github.listPullRequests(repo);
    expect(pulls.length).toBeGreaterThanOrEqual(2);
  }, 60000);
});
