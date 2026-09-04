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
    const perms = new Set(agent.permissions);
    return this.list().filter(
      (t) => t.permissions.length === 0 || t.permissions.some((p) => perms.has(p)),
    );
  }

  async execute(
    name: string,
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) return { ok: false, output: `Unknown tool: ${name}` };
    const started = Date.now();
    try {
      const result = await tool.execute(ctx, input);
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

export const toolRegistry = new ToolRegistry();
toolRegistry.registerMany(CORE_TOOLS);
