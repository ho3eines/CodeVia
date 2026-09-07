import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Container } from "../app/container.js";
import type { Project, Run, Task, Workflow, WorkflowEdge, WorkflowNode } from "../domain/entities.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { evaluateExpression, resolveWorkflowInput } from "../workflow/expressions.js";
import { freshDb } from "./test-helpers.js";

const scope = { inputs: { enabled: false, retries: 2, tag: "v1", list: [3] }, outputs: { "backend-unit": { status: "succeeded", data: { branch: "feature/task" } } } };
describe("workflow data expressions (no JavaScript evaluation)", () => {
  it.each([
    ["inputs.enabled", false],
    ["inputs.missing", undefined],
    ["!inputs.enabled && inputs.retries >= 2", true],
    ["!!inputs.retries", true],
    ['outputs["backend-unit"].status === "succeeded"', true],
    ["inputs.tag == 'v1' && inputs.list[0] > 1", true],
    ["(false || true) && false", false],
    ["inputs.enabled || inputs.missing", false],
    ["inputs.retries === '2'", false],
  ])("evaluates %s using actual input/output values", (expression, result) => {
    expect(evaluateExpression(String(expression), scope)).toBe(result);
  });
  it.each(["process.exit()", "inputs.constructor", "outputs.__proto__.x", "inputs.enabled = true", "globalThis", "inputs.retries + 1", "inputs['prototype']"])("rejects unsafe/unsupported expression %s", (expression) => {
    expect(() => evaluateExpression(expression, scope)).toThrow();
  });
  it("resolves typed inputs, quoted node IDs and templates; missing input is an error", () => {
    expect(resolveWorkflowInput({ retries: "{{ inputs.retries }}", values: "{{ inputs.list }}", message: 'commit {{ outputs["backend-unit"].data.branch }}' }, scope)).toEqual({ retries: 2, values: [3], message: "commit feature/task" });
    expect(() => resolveWorkflowInput({ branch: "{{ outputs.missing.branch }}" }, scope)).toThrow(/Missing workflow input/);
  });
});

let fx: ReturnType<typeof freshDb>;
let c: Container;
let project: Project;
let task: Task;
const node = (id: string, type: WorkflowNode["type"] = "tool", config: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, config: type === "tool" ? { tool: "probe", input: { label: id }, ...config } : config, retries: 0 });
const link = (from: string, to: string, condition?: string): WorkflowEdge => ({ from, to, ...(condition ? { condition } : {}) });
function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id: "workflow-test", projectId: project.id, name: "Test workflow", description: "Test DAG", slug: "test-workflow", nodes, edges, enabled: true, version: 1, createdAt: "", updatedAt: "" };
}
const fakeRun = (request: Parameters<typeof c.agentRunner.run>[0], summary = "done"): Run => ({ id: `run-${String((request.task.input.workflow as { nodeId: string }).nodeId)}`, taskId: task.id, projectId: project.id, agentId: request.agent.id, agentType: request.agent.type, status: "succeeded", summary, steps: [], inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, correlationId: task.correlationId, createdAt: "", updatedAt: "" });

beforeEach(async () => {
  fx = freshDb();
  c = new Container();
  await c.ensureSeed();
  project = await c.agentManager.createProject({ name: "Workflow App", configRepo: "acme/workflows", description: "A web app" });
  task = c.agentManager.createTask({ projectId: project.id, title: "Add login", description: "Implement a session API and login page" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  c.githubAutomation.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fx.cleanup();
});

function probe(execute = vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => ({ ok: true, output: String(input.label), data: input }))) {
  c.toolRegistry.register({ name: "probe", dangerous: false, permissions: [], timeoutMs: 5000, description: "test probe", inputSchema: {}, execute });
  return execute;
}

describe("dependency-driven workflow execution", () => {
  it("executes all roots, not just the first connected component", async () => {
    const call = probe();
    const result = await c.workflowEngine.run(workflow([node("a"), node("b"), node("c")], [link("a", "c")]), project, task);
    expect(result.status).toBe("succeeded");
    expect(call.mock.calls.map((args) => args[1].label).sort()).toEqual(["a", "b", "c"]);
  });

  it.each(["cycle", "unreachable cycle", "missing node", "duplicate id"])("rejects %s before any tool side effect", async (kind) => {
    const call = probe();
    const nodes = [node("a"), node("b"), ...(kind === "unreachable cycle" ? [node("root")] : [])];
    if (kind === "duplicate id") nodes.push(node("a"));
    const edges = kind.includes("cycle") ? [link("a", "b"), link("b", "a")] : kind === "missing node" ? [link("a", "absent")] : [];
    const result = await c.workflowEngine.run(workflow(nodes, edges), project, task);
    expect(result.status).toBe("failed");
    expect(call).not.toHaveBeenCalled();
  });

  it("fans out concurrently, waits for both sides of a diamond and runs the join once", async () => {
    let release!: () => void;
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    const call = probe(vi.fn(async (_ctx, input) => {
      if (input.label === "right") { started(); await new Promise<void>((resolve) => { release = resolve; }); }
      return { ok: true, output: String(input.label), data: input };
    }));
    const graph = workflow([node("fork", "parallel"), node("left"), node("right"), node("join")], [link("fork", "left"), link("fork", "right"), link("left", "join"), link("right", "join")]);
    const running = c.workflowEngine.run(graph, project, task);
    await reached;
    expect(call.mock.calls.map((args) => args[1].label)).toEqual(["left", "right"]);
    release();
    expect((await running).status).toBe("succeeded");
    expect(call.mock.calls.filter((args) => args[1].label === "join")).toHaveLength(1);
  });

  it("evaluates a false condition and joins the selected branch without waiting forever for the skipped one", async () => {
    const call = probe();
    const graph = workflow([node("condition", "condition", { expression: "inputs.enabled" }), node("yes"), node("no"), node("join")], [link("condition", "yes", "pass"), link("condition", "no", "fail"), link("yes", "join"), link("no", "join")]);
    const result = await c.workflowEngine.run(graph, project, task, { enabled: false });
    expect(result.status).toBe("succeeded");
    expect(call.mock.calls.map((args) => args[1].label)).toEqual(["no", "join"]);
    expect(result.trace.find((r) => r.id === "yes")?.status).toBe("skipped");
  });

  it("does not execute descendants of a failed node (independent diagnostics still run)", async () => {
    const call = probe(vi.fn(async (_ctx, input) => ({ ok: input.label !== "broken", output: "result", data: input })));
    const result = await c.workflowEngine.run(workflow([node("broken"), node("write"), node("diagnostic")], [link("broken", "write")]), project, task);
    expect(result.status).toBe("failed");
    expect(call.mock.calls.map((args) => args[1].label)).not.toContain("write");
    expect(result.trace.find((r) => r.id === "write")?.status).toBe("blocked");
    expect(result.trace.find((r) => r.id === "diagnostic")?.status).toBe("succeeded");
  });

  it("hands predecessor deliverables and resolved inputs to the next agent", async () => {
    const runs = vi.spyOn(c.agentRunner, "run").mockImplementation(async (req) => fakeRun(req, req.agent.type === "backend-developer" ? "API_CONTRACT_FROM_BACKEND" : "client"));
    const graph = workflow([node("backend", "agent", { agentType: "backend-developer" }), node("frontend", "agent", { agentType: "frontend-developer", input: { contract: "{{ outputs.backend.summary }}" } })], [link("backend", "frontend")]);
    expect((await c.workflowEngine.run(graph, project, task)).status).toBe("succeeded");
    expect(runs.mock.calls[1][0].task.input).toMatchObject({ contract: "API_CONTRACT_FROM_BACKEND", workflow: { predecessors: { backend: { summary: "API_CONTRACT_FROM_BACKEND" } } } });
  });

  it("serializes parallel writers and establishes backend contracts before the frontend", async () => {
    let active = 0;
    let peak = 0;
    const runs = vi.spyOn(c.agentRunner, "run").mockImplementation(async (req) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return fakeRun(req);
    });
    const graph = workflow([node("fork", "parallel"), node("frontend", "agent", { agentType: "frontend-developer" }), node("backend", "agent", { agentType: "backend-developer" })], [link("fork", "backend"), link("fork", "frontend")]);
    expect((await c.workflowEngine.run(graph, project, task)).status).toBe("succeeded");
    expect(peak).toBe(1);
    expect(runs.mock.calls.map(([r]) => r.agent.type)).toEqual(["backend-developer", "frontend-developer"]);
  });

  it("fails closed without an approval channel and treats rejection as final failure", async () => {
    const call = probe();
    const graph = workflow([node("gate", "approval"), node("write")], [link("gate", "write")]);
    const noChannel = new WorkflowEngine({ agentRepo: c.agentRepo, agentRunner: c.agentRunner, toolRegistry: c.toolRegistry, github: c.github });
    expect((await noChannel.run(graph, project, task)).status).toBe("failed");
    c.approvalChannel = async () => false;
    expect((await c.workflowEngine.run(graph, project, task)).status).toBe("failed");
    expect(call).not.toHaveBeenCalled();
  });

  it("honours cancellation after an approval wait instead of continuing tool nodes", async () => {
    const call = probe();
    c.approvalChannel = async () => { c.taskRepo.upsert({ ...task, status: "cancelled" }, { projectId: project.id }); return true; };
    const result = await c.workflowEngine.run(workflow([node("gate", "approval"), node("write")], [link("gate", "write")]), project, task);
    expect(result.status).toBe("cancelled");
    expect(call).not.toHaveBeenCalled();
  });

  it("cannot run a disabled or cross-project workflow", async () => {
    const call = probe();
    const graph = workflow([node("a")], []);
    expect((await c.workflowEngine.run({ ...graph, enabled: false }, project, task)).status).toBe("failed");
    expect((await c.workflowEngine.run({ ...graph, projectId: "other" }, project, task)).status).toBe("failed");
    expect(call).not.toHaveBeenCalled();
  });

  it("resolves real output values in a tool node, including their original types", async () => {
    const call = probe();
    const graph = workflow([node("source", "tool", { input: { label: "source", value: 4 } }), node("next", "tool", { input: { label: "next", received: "{{ outputs.source.data.value }}" } })], [link("source", "next", "outputs.source.ok === true")]);
    expect((await c.workflowEngine.run(graph, project, task)).status).toBe("succeeded");
    expect(call.mock.calls[1][1].received).toBe(4);
  });
});

describe("workflow implementation integration (Mock GitHub, not real CI)", () => {
  it("verifies the final shared branch and retains all writers' files", async () => {
    const graph = workflow([node("backend", "agent", { agentType: "backend-developer" }), node("frontend", "agent", { agentType: "frontend-developer" }), node("qa", "agent", { agentType: "qa-test" })], [link("backend", "frontend"), link("frontend", "qa")]);
    c.workflowRepo.upsert(graph, { projectId: project.id });
    c.taskRepo.upsert({ ...task, workflowId: graph.id }, { projectId: project.id });
    await c.agentManager.syncProjectState(project.id);
    const result = await c.agentManager.runTask(task.id);
    expect(result.status).toBe("succeeded");
    expect(result.result?.verification).toBe("simulated");
    const [ref] = result.result!.repositories as Array<{ branch: string; sha: string; files: string[] }>;
    expect(ref.files.length).toBeGreaterThanOrEqual(4);
    expect(await c.github.listPullRequests({ owner: "acme", name: "workflows" })).toHaveLength(1);
    const qa = c.runRepo.byTask(task.id).find((r) => r.agentType === "qa-test")!;
    expect(qa.steps.find((s) => s.tool === "run_tests")?.data?.sha).toBe(ref.sha);
    expect(qa.summary).toContain("Simulation only");
  });

  it("does not attest changes written after QA, even if the earlier QA node passed", async () => {
    const graph = workflow([node("backend", "agent", { agentType: "backend-developer" }), node("qa", "agent", { agentType: "qa-test" }), node("frontend", "agent", { agentType: "frontend-developer" })], [link("backend", "qa"), link("qa", "frontend")]);
    const result = await c.workflowEngine.run(graph, project, task);
    expect(result.status).toBe("failed");
    expect(result.verification).toBe("unverified");
    expect(result.error).toContain("changed after QA");
  });

  it("does not silently call a coding-only workflow fully verified", async () => {
    const result = await c.workflowEngine.run(workflow([node("backend", "agent", { agentType: "backend-developer" })], []), project, task);
    expect(result.status).toBe("failed");
    expect(result.verification).toBe("unverified");
  });

  it("seeds QA after all writers in both built-in workflows", () => {
    for (const graph of c.workflowRepo.byProject(project.id)) {
      const qa = graph.nodes.findIndex((n) => n.config.agentType === "qa-test");
      const lastWriter = Math.max(...graph.nodes.map((n, i) => ["backend-developer", "frontend-developer", "uiux", "database", "documentation"].includes(String(n.config.agentType)) ? i : -1));
      expect(qa).toBeGreaterThan(lastWriter);
    }
  });
});
