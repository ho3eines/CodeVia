import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import { randomUUID } from "node:crypto";
import type { ConversationMessage } from "../../domain/entities.js";

const SUMMARY_SYSTEM_PROMPT =
  "You compress a chat between a user and an AI engineering assistant into a concise memory summary. " +
  "Keep: goals, decisions, constraints, open questions, file/branch/PR names, and unresolved bugs. " +
  "Drop pleasantries. Output 5-10 bullet points, no preamble, same language as the conversation.";

function heuristicSummary(messages: ConversationMessage[], take: number): string {
  return messages
    .slice(-take)
    .map((m) => `${m.role}: ${m.content.replace(/\s+/g, " ").slice(0, 150)}`)
    .join("\n");
}

/** AI-powered context compression with a deterministic fallback when no model is configured. */
async function summarizeConversation(
  container: Container,
  conv: { id: string; projectId: string; modelId?: string; summary?: string; messages: ConversationMessage[] },
): Promise<{ summary: string; method: "ai" | "heuristic"; modelId?: string }> {
  const transcript = conv.messages
    .slice(-60)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}`)
    .join("\n\n");
  try {
    const res = await container.aiText.complete({
      category: "fast",
      preferredModelId: conv.modelId,
      projectId: conv.projectId,
      correlationId: `conv-${conv.id}`,
      maxTokens: 600,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        {
          role: "user",
          content: (conv.summary ? `Previous summary:\n${conv.summary}\n\n` : "") + `Conversation:\n${transcript}`,
        },
      ],
    });
    if (res && res.content.trim()) return { summary: res.content.trim(), method: "ai", modelId: res.modelId };
  } catch {
    /* fall through to heuristic */
  }
  return { summary: heuristicSummary(conv.messages, 10), method: "heuristic" };
}

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
    // Re-summarise every 20 messages so the summary stays current.
    if (updated && updated.messages.length >= 20 && updated.messages.length % 20 === 0) {
      void summarizeConversation(container, updated)
        .then((r) => container.conversationRepo.updateSummary(id, r.summary))
        .catch(() => undefined);
    }
    return updated ?? { error: "conversation not found" };
  });

  app.post("/conversations/:id/summarize", { schema: { tags: ["conversations"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const conv = container.conversationRepo.findById(id);
    if (!conv) return { error: "conversation not found" };
    if (conv.data.messages.length === 0) return { summary: "", method: "heuristic" };
    const result = await summarizeConversation(container, conv.data);
    container.conversationRepo.updateSummary(id, result.summary);
    return result;
  });

  app.delete("/conversations/:id", { schema: { tags: ["conversations"] } }, async (req) => {
    const { id } = req.params as { id: string };
    container.conversationRepo.deleteById(id);
    return { ok: true };
  });
}
