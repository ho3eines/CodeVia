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
  /** Configured base branch; source tools must never write to it directly. */
  baseBranch?: string;
  /** Cooperative cancellation and budget check, also used after approval waits. */
  checkActive?: () => void;
  /**
   * Abort signal bound to the tool's execution window. The registry aborts it
   * when the tool's timeout elapses (or the caller's own signal aborts), so a
   * cooperative tool can stop its underlying operation instead of merely racing
   * its promise. Tools performing multi-step or network work must observe it.
   */
  signal?: AbortSignal;
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
  /**
   * Optional hook that enriches the approval detail for a dangerous tool before
   * the human-approval gate fires. Used to bind the approval to the exact
   * subject being authorized — e.g. a merge approval carries the PR head SHA so
   * a PR that moves on after approval cannot be merged under a stale grant.
   */
  prepareApproval?(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface IToolRegistry {
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  /** List tools allowed by an agent's permission set. */
  allowedFor(agent: Agent): ToolDefinition[];
}
