import type { IGitHubService } from "../github/types.js";
import type { Agent, Project } from "../domain/entities.js";
import type { Logger } from "../logger.js";

export interface ToolContext {
  project: Project;
  agent: Agent;
  github: IGitHubService;
  logger: Logger;
  /** Correlation id for audit + tracing. */
  correlationId: string;
  /** Runtime workspace root (local execution sandbox). */
  workspaceRoot?: string;
  /** Requests a human approval for a dangerous operation. */
  requestApproval?: (action: string, detail: Record<string, unknown>) => Promise<boolean>;
  /** Set by the caller when approval for this invocation was already granted (skip the dangerous-tool gate). */
  approved?: boolean;
  /** Memory store for the project (search / append). */
  memory?: import("../memory/store.js").IMemoryStore;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  data?: Record<string, unknown>;
  /** Set true when the action needs human approval before continuing. */
  requiresApproval?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Whether the tool can perform destructive/irreversible actions. */
  dangerous: boolean;
  inputSchema: Record<string, unknown>;
  permissions: string[];
  timeoutMs: number;
  execute(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult>;
}

export interface IToolRegistry {
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  /** List tools allowed by an agent's permission set. */
  allowedFor(agent: Agent): ToolDefinition[];
}
