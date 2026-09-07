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
 *
 * The plan is **permission-aware**: every tool step is executable by THIS agent
 * (the tool is in the agent's toolbox and the agent holds one of the tool's
 * required permissions). Read-only agents (research, QA, review, …) therefore
 * get diagnosis/analysis plans that end with a summary + memory write instead
 * of a pull-request step they could never execute.
 */
export function defaultPlanFor(agent: Agent, task: Task): PlanStep[] {
  const goal = task.title;
  const tools = new Set(agent.tools ?? []);
  const perms = new Set(agent.permissions ?? []);
  // `repository.write` / `github.write` are interchangeable in the matrix.
  if (perms.has("github.write")) perms.add("repository.write");
  if (perms.has("repository.write")) perms.add("github.write");

  /** True when the agent may call `tool` (toolbox + at least one required permission). */
  const can = (tool: string, ...required: string[]): boolean =>
    tools.has(tool) && (required.length === 0 || required.some((p) => perms.has(p)));
  const maybe = (tool: string, ...required: string[]): string | undefined =>
    can(tool, ...required) ? tool : undefined;

  const inspectTool =
    maybe("list_branches", "github.read") ??
    maybe("list_commits", "github.read") ??
    maybe("read_file", "github.read");
  const readTool = maybe("read_file", "github.read");
  const canWrite = can("write_file", "github.write", "repository.write");
  const canPR = can("create_pull_request", "github.write");
  const canRemember = can("save_memory", "memory.write");
  // NOTE: `run_tests` / `run_build` shell out to real commands. There is no
  // isolated per-project execution workspace yet, so deterministic plans keep
  // "Run tests" / "Run build" as plain (attested) steps instead of executing
  // the platform's own commands. Explicit workflow tool-nodes may still call
  // them with a proper command/cwd.
  // Memory writes need deterministic input (key + content); the plan derives
  // both from the task so the step can never fail on missing input.
  const remember = (type: string): PlanStep => ({
    label: "Save findings to memory",
    tool: "save_memory",
    input: {
      type,
      key: `${agent.slug}/${task.id}`,
      content: `${agent.name} — ${task.title}\n\n${task.description || "(no description)"}\n\nProject: ${task.projectId}`,
      tags: [agent.type, task.id],
    },
  });
  const rememberType =
    agent.type === "debugging" ? "bug"
    : agent.type === "system-architect" ? "architecture"
    : agent.type === "qa-test" ? "technical"
    : agent.type === "research" ? "knowledge"
    : "knowledge";

  const staticSteps: PlanStep[] = [
    { label: "Understand request" },
    inspectTool
      ? { label: "Inspect repository", tool: inspectTool }
      : { label: "Review project context" },
  ];

  let core: PlanStep[] = [];
  switch (agent.type) {
    case "research":
      core = [
        { label: "Analyze problem" },
        { label: "Research and compare sources" },
        { label: "Propose recommendations" },
      ];
      break;
    case "backend-developer":
    case "frontend-developer":
    case "uiux":
    case "database":
    case "refactoring":
    case "performance":
    case "documentation":
      core = [
        { label: "Analyze current implementation", ...(readTool ? { tool: readTool } : {}) },
        { label: "Plan the change", input: { goal } },
        {
          label: "Implement the change",
          ...(canWrite ? { tool: "write_file" } : {}),
        },
        { label: "Run build" },
      ];
      break;
    case "debugging":
      // Diagnosis only — the fix itself is handed to a writer agent (#16 routing).
      core = [
        { label: "Reproduce and analyze failure" },
        { label: "Inspect related code", ...(readTool ? { tool: readTool } : {}) },
        { label: "Diagnose root cause" },
        { label: "Propose fix and responsible agent", chainTo: "backend-developer" },
      ];
      break;
    case "qa-test":
      core = [
        { label: "Detect affected files", ...(readTool ? { tool: readTool } : {}) },
        { label: "Run test suite" },
        { label: "Classify failures" },
      ];
      break;
    case "security":
      core = [
        { label: "Analyze security posture", ...(readTool ? { tool: readTool } : {}) },
        { label: "Report findings" },
      ];
      break;
    case "system-architect":
      core = [{ label: "Review architecture" }, { label: "Propose design" }];
      break;
    case "devops":
      core = [{ label: "Run build" }, { label: "Review deployment configuration" }];
      break;
    case "release":
      core = [
        {
          label: "Review changes",
          ...(maybe("list_commits", "github.read") ? { tool: "list_commits" } : {}),
        },
        { label: "Prepare release notes" },
      ];
      break;
    default:
      core = [{ label: "Analyze task", input: { goal } }, { label: "Produce result" }];
  }

  // Writers finish with tests + review + PR (approval-gated); everyone else
  // finishes with a summary, persisted to memory when the agent is allowed to.
  const endSteps: PlanStep[] = canPR
    ? [
        { label: "Run tests" },
        { label: "Code review" },
        { label: "Create pull request", tool: "create_pull_request", requiresApproval: true },
      ]
    : canRemember
      ? [{ label: "Summarize result" }, remember(rememberType)]
      : [{ label: "Summarize result" }];

  return [...staticSteps, ...core, ...endSteps];
}

export const CHAIN_TARGET: Record<string, AgentType> = {
  "qa-test": "debugging",
  debugging: "backend-developer",
  backend: "code-reviewer",
};
