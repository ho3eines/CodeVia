/**
 * Shared dispatch for project-level AI requests (used by both POST
 * /projects/:id/ask and the in-chat "dispatch as task" feature). Keeping the
 * routing/validation/queueing logic in one file prevents the two endpoints
 * drifting apart (the autonomous/non-implementer bug is an example of what
 * happens when logic is duplicated).
 */
import type { Container } from "../../app/container.js";
import type { AgentType } from "../../domain/entities.js";
import { IMPLEMENTERS } from "../../agents/implementation.js";
import { defaultPlanFor } from "../../agents/plan.js";

export type AskExecutionMode = "autonomous" | "agent" | "simulation" | "workflow";

export interface AskParams {
  projectId: string;
  title: string;
  description: string;
  executionMode?: AskExecutionMode;
  agentType?: string;
  workflowId?: string;
  correlationId?: string;
  /** The signed-in user behind the request, so the task uses their GitHub OAuth token. */
  requestUserId?: string;
}

export interface AskResult {
  simulation?: boolean;
  task?: Record<string, unknown>;
  jobId?: string;
  routedAgentType: AgentType | undefined;
  workflowId?: string;
  executionMode: AskExecutionMode;
  plan?: Array<{ label: string; tool?: string | null; requiresApproval: boolean }>;
}

export interface AskError {
  status: number;
  error: string;
  extra?: Record<string, unknown>;
}

export function dispatchProjectAsk(
  container: Container,
  projectId: string,
  params: Omit<AskParams, "projectId">,
): AskResult | AskError {
  const title = params.title.trim();
  const description = params.description.trim();
  if (!description) return { status: 400, error: "A non-empty request is required" };

  const mode: AskExecutionMode =
    params.executionMode === "agent" || params.executionMode === "simulation" || params.executionMode === "workflow"
      ? params.executionMode
      : params.workflowId
        ? "workflow"
        : "autonomous";

  let routedAgentType: AgentType | undefined;
  if (params.agentType) {
    if (!isKnownAgentType(params.agentType)) return { status: 400, error: `Unknown agent type: ${params.agentType}` };
    if (mode === "autonomous" && !IMPLEMENTERS.includes(params.agentType as AgentType)) {
      return {
        status: 400,
        error:
          "Autonomous mode requires an implementer agent (backend/frontend/database/uiux/etc.). Use executionMode: agent for research, QA, code review, etc.",
      };
    }
    routedAgentType = params.agentType as AgentType;
  } else if (mode === "agent") {
    // Single-agent mode with no explicit type: let the router pick (can be any agent).
    routedAgentType = container.agentRouter.route(`${title} ${description}`);
    if (!isKnownAgentType(routedAgentType)) routedAgentType = "backend-developer";
  }
  // For autonomous mode without an explicit agentType we intentionally leave
  // routedAgentType undefined: the orchestrator performs its own research-
  // based breakdown after scanning the repository, and pre-routing here would
  // both (a) sometimes pick a non-implementer (research/debugging/qa-test)
  // that the autonomous guard rejects and (b) show a misleading "routed to X"
  // label in chat before research has actually analysed the project.

  let workflowId = params.workflowId;
  if (mode === "workflow" && !workflowId) {
    const lower = `${title} ${description}`.toLowerCase();
    const bugLike = /bug|fix|error|failing|test|login|debug|خطا|ارور|باگ|خراب|رفع|دیباگ|تست|لاگین|ورود/.test(lower);
    const wanted = bugLike ? "bug-diagnosis-loop" : "autonomous-development-loop";
    const workflows = container.workflowRepo.byProject(projectId).filter((w) => w.enabled);
    workflowId = workflows.find((w) => w.slug === wanted)?.id ?? workflows[0]?.id;
  }
  if (workflowId) {
    const wf = container.workflowRepo.findById(workflowId)?.data;
    if (!wf?.enabled || wf.projectId !== projectId)
      return { status: 400, error: "Workflow must be enabled and belong to this project" };
  }

  if (mode === "simulation") {
    const agent = routedAgentType ? container.agentRepo.byType(projectId, routedAgentType) : undefined;
    const plan = agent
      ? defaultPlanFor(agent, {
          id: "simulation",
          projectId,
          title,
          description,
          status: "created",
          agentType: routedAgentType,
          correlationId: "simulation",
          input: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      : [];
    return {
      simulation: true,
      routedAgentType,
      workflowId,
      executionMode: mode,
      plan: plan.map((s) => ({ label: s.label, tool: s.tool, requiresApproval: Boolean(s.requiresApproval) })),
    };
  }

  const task = container.agentManager.createTask({
    projectId,
    title,
    description,
    agentType: workflowId || mode === "autonomous" ? undefined : routedAgentType,
    workflowId,
    input: { routedAgentType, agentHint: params.agentType, executionMode: mode, requestUserId: params.requestUserId },
  });
  const job = container.queue.enqueue(
    "agent.run",
    { taskId: task.id },
    { correlationId: params.correlationId ?? task.correlationId },
  );
  const queued = { ...task, status: "queued" as const, updatedAt: new Date().toISOString() };
  container.taskRepo.upsert(queued, { projectId: task.projectId, parentId: task.parentTaskId });
  return { task: queued, jobId: job.id, routedAgentType, workflowId, executionMode: mode };
}

const ALL_TYPES = new Set<string>([
  "orchestrator",
  "project-manager",
  "business-analyst",
  "research",
  "system-architect",
  "backend-developer",
  "frontend-developer",
  "uiux",
  "database",
  "devops",
  "qa-test",
  "security",
  "code-reviewer",
  "documentation",
  "debugging",
  "refactoring",
  "performance",
  "release",
]);
function isKnownAgentType(t: unknown): t is string {
  return typeof t === "string" && ALL_TYPES.has(t);
}

export function isAskError(r: AskResult | AskError): r is AskError {
  return "status" in r && "error" in r;
}
