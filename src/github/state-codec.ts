import { createHash } from "node:crypto";
import { z } from "zod";
import type { Conversation, MemoryEntry, Project, Run, Skill, Workflow } from "../domain/entities.js";
import { matter, parseMatter } from "./markdown.js";
import { validateWorkflowGraph } from "../workflow/graph.js";

export const STATE_VERSION = 2;
export const SKILL_DIR = "CodeVia/skills";
export const WORKFLOW_DIR = "CodeVia/workflows";
export const RUN_DIR = "CodeVia/runs";
export const CONVERSATION_DIR = "CodeVia/conversations";
export const RULES_FILE = "CodeVia/rules.md";
export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i);
const strings = z.array(z.string()).max(256);
const timestamps = { createdAt: z.string(), updatedAt: z.string() };
const memoryTypes = z.enum(["architecture", "business", "technical", "decision", "bug", "knowledge", "lesson", "conversation"]);
export const memorySchema = z.object({
  id: z.string().min(1), projectId: z.string().optional(), scope: z.enum(["global", "project", "agent", "task", "conversation"]),
  type: memoryTypes, key: z.string().min(1).max(1000), content: z.string().max(500_000),
  tags: strings, refs: strings, source: z.string(), version: z.number().int().positive(), ...timestamps,
});
export const skillSchema = z.object({
  id: z.string().min(1), projectId: z.string().optional(), slug: slugSchema, name: z.string().min(1),
  description: z.string(), category: z.string(), instructions: z.string().max(100_000), version: z.string(),
  tools: strings, dependencies: z.array(slugSchema).max(64), compatibleAgentTypes: strings,
  metadata: z.record(z.unknown()), enabled: z.boolean(), builtIn: z.boolean(), ...timestamps,
});

/** Stable, project-scoped IDs also isolate imported folders copied between projects. */
export function localId(projectId: string, kind: string, source: string): string {
  return `${kind}-${createHash("sha256").update(`${projectId}\0${source}`).digest("hex").slice(0, 32)}`;
}
export function statePath(dir: string, id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(id)) throw new Error(`Invalid CodeVia file id: ${id}`);
  return `${dir}/${id}.md`;
}
export function isStatePath(path: string): boolean {
  return path.startsWith("CodeVia/") && !/[\\\x00-\x1f\x7f]/.test(path) && path.split("/").every((p) => p && p !== "." && p !== "..");
}

/** Never export connection credentials from platform state; secret references are OK. */
export function repositorySafe<T>(value: T): T {
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).filter(([key]) => !/^(?:api[-_]?keys?|api[-_]?token|bot[-_]?token|github[-_]?token|telegram[-_]?token|bearer[-_]?token|auth[-_]?token|id[-_]?token|access[-_]?token|refresh[-_]?token|token|password|secret|client[-_]?secret|api[-_]?secret|secret[-_]?access[-_]?key|private[-_]?key|signing[-_]?key|connection[-_]?string|authorization|cookie|credentials|encryptedToken|encryptedSecret|secretValueEnc|tokenValueEnc|apiKeyEnc|passwordHash|tokenHash|githubConnection|ownerId|repositoryRevision)$/i.test(key)).map(([key, item]) => [key, visit(item)]));
  };
  return visit(value) as T;
}

export function projectDefinition(project: Project): Record<string, unknown> {
  return repositorySafe({
    name: project.name, description: project.description, capabilities: project.capabilities,
    // `repositories` is required by the manifest schema: writing a project that
    // predates multi-repo support with `undefined` here would leave a definition
    // file that can never be parsed again.
    repositories: project.repositories ?? [], defaultModelId: project.defaultModelId ?? null,
    defaultAgentId: project.defaultAgentId ?? null, telegramChatId: project.telegramChatId ?? null,
    active: project.active, settings: project.settings, repositoryState: project.repositoryState,
  });
}

export function renderSkillFile(skill: Skill): string {
  const { instructions, ...metadata } = repositorySafe(skillSchema.parse(skill));
  // The body IS the instructions, not a duplicate of a front-matter field.
  return matter({ schemaVersion: STATE_VERSION, ...metadata }, instructions);
}
export function parseSkillFile(content: string): Skill {
  const { data, body } = parseMatter(content);
  assertVersion(data);
  return skillSchema.parse({ ...data, instructions: data.schemaVersion !== 2 && typeof data.instructions === "string" ? data.instructions : body.replace(/^\r?\n/, "") });
}

export function assertVersion(data: Record<string, unknown>): void {
  if (data.schemaVersion !== undefined && data.schemaVersion !== STATE_VERSION) throw new Error(`Unsupported CodeVia schema version ${String(data.schemaVersion)}`);
}
export function parseRulesFile(content: string): string[] {
  const { data, body } = parseMatter(content);
  assertVersion(data);
  return data.rules === undefined ? (body.trim() ? [body.trim()] : []) : strings.parse(data.rules);
}
export const renderRulesFile = (rules: string[]) => matter({ schemaVersion: STATE_VERSION, rules }, `# Project rules\n\n${rules.join("\n\n")}`);

const workflowSchema = z.object({
  id: z.string().min(1), projectId: z.string(), name: z.string(), slug: slugSchema,
  description: z.string(), version: z.number().int().positive(), enabled: z.boolean(), ...timestamps,
  nodes: z.array(z.object({ id: z.string(), type: z.enum(["agent", "tool", "condition", "approval", "parallel", "trigger", "webhook", "telegram"]), name: z.string(), config: z.record(z.unknown()), retries: z.number().int().min(0).max(10) })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), condition: z.string().optional() })),
});
export function parseWorkflowFile(content: string): Workflow {
  const { data } = parseMatter(content);
  assertVersion(data);
  const workflow = workflowSchema.parse(data.workflow);
  // Empty workflows are editable drafts; enabled graphs must be executable.
  if (workflow.nodes.length) validateWorkflowGraph(workflow);
  return workflow;
}
export function renderWorkflowFile(workflow: Workflow): string {
  return matter({ schemaVersion: STATE_VERSION, workflow: repositorySafe(workflow) }, `# ${workflow.name}\n\n${workflow.description}`);
}

export function renderRunFile(run: Run): string {
  return matter({ schemaVersion: STATE_VERSION, run: repositorySafe(run) }, `# Run ${run.id}\n\n${run.summary ?? run.error ?? run.status}`);
}
export function renderConversationFile(conversation: Conversation): string {
  return matter({ schemaVersion: STATE_VERSION, conversation: repositorySafe(conversation) }, `# ${conversation.title}\n\n${conversation.summary}`);
}
export function parseHistoryFile<T extends Run | Conversation>(content: string, kind: "run" | "conversation"): T {
  const { data } = parseMatter(content);
  assertVersion(data);
  const item = z.object({ id: z.string().min(1), projectId: z.string(), createdAt: z.string(), updatedAt: z.string() }).passthrough().parse(data[kind]);
  if (kind === "run") {
    z.object({ taskId: z.string(), agentId: z.string(), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "waiting_for_approval"]), steps: z.array(z.object({ index: z.number(), label: z.string(), status: z.string() }).passthrough()) }).passthrough().parse(item);
  } else {
    z.object({ userId: z.string(), source: z.enum(["web", "telegram"]), title: z.string(), summary: z.string(), messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant", "system", "tool"]), content: z.string(), createdAt: z.string() }).passthrough()) }).passthrough().parse(item);
  }
  return item as unknown as T;
}

export function parseMemoryState(content: string): MemoryEntry[] | undefined {
  const { data } = parseMatter(content);
  assertVersion(data);
  if (data.schemaVersion === 2 && data.entries === undefined) throw new Error("Version 2 memory requires an entries array");
  return data.entries === undefined ? undefined : z.array(memorySchema).max(10_000).parse(data.entries);
}

/** Reject recognizable credential material, including secrets pasted into free text. */
export function assertNoCredentialMaterial(content: string): void {
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{25,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,})\b|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:]{1,256}:[^\s/@]{1,4096}@/.test(content)) {
    throw new Error("Secret-like credential material cannot be committed to CodeVia. Use a secret reference instead.");
  }
}
