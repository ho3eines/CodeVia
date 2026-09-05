import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import type { ApprovalStatus } from "../../approvals/service.js";
import { resolveRequestUser } from "../auth.js";

/**
 * Human-in-the-loop approvals: list what is waiting, approve/reject from the
 * web UI. Telegram uses the same service through inline-keyboard callbacks.
 */
export function registerApprovalRoutes(app: FastifyInstance, container: Container): void {
  app.get("/approvals", { schema: { tags: ["approvals"] } }, async (req) => {
    const q = req.query as { projectId?: string; status?: ApprovalStatus };
    return container.approvals.list({ projectId: q.projectId, status: q.status });
  });

  app.get("/approvals/:id", { schema: { tags: ["approvals"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = container.approvals.get(id);
    if (!a) {
      reply.code(404);
      return { error: "approval not found" };
    }
    return a;
  });

  for (const decision of ["approve", "reject"] as const) {
    app.post(`/approvals/:id/${decision}`, { schema: { tags: ["approvals"] } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { note?: string };
      const { user } = resolveRequestUser(req, container);
      try {
        return container.approvals.decide(id, decision, {
          user: user.name || user.email || user.id,
          source: "web",
          note: body.note,
        });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        reply.code(status);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });
  }
}
