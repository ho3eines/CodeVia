import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import { randomUUID } from "node:crypto";
import type { ConversationMessage } from "../../domain/entities.js";

export function registerConversationRoutes(app: FastifyInstance, container: Container): void {
  app.get("/conversations", { schema: { tags: ["conversations"] } }, async (req) => {
    const q = req.query as { projectId?: string };
    let convs = container.conversationRepo.findMany();
    if (q.projectId) convs = container.conversationRepo.findMany({ projectId: q.projectId });
    return convs.map((r) => r.data);
  });

  app.post("/conversations", { schema: { tags: ["conversations"] } }, async (req) => {
    const b = req.body as Record<string, unknown>;
    const conv = container.conversationRepo.create({
      projectId: String(b.projectId),
      userId: String(b.userId ?? "user-demo"),
      source: (b.source as "web" | "telegram") ?? "web",
      title: String(b.title ?? "Conversation"),
      messages: [],
      modelId: b.modelId as string | undefined,
      activeAgentId: b.activeAgentId as string | undefined,
    });
    return conv;
  });

  app.get("/conversations/:id", { schema: { tags: ["conversations"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.conversationRepo.findById(id)?.data ?? { error: "conversation not found" };
  });

  app.post("/conversations/:id/messages", { schema: { tags: ["conversations"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { role?: "user" | "assistant"; content?: string };
    const msg: ConversationMessage = {
      id: randomUUID(),
      role: b.role ?? "user",
      content: b.content ?? "",
      createdAt: new Date().toISOString(),
    };
    const updated = container.conversationRepo.addMessage(id, msg);
    // Auto-summarize when a conversation grows long (AI Context Compression).
    if (updated && updated.messages.length > 20 && !updated.summary) {
      const summary = updated.messages.slice(-5).map((m) => `${m.role}: ${m.content.slice(0, 120)}`).join("\n");
      container.conversationRepo.updateSummary(id, summary);
    }
    return updated ?? { error: "conversation not found" };
  });

  app.post("/conversations/:id/summarize", { schema: { tags: ["conversations"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const conv = container.conversationRepo.findById(id);
    if (!conv) return { error: "conversation not found" };
    const summary = conv.data.messages
      .slice(-10)
      .map((m) => `${m.role}: ${m.content.slice(0, 150)}`)
      .join("\n");
    container.conversationRepo.updateSummary(id, summary);
    return summary;
  });

  app.delete("/conversations/:id", { schema: { tags: ["conversations"] } }, async (req) => {
    const { id } = req.params as { id: string };
    container.conversationRepo.deleteById(id);
    return { ok: true };
  });
}
