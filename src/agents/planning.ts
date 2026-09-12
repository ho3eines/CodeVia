import type { Agent, Project, Task } from "../domain/entities.js";
import type { SkillRegistry } from "../skills/registry.js";
import { projectBrief } from "../domain/project-brief.js";
import { MAX_SUBTASKS, repositoryForAgent } from "./implementation.js";

export const RESEARCH_INSTRUCTION = [
  "You are a senior business analyst writing an implementation brief as the project's Research Agent.",
  "Refine the original request into a precise, implementable specification, preserving its intent and language.",
  "Treat the current project settings, rules, selected stack, linked repositories and supplied source evidence as constraints, not suggestions.",
  "Inspect existing architecture and reuse its components. Distinguish verified facts, reasonable assumptions and unanswered questions; never invent research sources or unsupported requirements.",
  "Return a concise professional brief (under 600 words) with: objective, functional requirements, non-goals, affected files/components, shared API/data contracts, testable acceptance criteria, risks/approvals, and assumptions/open questions.",
  "Flag blockers explicitly. Do not silently change the project's framework, database, permissions or scope to resolve ambiguity.",
].join("\n");

export function researchRequest(project: Project, task: Task, repositoryContext: string): string {
  return [
    `Original request:\nTask: ${task.title}\n${task.description}`,
    `Current project definition:\n${projectBrief(project)}`,
    repositoryContext,
    "Expand missing implementation details only when they are supported by the request and repository. Keep uncertain decisions clearly labelled as assumptions or blockers.",
  ].join("\n\n");
}

export const PLANNING_INSTRUCTION = [
  "You are an engineering manager breaking a researched request into executable specialist subtasks.",
  "Reply ONLY with a JSON array. Do not output private reasoning, markdown fences or tool commands.",
  "Each task has exactly one enabled owner. Select skills only from that owner's supplied catalog; adapt their application to the task, never modify global skills or tool permissions.",
  "Respect the research brief, configured stack and project rules. Do not add unrelated work or silently drop requirements. Flag impossible scope instead of inventing an agent or skill.",
].join("\n");

export function planningRequest(
  project: Project,
  task: Task,
  brief: string,
  repositoryContext: string,
  agents: Agent[],
  skills: SkillRegistry,
): string {
  const roster = agents.map((agent) => {
    const repo = repositoryForAgent(project, agent.type);
    const catalog = skills.availableFor(project, agent);
    return {
      agentType: agent.type,
      duty: agent.description,
      repository: `${repo.repo}@${repo.branch}`,
      skills: catalog.map((s) => ({
        slug: s.slug,
        description: s.description.slice(0, 180),
        dependencies: s.dependencies,
      })),
    };
  });
  return [
    `Task: ${task.title}\n${task.description}`,
    `Current project definition:\n${projectBrief(project)}`,
    `Research brief:\n${brief}`,
    repositoryContext,
    `Allowed agentType values (enabled in this project): ${agents.map((a) => a.type).join(", ")}.`,
    `Owner/skill catalog (repository assignment is enforced by CodeVia):\n${JSON.stringify(roster)}`,
    `Return 1–${MAX_SUBTASKS} focused items. Schema for each item:\n${JSON.stringify({ id: "stable-step-id", agentType: "one allowed type", title: "Specific deliverable", description: "Only this specialist's responsibility and shared contracts", files: ["repo/relative/path"], dependsOn: ["another-step-id"], acceptanceCriteria: ["Observable, testable result"], skills: ["available-skill-slug"], skillInstructions: { "available-skill-slug": "Task-specific application of this skill (max 240 characters recommended)" } })}`,
    "Use unique ids and 1–5 exact file paths per task. dependsOn must reference ids in this plan, without cycles. Independent tasks have an empty dependsOn list.",
    "Reuse the exact existing files, and define matching API contracts for backend/frontend. Order consumers after their producers using dependsOn. Include appropriate test/doc changes in the file lists.",
    "Provide non-empty acceptanceCriteria for each item. Choose a focused skill set (including relevant language/framework knowledge); do not copy the entire catalog into every task.",
    `Stay within the task budget: ${JSON.stringify(project.settings.budget)}. Each file needs a model call; research/planning also consume calls and tokens. Do not claim deployment, migrations or tests were executed.`,
  ].join("\n\n");
}
