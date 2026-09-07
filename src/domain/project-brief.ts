import type { Project } from "./entities.js";

/**
 * Project brief — the single source of truth that turns the selections made
 * in the project definition (platforms, languages, frameworks, databases,
 * deployment targets, features, integrations, agent roster, repositories)
 * into prompt text for agents.
 *
 * Used by:
 * - the agent generator (system prompts, rebuilt on every on-board),
 * - the context engine (the `project-profile` source of every model call),
 * - the autonomous loop (AI breakdown + code generation prompts).
 *
 * Keep it compact: it is injected into model context on every agent run.
 */
export function projectBriefLines(project: Project): string[] {
  const c = project.capabilities;
  if (!c) {
    return [
      `Tech: ${project.framework ?? "unknown"} / ${project.primaryLanguage ?? "unknown"} / ${project.database ?? "unknown"}`,
    ];
  }
  const line = (label: string, values: string[]): string | undefined =>
    values.length ? `${label}: ${values.join(", ")}` : undefined;
  const repos = (project.repositories ?? []).map((r) => `${r.repo}@${r.branch} (${r.role})`);
  return [
    line("Platforms", c.platforms),
    line("Languages", c.languages),
    line("Frameworks", c.frameworks),
    line("Databases", c.databases),
    line("Deployment", c.deploymentTargets),
    line("Key features", c.features),
    line("Integrations", c.integrations),
    repos.length ? `Repositories: ${repos.join("; ")}` : undefined,
    c.agentTypes?.length ? `Team roster: ${c.agentTypes.join(", ")}` : undefined,
  ].filter((x): x is string => !!x);
}

/** Full brief with project header — for run context and AI prompts. */
export function projectBrief(project: Project): string {
  return [
    `Project: ${project.name} (${project.slug})`,
    project.description ? `Definition: ${project.description.slice(0, 300)}` : undefined,
    `Repository: ${project.configRepo} @ ${project.branch}`,
    ...projectBriefLines(project),
  ]
    .filter((x): x is string => !!x)
    .join("\n");
}
