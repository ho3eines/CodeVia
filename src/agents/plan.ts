import type { Agent, AgentType, Task } from "../domain/entities.js";

export interface PlanStep {
  label: string;
  tool?: string;
  input?: Record<string, unknown>;
  /** Dangerous step that requires human approval before running. */
  requiresApproval?: boolean;
  /** For chaining: ask a downstream agent to continue. */
  chainTo?: AgentType;
}

/**
 * Produces a step plan for an agent run. When a real (non-mock) provider is
 * configured, `planFromModel` can be used to let the model decide; otherwise the
 * safe deterministic default plan is used (keeps tests and Simulation Mode stable).
 */
export function defaultPlanFor(agent: Agent, task: Task): PlanStep[] {
  const goal = task.title;
  const staticSteps: PlanStep[] = [
    { label: "Understand request" },
    { label: "Inspect repository", tool: "list_branches" },
  ];
  const endSteps: PlanStep[] = [
    { label: "Run tests" },
    { label: "Code review" },
    { label: "Create pull request", tool: "create_pull_request", requiresApproval: true },
  ];
  let core: PlanStep[] = [];
  switch (agent.type) {
    case "research":
      core = [
        { label: "Analyze problem" },
        { label: "Research and compare sources" },
        { label: "Propose recommendations" },
        { label: "Save findings to memory" },
      ];
      break;
    case "backend-developer":
    case "frontend-developer":
    case "uiux":
    case "database":
    case "debugging":
    case "refactoring":
    case "performance":
      core = [
        { label: "Analyze current implementation" },
        { label: "Plan the change", input: { goal } },
        { label: "Implement the change", tool: "write_file", requiresApproval: false },
        { label: "Run build" },
      ];
      break;
    case "qa-test":
      core = [
        { label: "Detect affected files" },
        { label: "Run test suite" },
        { label: "Classify failures" },
      ];
      break;
    case "security":
      core = [{ label: "Analyze security posture" }, { label: "Report findings", tool: "read_file" }];
      break;
    case "system-architect":
      core = [{ label: "Review architecture" }, { label: "Propose design" }];
      break;
    default:
      core = [{ label: "Analyze task", input: { goal } }, { label: "Produce result" }];
  }
  return [...staticSteps, ...core, ...endSteps];
}

export const CHAIN_TARGET: Record<string, AgentType> = {
  "qa-test": "debugging",
  debugging: "backend-developer",
  backend: "code-reviewer",
};
