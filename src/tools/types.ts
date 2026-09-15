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
  /**
   * Read-only local mirror of the project's repository: bare clone read through
   * git *plumbing* (`ls-tree`, `cat-file`, `grep`). It gives tools a whole-tree
   * listing and content search without any GitHub API call — and without ever
   * executing repository code. Optional: tools must fall back to `github`.
   */
  mirror?: import("../github/repo-mirror.js").RepoMirrorService;
  /** Mirror isolation scope — the acting account id. Mirrors are never shared across accounts. */
  mirrorScope?: string;
  /** Bearer token for mirroring a private repository (git HTTP header only; never logged). */
  mirrorToken?: string;
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
