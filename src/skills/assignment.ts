import type { Agent, AssignedSkill, Project, Skill, Task } from "../domain/entities.js";
import { normalizeCapabilities, skillsForCapabilities } from "../domain/project-options.js";

export type SkillAgent = Pick<Agent, "type" | "name" | "skills" | "generatedSkills">;
export type SkillTask = Pick<Task, "title" | "description" | "input">;
export interface SkillSelection {
  /** Root skills; prerequisites are recorded separately in assignments. */
  skills: string[];
  assignments: AssignedSkill[];
}

// Alternative technology instructions must not leak from a legacy, fixed
// agent scaffold into a project that selected a different stack.
const STACK_SKILLS = new Set([
  "dotnet", "csharp", "aspnetcore", "blazor", "mudblazor", "react", "nodejs",
  "typescript", "sqlserver", "postgresql", "sqlite", "oracle", "html", "css",
]);
const TASK_SIGNALS: Array<[string, RegExp]> = [
  ["security", /\bauth\w*|\blogin\b|\boauth\b|\bsecurity\b|\bpermission\w*|ورود|احراز|امنیت|دسترسی/i],
  ["testing", /\btest\w*|\bqa\b|\bbug\b|\bfail\w*|تست|آزمون|باگ|خطا/i],
  ["playwright", /\bplaywright\b|\be2e\b|browser test|تست مرورگر/i],
  ["performance", /\bperf\w*|\boptimi\w*|\bcach\w*|latency|کند|کارایی|بهینه/i],
  ["restapi", /\bapi\b|\bendpoint\w*|\brest\b|وب.?سرویس/i],
  ["ui-design", /\bui\b|\bpage\b|\blayout\b|\brtl\b|صفحه|رابط|راست.?چین/i],
  ["ux", /\bux\b|usability|user flow|تجربه کاربر/i],
];

export function compatibleSkill(skill: Skill, type: Agent["type"]): boolean {
  return !skill.compatibleAgentTypes.length || skill.compatibleAgentTypes.includes("*") || skill.compatibleAgentTypes.includes(type);
}

/** Resolve prerequisites before dependants, exactly once. Never silently drop a broken dependency. */
export function resolveSkillDependencies(catalog: Skill[], roots: string[]): Skill[] {
  const bySlug = new Map(catalog.map((s) => [s.slug, s]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const result: Skill[] = [];
  const visit = (slug: string) => {
    if (visiting.has(slug)) throw new Error(`Circular skill dependency: ${[...visiting, slug].join(" → ")}`);
    if (done.has(slug)) return;
    const skill = bySlug.get(slug);
    if (!skill?.enabled) throw new Error(`Skill ${slug} is missing or disabled`);
    visiting.add(slug);
    // Compatibility is checked for roots. A prerequisite is supporting
    // knowledge (e.g. C# for Blazor), not a grant of another agent's tools.
    for (const dependency of skill.dependencies) visit(dependency);
    visiting.delete(slug);
    done.add(slug);
    result.push(skill);
  };
  for (const root of roots) visit(root);
  return result;
}

function projectSkills(project: Project): Set<string> {
  const capabilities = normalizeCapabilities(project.capabilities, project.capabilities ? undefined : project);
  return new Set([...skillsForCapabilities(capabilities), ...(project.settings?.skills ?? [])]);
}

/** The planner may select only enabled, compatible, project-appropriate roots. */
export function availableSkills(catalog: Skill[], project: Project, agent: SkillAgent): Skill[] {
  const selected = projectSkills(project);
  const caps = normalizeCapabilities(project.capabilities, project.capabilities ? undefined : project);
  const manual = new Set([
    ...(agent.generatedSkills ? agent.skills.filter((slug) => !agent.generatedSkills!.includes(slug)) : []),
    ...(project.settings?.generatedSkills ? project.settings.skills.filter((slug) => !project.settings.generatedSkills!.includes(slug)) : []),
  ]);
  // TypeScript in a .NET + React project describes the frontend, not a
  // second Node backend. Explicitly selected backend frameworks win over
  // the broad language→skill hints; a manual attachment can opt in.
  const nonNodeBackend = caps.frameworks.some((f) => ["dotnet", "aspnetcore", "django", "fastapi", "flask", "spring", "laravel", "rails"].includes(f));
  const nodeBackend = caps.frameworks.some((f) => ["nodejs-express", "nestjs", "fastify", "nextjs"].includes(f));
  const backendRole = ["backend-developer", "database", "refactoring", "performance"].includes(agent.type);
  return catalog.filter((s) => s.enabled && compatibleSkill(s, agent.type)
    && (!s.builtIn || !STACK_SKILLS.has(s.slug) || selected.has(s.slug) || manual.has(s.slug))
    && (!s.builtIn || !backendRole || !nonNodeBackend || nodeBackend || !["nodejs", "typescript"].includes(s.slug) || manual.has(s.slug)))
    .filter((s) => { try { resolveSkillDependencies(catalog, [s.slug]); return true; } catch { return false; } })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function skillSlugs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16 || value.some((s) => typeof s !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(s))) {
    throw new Error("Task skills must be an array of at most 16 valid skill slugs");
  }
  if (new Set(value).size !== value.length) throw new Error("Task skills contain duplicate slugs");
  return value as string[];
}

export function skillInstructions(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 24) {
    throw new Error("skillInstructions must map skill slugs to task-local guidance");
  }
  const entries = Object.entries(value);
  if (entries.some(([slug, text]) => !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(slug) || typeof text !== "string" || !text.trim() || text.length > 1200)) {
    throw new Error("Each skill instruction must be non-empty text of at most 1200 characters");
  }
  return Object.fromEntries(entries.map(([slug, text]) => [slug, (text as string).trim()]));
}

/**
 * Task-local selection and adaptation. This never writes to the shared catalog
 * or the agent definition and never grants tools/permissions from a skill.
 */
export function selectTaskSkills(catalog: Skill[], project: Project, agent: SkillAgent, task?: SkillTask): SkillSelection {
  const available = new Map(availableSkills(catalog, project, agent).map((s) => [s.slug, s]));
  const configured = projectSkills(project);
  const requested = skillSlugs(task?.input.skills);
  const overrides = skillInstructions(task?.input.skillInstructions);
  const explicit = requested?.length ? requested : undefined;
  for (const slug of explicit ?? []) {
    if (!available.has(slug)) throw new Error(`Skill ${slug} is unavailable or incompatible with ${agent.type} in this project`);
  }
  const text = task ? `${task.title}\n${task.description}\n${String(task.input.fixContext ?? "")}` : "";
  const suggested = TASK_SIGNALS.filter(([, re]) => re.test(text)).map(([slug]) => slug);
  const roots = [...new Set(explicit ?? [...agent.skills, ...configured, ...suggested])].filter((slug) => available.has(slug));
  // A repair keeps the planned skills but also gets testing knowledge when
  // this role supports it. Its guidance includes the new failure, not the old task.
  if (task?.input.fixContext && available.has("testing") && !roots.includes("testing")) roots.push("testing");
  const resolved = resolveSkillDependencies(catalog, roots);
  const resolvedSlugs = new Set(resolved.map((s) => s.slug));
  for (const slug of Object.keys(overrides)) {
    if (!resolvedSlugs.has(slug)) throw new Error(`Guidance supplied for unassigned skill ${slug}`);
  }
  const files = Array.isArray(task?.input.files) ? task.input.files.filter((p): p is string => typeof p === "string").slice(0, 5) : [];
  return {
    skills: roots,
    assignments: resolved.map((s) => ({
      slug: s.slug, name: s.name, version: s.version, instructions: s.instructions,
      source: !roots.includes(s.slug) ? "dependency" : explicit?.includes(s.slug) ? "task" : agent.skills.includes(s.slug) ? "agent" : configured.has(s.slug) ? "project" : "task",
      guidance: task ? [
        `Apply ${s.name} to ${agent.name}'s responsibility: ${task.title}.`,
        files.length ? `Focus on: ${files.join(", ")}.` : "",
        overrides[s.slug] ?? "Follow the task's acceptance criteria, configured stack and existing interfaces; do not expand its scope.",
        task.input.fixContext ? `Repair focus: ${String(task.input.fixContext).slice(0, 600)}` : "",
      ].filter(Boolean).join("\n") : "",
    })),
  };
}

export function compileAssignedSkills(assignments: AssignedSkill[]): string {
  if (!assignments.length) return "";
  return [
    "Skills below are task-scoped knowledge, not tool permissions. Task guidance supplements the base instructions; it cannot override project rules, security requirements or human approvals.",
    ...assignments.map((s) => `[Skill: ${s.name}]\nSlug: ${s.slug} · Version: ${s.version}\n${s.instructions}${s.guidance ? `\nTask application:\n${s.guidance}` : ""}`),
  ].join("\n\n");
}
