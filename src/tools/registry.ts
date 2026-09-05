import { CORE_TOOLS } from "./core-tools.js";
import type { ToolDefinition, ToolResult, ToolContext, IToolRegistry } from "./types.js";
import type { Agent } from "../domain/entities.js";
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
    if (tool.permissions.length === 0) return true;
    const perms = new Set(agent.permissions);
    // `repository.write` / `github.write` are interchangeable in the matrix.
    if (perms.has("github.write")) perms.add("repository.write");
    if (perms.has("repository.write")) perms.add("github.write");
    return tool.permissions.some((p) => perms.has(p));
  }

  async execute(
    name: string,
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
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
      return { ok: false, output: `Permission denied: ${name} requires one of [${tool.permissions.join(", ")}]`, data: { denied: true } };
    }
    // Dangerous tools always pass through the approval policy unless the caller
    // already obtained approval for this exact step (`ctx.approved`).
    if (tool.dangerous && !ctx.approved && ctx.requestApproval) {
      const approved = await ctx.requestApproval(`${tool.name}: ${tool.description}`, { tool: tool.name, input: summarizeInput(input) });
      if (!approved) {
        return { ok: false, output: `Approval rejected for ${name}`, requiresApproval: true, data: { rejected: true } };
      }
    }
    try {
      const result = await withTimeout(tool.execute(ctx, input), tool.timeoutMs, name);
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
      return { ok: false, output: String(err) };
    }
  }
}

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v;
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`tool ${name} timed out after ${ms}ms`)), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export const toolRegistry = new ToolRegistry();
toolRegistry.registerMany(CORE_TOOLS);
