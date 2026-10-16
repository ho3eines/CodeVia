import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Container } from "../app/container.js";
import type { Project } from "../domain/entities.js";
import { MockGitHubService } from "../github/mock-service.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Simulation mode must be a dry run everywhere (F4).
 *
 * The chat path already treated executionMode "simulation" as a plan
 * preview, but a task created via the API with input.executionMode
 * "simulation" executed a REAL implementation: branch, commits, PR.
 * The runner now skips every side-effecting tool (any *.write
 * permission) with an explicit [SIMULATION] marker; read-only tools
 * still run so the dry run produces real evidence.
 * ------------------------------------------------------------------ */

let fx: ReturnType<typeof freshDb>;
let container: Container;

beforeEach(() => {
  fx = freshDb();
  container = new Container();
});
afterEach(() => fx.cleanup());

async function projectWithSimulationTask(): Promise<{ project: Project; taskId: string }> {
  const project = await container.agentManager.createProject({
    name: "Sim App",
    description: "app",
    configRepo: "acme/sim",
  });
  const task = container.agentManager.createTask({
    projectId: project.id,
    agentType: "backend-developer",
    title: "Add a metrics module to the service",
    description: "Add a metrics helper with tests.",
    input: { executionMode: "simulation" },
  });
  return { project, taskId: task.id };
}

describe("simulation mode is a dry run (no repository side effects)", () => {
  it("completes the task but creates no branches, no PRs and no write commits", async () => {
    const { project, taskId } = await projectWithSimulationTask();
    const gh = container.github as unknown as MockGitHubService;
    const ref = { owner: "acme", name: "sim" };
    const branchesBefore = (await gh.listBranches(ref)).map((b) => b.name);
    const pullsBefore = (await gh.listPullRequests(ref)).length;

    const task = await container.agentManager.runTask(taskId);
    expect(task.status).toBe("succeeded");

    // The dry run must not have touched the repository topology.
    const branchesAfter = (await gh.listBranches(ref)).map((b) => b.name);
    expect(branchesAfter).toEqual(branchesBefore);
    expect((await gh.listPullRequests(ref)).length).toBe(pullsBefore);

    // The implementer's write steps ran as marked simulations, not commits.
    const runs = container.runRepo.findMany({ projectId: project.id }).map((r) => r.data);
    const simulated = runs.flatMap((r) => r.steps).filter((s) => (s.detail ?? "").includes("[SIMULATION]"));
    expect(simulated.length).toBeGreaterThan(0);
    expect(simulated.some((s) => (s.detail ?? "").includes("write_file") || s.label.includes("Implement"))).toBe(true);
    for (const s of simulated) expect(s.status).toBe("succeeded");
    // The run itself is stamped as a simulation.
    expect(runs.every((r) => r.verification === "simulated")).toBe(true);
  });

  it("an autonomous task still works normally (only simulation mode is dry)", async () => {
    const project = await container.agentManager.createProject({
      name: "Real App",
      description: "app",
      configRepo: "acme/real",
    });
    const task = container.agentManager.createTask({
      projectId: project.id,
      title: "Add a logging module with tests",
      description: "Add a logging helper.",
      input: { executionMode: "autonomous" },
    });
    const done = await container.agentManager.runTask(task.id);
    expect(done.status).toBe("succeeded");
    const gh = container.github as unknown as MockGitHubService;
    const branches = (await gh.listBranches({ owner: "acme", name: "real" })).map((b) => b.name);
    expect(branches.some((b) => b.startsWith("agent-"))).toBe(true);
    expect((await gh.listPullRequests({ owner: "acme", name: "real" })).length).toBeGreaterThan(0);
  });
});
