import { CORE_TOOLS } from "./core-tools.js";
import type { ToolDefinition, ToolResult, ToolContext, IToolRegistry } from "./types.js";
import type { Agent } from "../domain/entities.js";
import { sandboxFolderSource } from "../projects/sandbox-runner.js";
import { logger } from "../logger.js";

/**
 * Central tool registry. Tools are name-addressable capabilities that agents can
 * call. Each tool carries its own permission set, input schema, timeout, and a
 * `dangerous` flag that the orchestrator uses to gate destructive operations
 * behind human approval.
 */
export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: ToolDefinition[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  allowedFor(agent: Agent): ToolDefinition[] {
    return this.list().filter((t) => this.isAllowed(t, agent));
  }

  isAllowed(tool: ToolDefinition, agent: Agent): boolean {
    if (!agent.tools.includes(tool.name)) return false;
    if (tool.permissions.length === 0) return true;
    const perms = new Set(agent.permissions);
    // `repository.write` / `github.write` are interchangeable in the matrix.
    if (perms.has("github.write")) perms.add("repository.write");
    if (perms.has("repository.write")) perms.add("github.write");
    return tool.permissions.some((p) => perms.has(p));
  }

  async execute(name: string, ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) return { ok: false, output: `Unknown tool: ${name}` };
    const started = Date.now();
    // Permission matrix: an agent may only call tools whose permission set
    // intersects its own. Denials are audited through the logger + result.
    if (!this.isAllowed(tool, ctx.agent)) {
      logger.warn(`tool ${name} denied for agent ${ctx.agent.slug}`, {
        required: tool.permissions,
        agentPermissions: ctx.agent.permissions,
        correlationId: ctx.correlationId,
      });
      return {
        ok: false,
        output: `Permission denied: ${name} requires one of [${tool.permissions.join(", ")}]`,
        data: { denied: true },
      };
    }
    const projectPermissions = ctx.project.settings?.permissions as Record<string, boolean | undefined> | undefined;
    const deniedByProject = tool.permissions.some((permission) => {
      const key = permission.replace(/^github\./, "repository.");
      return projectPermissions?.[key] === false;
    });
    if (deniedByProject) return { ok: false, output: `Project policy denies ${name}`, data: { denied: true } };
    // Only local-source tools actually enter Docker. GitHub-backed projects read
    // GitHub CI, mock mode simulates it — unless the project is a repo-less
    // folder project, whose real source is localPath and which therefore runs
    // even when no GitHub account is connected. A missing runner cannot execute
    // code. Real sandbox runs are force-human unless the project is explicitly
    // trusted and networking remains off (including install-only network:
    // install scripts would run with network). `sandboxFolderSource` is the single
    // definition of "runs from localPath" (shared with the runner itself).
    const runsFromLocalFolder = sandboxFolderSource(ctx.project) !== undefined;
    const willExecuteSandbox =
      tool.sandboxExecution === true &&
      ctx.project.sourceType === "local" &&
      (ctx.github.kind !== "mock" || runsFromLocalFolder) &&
      ctx.sandboxRunner !== undefined;
    const trustedOfflineSandbox =
      willExecuteSandbox &&
      ctx.project.settings?.trustedForExecution === true &&
      ctx.project.settings?.sandboxNetworkAccess !== true &&
      ctx.project.settings?.sandboxInstallNetwork !== true;
    const needsApproval = tool.dangerous && (!tool.sandboxExecution || (willExecuteSandbox && !trustedOfflineSandbox));
    ctx.checkActive?.();
    if (needsApproval && !ctx.approved) {
      if (!ctx.requestApproval)
        return { ok: false, output: `No approval channel configured for ${name}`, requiresApproval: true };
      // Dangerous tools can bind the approval to the exact subject (e.g. the
      // PR head SHA) before the human decides, so the grant cannot be replayed
      // against a different subject later.
      const binding = tool.prepareApproval ? await tool.prepareApproval(ctx, input) : {};
      const approved = await ctx.requestApproval(`${tool.name}: ${tool.description}`, {
        tool: tool.name,
        input: summarizeInput(input),
        ...binding,
        ...(willExecuteSandbox ? { forceHumanApproval: true } : {}),
      });
      if (!approved) {
        return { ok: false, output: `Approval rejected for ${name}`, requiresApproval: true, data: { rejected: true } };
      }
    }
    ctx.checkActive?.();
    // Cooperative cancellation: the timeout (or the caller's signal) aborts a
    // controller the tool can observe via `ctx.signal`, so the underlying
    // operation stops rather than merely losing a race against its promise.
    const controller = new AbortController();
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    if (controller.signal.aborted)
      return { ok: false, output: `tool ${name} cancelled before it started`, data: { cancelled: true } };
    const toolCtx: ToolContext = { ...ctx, signal: controller.signal };
    try {
      const result = await withTimeout(tool.execute(toolCtx, input), tool.timeoutMs, name, controller);
      ctx.checkActive?.();
      logger.info(`tool ${name} executed`, {
        ok: result.ok,
        projectId: ctx.project.id,
        agentId: ctx.agent.id,
        durationMs: Date.now() - started,
        correlationId: ctx.correlationId,
      });
      return result;
    } catch (err) {
      logger.error(`tool ${name} failed`, { err: String(err), correlationId: ctx.correlationId });
      return { ok: false, output: String(err), data: { timedOut: controller.signal.aborted } };
    }
  }
}

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input))
    out[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v;
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string, controller?: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    const onAbort = (): void => {
      if (timedOut || settled) return;
      finish(() => reject(new Error(`tool ${name} aborted`)));
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      controller?.signal.removeEventListener("abort", onAbort);
      fn();
    };
    const timer =
      ms && ms > 0
        ? setTimeout(() => {
            timedOut = true;
            controller?.abort();
            finish(() => reject(new Error(`tool ${name} timed out after ${ms}ms`)));
          }, ms)
        : undefined;
    timer?.unref?.();
    controller?.signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
    // A promise that settles after the timeout/abort must never surface as an
    // unhandled rejection, nor resurrect the already-rejected result.
    void p.catch(() => undefined);
  });
}

export const toolRegistry = new ToolRegistry();
toolRegistry.registerMany(CORE_TOOLS);
