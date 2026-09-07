import type { Workflow, WorkflowNode, WorkflowEdge, Project, Task, AgentType, Run } from "../domain/entities.js";
import type { AgentRepository } from "../agents/agent-repo.js";
import type { AgentRunner } from "../agents/runner.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { IGitHubService } from "../github/types.js";
import { eventBus, generateCorrelationId } from "../events/bus.js";
import { live } from "../realtime/live.js";
import { logger } from "../logger.js";
import { repositoryForAgent, isWriter } from "../agents/implementation.js";
import type { PlanStep } from "../agents/plan.js";
import { ExecutionBudget, TaskCancelledError } from "../agents/execution.js";
import { evaluateExpression, resolveWorkflowInput } from "./expressions.js";
import { validateWorkflowGraph } from "./graph.js";

export interface WorkflowEngineDeps {
  agentRepo: AgentRepository;
  agentRunner: AgentRunner;
  toolRegistry: ToolRegistry;
  github: IGitHubService;
  githubForProject?: (project: Project) => IGitHubService;
  requestApproval?: (action: string, detail: Record<string, unknown>) => Promise<boolean>;
  checkActive?: (task: Task) => void;
}

interface ImplementationRef {
  repo: string;
  branch: string;
  baseBranch: string;
  sha?: string;
  files: string[];
}
interface NodeTrace {
  id: string;
  node: string;
  type: string;
  status: "running" | "succeeded" | "failed" | "skipped" | "blocked" | "cancelled";
  output?: unknown;
}
export interface WorkflowRunResult {
  workflowId: string;
  status: "succeeded" | "failed" | "waiting_for_approval" | "cancelled";
  outputs: Record<string, unknown>;
  trace: NodeTrace[];
  repositories: ImplementationRef[];
  verification?: Run["verification"];
  error?: string;
}

/** Dependency-driven DAG execution. A node runs once, after ALL selected predecessors finish. */
export class WorkflowEngine {
  constructor(private readonly deps: WorkflowEngineDeps) {}

  async run(workflow: Workflow, project: Project, task: Task, inputs: Record<string, unknown> = {}): Promise<WorkflowRunResult> {
    const correlationId = task.correlationId || generateCorrelationId();
    const outputs: Record<string, unknown> = Object.create(null);
    const trace: NodeTrace[] = [];
    const implementations = new Map<string, ImplementationRef>();
    const evidence = new Map<string, { sha?: string; verification: Run["verification"] }>();
    const taskBudget = new ExecutionBudget(project.settings.budget);
    const scope = { inputs: { ...task.input, ...inputs }, outputs };
    const checkActive = () => { this.deps.checkActive?.(task); taskBudget.check(); };
    try {
      if (!workflow.enabled) throw new Error("Workflow is disabled");
      if (workflow.projectId !== project.id || task.projectId !== project.id) throw new Error("Workflow, task and project must belong to the same project");
      validateWorkflowGraph(workflow);
      checkActive();
    } catch (err) {
      return { workflowId: workflow.id, status: err instanceof TaskCancelledError ? "cancelled" : "failed", outputs, repositories: [], error: String(err), trace: [{ id: "preflight", node: "Validate workflow", type: "validation", status: "failed", output: { error: String(err) } }] };
    }
    const github = this.deps.githubForProject?.(project) ?? this.deps.github;
    await eventBus.publish("workflow.started", { workflowId: workflow.id, projectId: project.id }, { correlationId, projectId: project.id });
    live.emit({ type: "task.updated", taskId: task.id, data: { status: "running" } });
    const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
    const completed = new Map<string, NodeTrace>();
    const pending = new Set(nodes.keys());
    const incoming = (id: string) => workflow.edges.filter((edge) => edge.to === id);
    let cancelled = false;
    let mutations = Promise.resolve();

    const note = (node: WorkflowNode, status: NodeTrace["status"], output?: unknown) => {
      const record: NodeTrace = { id: node.id, node: node.name, type: node.type, status, output };
      trace.push(record);
      return record;
    };
    const recordEvidence = (data: Record<string, unknown> | undefined) => {
      if (typeof data?.repo === "string" && ["passed", "failed", "unverified", "simulated"].includes(String(data.verification))) {
        evidence.set(data.repo, { sha: typeof data.sha === "string" ? data.sha : undefined, verification: data.verification as Run["verification"] });
      }
    };
    const recordWrite = (repo: string, data: Record<string, unknown> | undefined) => {
      if (typeof data?.branch !== "string" || !Array.isArray(data.paths)) return;
      const previous = implementations.get(repo);
      implementations.set(repo, {
        repo, branch: data.branch,
        baseBranch: project.repositories?.find((r) => r.repo === repo)?.branch ?? project.branch,
        sha: typeof data.sha === "string" ? data.sha : undefined,
        files: [...new Set([...(previous?.files ?? []), ...data.paths.filter((p): p is string => typeof p === "string")])],
      });
    };
    const verified = () => [...implementations.values()].every((ref) => {
      const check = evidence.get(ref.repo);
      return !!ref.sha && check?.sha === ref.sha && (check.verification === "passed" || check.verification === "simulated");
    });
    const edgeSelected = (edge: WorkflowEdge): boolean => {
      const parent = completed.get(edge.from)!;
      if (parent.status === "skipped") return false;
      const condition = edge.condition?.trim();
      if (nodes.get(edge.from)!.type === "condition") {
        if (!condition || condition === "pass" || condition === "true") return outputs[edge.from] === true;
        if (condition === "fail" || condition === "false") return outputs[edge.from] === false;
      }
      if (!condition) return true;
      return Boolean(evaluateExpression(condition, scope));
    };
    const approval = this.deps.requestApproval
      ? (action: string, detail: Record<string, unknown>) => this.deps.requestApproval!(action, { ...detail, workflowId: workflow.id, projectId: project.id, taskId: task.id, correlationId })
      : undefined;
    const mutates = (node: WorkflowNode): boolean => {
      if (node.type === "agent") return isWriter(node.config.agentType as AgentType);
      const tool = node.type === "tool" ? this.deps.toolRegistry.get(String(node.config.tool)) : undefined;
      return Boolean(tool && (tool.dangerous || tool.permissions.some((p) => p.endsWith(".write"))));
    };

    const execute = async (node: WorkflowNode) => {
      const record = note(node, "running");
      try {
        checkActive();
        if (cancelled) throw new TaskCancelledError(task.id);
        let output: unknown;
        switch (node.type) {
          case "agent": {
            const agentType = (node.config.agentType as AgentType) ?? "backend-developer";
            const agent = this.deps.agentRepo.byType(project.id, agentType);
            if (!agent?.enabled) throw new Error(`No enabled agent of type ${agentType} in project ${project.id}`);
            const mapped = resolveWorkflowInput(node.config.input ?? {}, scope);
            if (!mapped || typeof mapped !== "object" || Array.isArray(mapped)) throw new Error("Agent input must be an object");
            const predecessors = Object.fromEntries(incoming(node.id).filter(edgeSelected).map((edge) => {
              const previous = outputs[edge.from];
              // Pass deliverables, not duplicated tool transcripts, into the model context.
              const { steps: _steps, ...summary } = (previous && typeof previous === "object" ? previous : { value: previous }) as Record<string, unknown>;
              return [edge.from, summary];
            }));
            const runTask: Task = { ...task, workflowId: workflow.id, input: { ...scope.inputs, ...mapped, workflow: { nodeId: node.id, predecessors, artifacts: [...implementations.values()] } } };
            let plan: PlanStep[] | undefined;
            if (agentType === "qa-test" && implementations.size) {
              if (!agent.tools.includes("run_tests")) throw new Error("QA needs the run_tests CI verification tool");
              plan = [...implementations.values()].flatMap((ref) => [
                ...ref.files.map((path) => ({ label: `Inspect ${ref.repo}:${path}`, tool: "read_file", input: { repo: ref.repo, branch: ref.sha ?? ref.branch, path } })),
                { label: `Verify build and tests: ${ref.repo}`, tool: "run_tests", input: { repo: ref.repo, ref: ref.branch, expectedSha: ref.sha } },
              ]);
              if (agent.tools.includes("save_memory")) plan.push({ label: "Save QA evidence", tool: "save_memory", input: { key: `qa/${task.id}/${node.id}`, type: "technical", fromSteps: true } });
            }
            const reviewRef = !isWriter(agentType) ? [...implementations.values()][0] : undefined;
            if (reviewRef) runTask.input.files = reviewRef.files;
            const repository = reviewRef ? { repo: reviewRef.repo, branch: reviewRef.sha ?? reviewRef.branch, defaultBranch: reviewRef.baseBranch, role: "primary" as const, isConfigRepo: false } : undefined;
            const run = await this.deps.agentRunner.run({ task: runTask, agent, project, taskBudget, plan, repository });
            for (const step of run.steps) {
              if (step.tool === "write_file" && step.status === "succeeded") recordWrite(repositoryForAgent(project, agentType).repo, step.data);
              if (step.tool === "run_tests" || step.tool === "run_build") recordEvidence(step.data);
            }
            output = { runId: run.id, status: run.status, steps: run.steps, summary: run.summary, verification: run.verification, error: run.error };
            record.status = run.status === "succeeded" ? "succeeded" : run.status === "cancelled" ? "cancelled" : "failed";
            if (record.status === "cancelled") cancelled = true;
            break;
          }
          case "tool": {
            const name = String(node.config.tool);
            const input = resolveWorkflowInput(node.config.input ?? {}, scope);
            if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object");
            const toolInput = input as Record<string, unknown>;
            const repo = String(toolInput.repo ?? project.configRepo);
            const link = project.repositories?.find((r) => r.repo === repo);
            if (repo !== project.configRepo && !link) throw new Error("Tool repository is not linked to this project");
            const tool = this.deps.toolRegistry.get(name);
            if (implementations.size && (name === "merge_pull_request" || tool?.permissions.includes("deployment.write")) && !verified()) throw new Error("Current implementation must pass QA before merge or deployment");
            const result = await this.deps.toolRegistry.execute(name, {
              project: link ? { ...project, configRepo: link.repo, branch: link.branch } : project,
              agent: { id: "workflow", type: "orchestrator", projectId: project.id, name: "Workflow Executor", slug: "workflow", role: "orchestrator", description: "", systemPrompt: "", skills: [], tools: [name], permissions: ["github.read", "github.write", "memory.read", "memory.write"], models: { primary: "", fallbacks: [], specialized: {} }, maxIterations: 1, timeoutMs: 0, tokenBudget: 0, memorySources: [], enabled: true, version: 1, createdAt: "", updatedAt: "" },
              github, logger, correlationId, requestApproval: approval, checkActive,
              baseBranch: link?.branch ?? project.branch,
            }, toolInput);
            output = result;
            record.status = result.ok ? "succeeded" : "failed";
            if (result.ok && name === "write_file") recordWrite(repo, result.data);
            if (name === "run_tests" || name === "run_build") recordEvidence(result.data);
            break;
          }
          case "condition":
            output = !String(node.config.expression ?? "").trim() || Boolean(evaluateExpression(String(node.config.expression), scope));
            record.status = "succeeded";
            break;
          case "approval": {
            if (!approval) throw new Error("No approval channel configured for workflow");
            const approved = await approval(String(node.config.message ?? `Approve workflow step "${node.name}"?`), { node: node.name, repositories: [...implementations.values()], verified: implementations.size ? verified() : undefined });
            checkActive();
            if (!approved) throw new Error("Workflow approval rejected or timed out");
            output = { approved: true };
            record.status = "succeeded";
            break;
          }
          default:
            output = { ok: true };
            record.status = "succeeded";
        }
        checkActive();
        record.output = output;
        outputs[node.id] = output;
      } catch (err) {
        record.status = err instanceof TaskCancelledError ? "cancelled" : "failed";
        if (record.status === "cancelled") cancelled = true;
        record.output = outputs[node.id] = { error: String(err) };
        logger.error(`workflow node ${node.name} failed`, { err: String(err) });
      } finally {
        completed.set(node.id, record);
        live.emit({ type: "task.updated", taskId: task.id, data: { workflowNode: node.id, nodeStatus: record.status } });
      }
    };

    // Waves guarantee join semantics. Independent nodes run concurrently;
    // mutations are serialized so parallel writers cannot race on a shared branch.
    while (pending.size && !cancelled) {
      const ready = workflow.nodes.filter((node) => pending.has(node.id) && incoming(node.id).every((edge) => completed.has(edge.from)));
      if (!ready.length) throw new Error("Workflow scheduler could not advance a validated DAG");
      const priority = (node: WorkflowNode) => ({ database: 0, "backend-developer": 1, "frontend-developer": 2, uiux: 3 }[String(node.config.agentType)] ?? 4);
      ready.sort((a, b) => priority(a) - priority(b));
      await Promise.all(ready.map(async (node) => {
        pending.delete(node.id);
        let selected: WorkflowEdge[];
        try { selected = incoming(node.id).filter(edgeSelected); }
        catch (err) {
          const output = { error: String(err) };
          outputs[node.id] = output;
          completed.set(node.id, note(node, "failed", output));
          return;
        }
        if (incoming(node.id).length && !selected.length) {
          completed.set(node.id, note(node, "skipped"));
          return;
        }
        const blocked = selected.filter((edge) => completed.get(edge.from)!.status !== "succeeded");
        if (blocked.length) {
          const output = { error: `Blocked by unsuccessful predecessor(s): ${blocked.map((e) => e.from).join(", ")}` };
          outputs[node.id] = output;
          completed.set(node.id, note(node, "blocked", output));
          return;
        }
        if (mutates(node)) {
          const next = mutations.then(() => execute(node));
          mutations = next.catch(() => undefined);
          await next;
        } else await execute(node);
      }));
    }
    for (const id of pending) completed.set(id, note(nodes.get(id)!, "cancelled"));
    let status: WorkflowRunResult["status"] = cancelled ? "cancelled" : trace.some((r) => r.status === "failed" || r.status === "blocked") ? "failed" : "succeeded";
    let verification: Run["verification"];
    if (implementations.size) {
      verification = verified() ? [...evidence.values()].some((e) => e.verification === "simulated") ? "simulated" : "passed"
        : [...evidence.values()].some((e) => e.verification === "failed") ? "failed" : "unverified";
      if (status === "succeeded" && !verified()) {
        status = "failed";
        trace.push({ id: "verification", node: "Verify final implementation", type: "validation", status: "failed", output: { error: "Implementation is unverified or changed after QA. Add a QA node after all writers." } });
      }
    }
    const error = trace.find((r) => r.status === "failed")?.output as { error?: string; output?: string } | undefined;
    if (status === "succeeded") await eventBus.publish("workflow.completed", { workflowId: workflow.id, projectId: project.id }, { correlationId, projectId: project.id });
    live.emit({ type: "task.updated", taskId: task.id, data: { status, verification } });
    return { workflowId: workflow.id, status, outputs, trace, repositories: [...implementations.values()], verification, error: error?.error ?? error?.output };
  }
}
