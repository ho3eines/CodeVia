import type { Workflow, Project, Task, AgentType } from "../domain/entities.js";
import type { AgentRepository } from "../agents/agent-repo.js";
import type { AgentRunner } from "../agents/runner.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { IGitHubService } from "../github/types.js";
import { eventBus } from "../events/bus.js";
import { live } from "../realtime/live.js";
import { logger } from "../logger.js";
import { generateCorrelationId } from "../events/bus.js";

export interface WorkflowEngineDeps {
  agentRepo: AgentRepository;
  agentRunner: AgentRunner;
  toolRegistry: ToolRegistry;
  github: IGitHubService;
  requestApproval?: (action: string, detail: Record<string, unknown>) => Promise<boolean>;
}

export interface WorkflowRunResult {
  workflowId: string;
  status: "succeeded" | "failed" | "waiting_for_approval" | "cancelled";
  outputs: Record<string, unknown>;
  trace: Array<{ node: string; type: string; status: string; output?: unknown }>;
}

/**
 * Workflow Engine. Executes a DAG of nodes:
 *   agent, tool, condition, approval, parallel, trigger.
 * Sequential paths follow edges; a condition node can skip a branch; a parallel
 * node fans out to its downstream nodes and waits for all of them.
 */
export class WorkflowEngine {
  constructor(private readonly deps: WorkflowEngineDeps) {}

  async run(workflow: Workflow, project: Project, task: Task, inputs: Record<string, unknown> = {}): Promise<WorkflowRunResult> {
    const correlationId = task.correlationId || generateCorrelationId();
    await eventBus.publish("workflow.started", { workflowId: workflow.id, projectId: project.id }, { correlationId, projectId: project.id });
    live.emit({ type: "task.updated", taskId: task.id, data: { status: "running" } });

    const outputs: Record<string, unknown> = {};
    const trace: WorkflowRunResult["trace"] = [];
    const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));
    const incoming = new Map<string, number>();
    for (const e of workflow.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
    const startId = workflow.nodes.find((n) => !incoming.has(n.id))?.id ?? workflow.nodes[0]?.id;
    if (!startId) {
      return { workflowId: workflow.id, status: "failed", outputs, trace: [{ node: "?", type: "?", status: "failed" }] };
    }

    // Depth-first execution following edges, with cycle protection.
    const visited = new Set<string>();
    let status: WorkflowRunResult["status"] = "succeeded";

    const execNode = async (nodeId: string): Promise<unknown> => {
      if (visited.has(nodeId)) return undefined;
      visited.add(nodeId);
      const node = nodeById.get(nodeId);
      if (!node) return undefined;
      const record = { node: node.name, type: node.type, status: "running" };
      trace.push(record);
      try {
        let output: unknown = undefined;
        switch (node.type) {
          case "agent": {
            const agentType = (node.config.agentType as AgentType) ?? "backend-developer";
            const agent = this.deps.agentRepo.byType(project.id, agentType);
            if (!agent) {
              record.status = "failed";
              throw new Error(`No agent of type ${agentType} in project ${project.id}`);
            }
            const run = await this.deps.agentRunner.run({
              task: { ...task, workflowId: workflow.id },
              agent,
              project,
            });
            output = { runId: run.id, status: run.status, steps: run.steps };
            record.status = run.status === "succeeded" ? "succeeded" : "failed";
            if (run.status === "waiting_for_approval") status = "waiting_for_approval";
            break;
          }
          case "tool": {
            const toolName = String(node.config.tool);
            const result = await this.deps.toolRegistry.execute(
              toolName,
              {
                project,
                agent: {
                  id: "workflow",
                  type: "orchestrator",
                  projectId: project.id,
                  name: "Workflow Executor",
                  slug: "workflow",
                  role: "orchestrator",
                  description: "",
                  systemPrompt: "",
                  skills: [],
                  tools: [],
                  permissions: ["github.read", "github.write", "memory.read", "memory.write"],
                  models: { primary: "", fallbacks: [], specialized: {} },
                  maxIterations: 1,
                  timeoutMs: 0,
                  tokenBudget: 0,
                  memorySources: [],
                  enabled: true,
                  version: 1,
                  createdAt: "",
                  updatedAt: "",
                },
                github: this.deps.github,
                logger,
                correlationId,
                requestApproval: this.deps.requestApproval,
              },
              (node.config.input as Record<string, unknown>) ?? {},
            );
            output = result;
            record.status = result.ok ? "succeeded" : "failed";
            break;
          }
          case "condition": {
            output = await this.evalCondition(node.config.expression == null ? undefined : String(node.config.expression), inputs, outputs);
            record.status = "succeeded";
            break;
          }
          case "approval": {
            if (this.deps.requestApproval) {
              const approved = await this.deps.requestApproval(String(node.config.message ?? `Approve workflow step "${node.name}"?`), {
                workflowId: workflow.id,
                projectId: project.id,
                taskId: task.id,
                correlationId,
                node: node.name,
              });
              if (!approved) {
                status = "waiting_for_approval";
                record.status = "skipped";
                return output;
              }
            }
            record.status = "succeeded";
            break;
          }
          case "parallel": {
            record.status = "succeeded";
            break;
          }
          case "trigger":
          case "webhook":
          case "telegram":
          default: {
            output = { ok: true };
            record.status = "succeeded";
            break;
          }
        }
        outputs[nodeId] = output;
        return output;
      } catch (err) {
        record.status = "failed";
        outputs[nodeId] = { error: String(err) };
        status = "failed";
        logger.error(`workflow node ${node.name} failed`, { err: String(err) });
        return undefined;
      }
    };

    const walk = async (nodeId: string): Promise<void> => {
      await execNode(nodeId);
      // Follow outgoing edges, but only traverse a branch when a condition node
      // produced a truthy value and the edge condition (if any) matches.
      const edges = workflow.edges.filter((e) => e.from === nodeId);
      for (const edge of edges) {
        const source = nodeById.get(edge.from);
        if (source?.type === "condition") {
          const val = outputs[edge.from];
          const nextCond = edge.condition ?? "pass";
          if (nextCond === "pass" && val !== true) continue;
          if (nextCond === "fail" && val !== false) continue;
        } else if (source?.type === "parallel") {
          const children = workflow.edges.filter((e) => e.from === source.id);
          await Promise.all(children.map((c) => walk(c.to)));
          continue;
        }
        await walk(edge.to);
        // If a branch diverged and succeeded, that's enough; but we also want the
        // primary path. Walk continues down first edge; extra branches are optional.
      }
    };

    await walk(startId);
    if (status === "succeeded") {
      await eventBus.publish("workflow.completed", { workflowId: workflow.id, projectId: project.id }, { correlationId, projectId: project.id });
      live.emit({ type: "task.updated", taskId: task.id, data: { status: "succeeded" } });
    }
    return { workflowId: workflow.id, status, outputs, trace };
  }

  private async evalCondition(expression: string | undefined, _inputs: Record<string, unknown>, _outputs: Record<string, unknown>): Promise<boolean> {
    if (!expression) return true;
    const trimmed = expression.trim();
    // Support simple boolean literals and loose truthy checks.
    if (/^true$/i.test(trimmed)) return true;
    if (/^false$/i.test(trimmed)) return false;
    // Any non-empty string that looks like a key reference is treated as present.
    return Boolean(trimmed);
  }
}
