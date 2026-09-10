import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../../app/container.js";
import { randomUUID } from "node:crypto";
import type { Conversation, ConversationMessage } from "../../domain/entities.js";
import { accessibleProjectIds } from "../project-access.js";
import { canAccessProject, resolveRequestUser } from "../auth.js";
import { dispatchProjectAsk, isAskError } from "./project-ask-shared.js";
import { hydrateProject } from "../../domain/project-options.js";
import { buildRepoBrief } from "../../agents/context.js";
import { logger } from "../../logger.js";

const SUMMARY_SYSTEM_PROMPT =
  "You compress a chat between a user and an AI engineering assistant into a concise memory summary. " +
  "Keep: goals, decisions, constraints, open questions, file/branch/PR names, and unresolved bugs. " +
  "Drop pleasantries. Output 5-10 bullet points, no preamble, same language as the conversation.";

function heuristicSummary(messages: ConversationMessage[] | undefined, take: number): string {
  return (messages ?? [])
    .slice(-take)
    .map((m) => `${m.role}: ${m.content.replace(/\s+/g, " ").slice(0, 150)}`)
    .join("\n");
}

/** AI-powered context compression with a deterministic fallback when no model is configured. */
async function summarizeConversation(
  container: Container,
  conv: { id: string; projectId: string; modelId?: string; summary?: string; messages?: ConversationMessage[] },
): Promise<{ summary: string; method: "ai" | "heuristic"; modelId?: string }> {
  const messages = conv.messages ?? [];
  const transcript = messages
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
  const persist = async (conv: Conversation | undefined) => {
    if (!conv) return;
    const p = container.projectRepo.findById(conv.projectId)?.data;
    if (!p) return;
    // Mirror into CodeVia/conversations is best-effort: the AI reply is already
    // in the database. A GitHub 401/404 from the wrong token (GITHUB_TOKEN vs
    // the owner's OAuth token) must not 500 the send and hide the in-page reply.
    try {
      await container.projectFiles.syncConversation(hydrateProject(p), conv);
    } catch (err) {
      logger.warn("conversation GitHub sync failed", { conversationId: conv.id, projectId: conv.projectId, err: String(err) });
    }
  };
  const userFor = (req: unknown): string => {
    const u = resolveRequestUser(req as FastifyRequest, container);
    return u.user.id;
  };
  const loadAllowedConv = (req: unknown, id: string): Conversation | undefined => {
    const r = req as FastifyRequest;
    const conv = container.conversationRepo.findById(id)?.data;
    if (!conv) return undefined;
    const project = container.projectRepo.findById(conv.projectId)?.data;
    if (!project) return undefined;
    if (!canAccessProject(resolveRequestUser(r, container).user, project)) return undefined;
    return conv;
  };
  app.get("/conversations", { schema: { tags: ["conversations"] } }, async (req) => {
    const q = req.query as { projectId?: string };
    const uid = userFor(req);
    const owned = accessibleProjectIds(req, container);
    let convs = container.conversationRepo
      .findMany()
      .filter((r) => owned.has(r.data.projectId))
      // User isolation: a user only sees conversations they created (or web
      // conversations in demo / pre-multi-user installs).
      .filter((r) => !r.data.userId || r.data.userId === uid || r.data.userId === "user-demo" || uid === "user-demo");
    if (q.projectId) convs = convs.filter((r) => r.data.projectId === q.projectId && owned.has(q.projectId!));
    return convs.map((r) => r.data);
  });

  app.post("/conversations", { schema: { tags: ["conversations"] } }, async (req) => {
    const b = req.body as Record<string, unknown>;
    const pid = String(b.projectId);
    const project = container.projectRepo.findById(pid)?.data;
    if (!project || !canAccessProject(resolveRequestUser(req, container).user, project)) {
      throw Object.assign(new Error("project not found"), { statusCode: 404 });
    }
    const conv = container.conversationRepo.create({
      projectId: pid,
      userId: String(b.userId ?? userFor(req)),
      source: (b.source as "web" | "telegram") ?? "web",
      title: String(b.title ?? "Conversation"),
      messages: [],
      modelId: b.modelId as string | undefined,
      activeAgentId: b.activeAgentId as string | undefined,
    });
    await persist(conv);
    return conv;
  });

  app.get("/conversations/:id", { schema: { tags: ["conversations"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conv = loadAllowedConv(req, id);
    if (!conv) { reply.code(404); return { error: "conversation not found" }; }
    return conv;
  });

  app.post("/conversations/:id/messages", { schema: { tags: ["conversations"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as {
      role?: "user" | "assistant";
      content?: string;
      generateResponse?: boolean;
      stream?: boolean;
      attachments?: Array<{ name: string; contentType: string; size: number; dataUrl?: string; preview?: string }>;
      modelId?: string;
      executionMode?: "chat" | "autonomous" | "agent" | "simulation";
      agentType?: string;
      temperature?: number;
    };
    const role = b.role ?? "user";
    const content = (b.content ?? "").trim();
    if (!content && !(Array.isArray(b.attachments) && b.attachments.length)) {
      reply.code(400);
      return { error: "Message content or an attachment is required" };
    }
    // A non-array `attachments` (older clients / hand-crafted payloads) must not
    // take the whole request down with "…slice is not a function".
    const rawAttachments: Array<Record<string, unknown>> = Array.isArray(b.attachments) ? (b.attachments as Array<Record<string, unknown>>) : [];
    const attachments = rawAttachments.slice(0, 8).map((a) => ({
      name: String(a.name || "file").slice(0, 200),
      contentType: String(a.contentType || "application/octet-stream").slice(0, 100),
      size: Number(a.size) || 0,
      dataUrl: typeof a.dataUrl === "string" && a.dataUrl.length < 1_000_000 ? a.dataUrl : undefined,
      preview: typeof a.preview === "string" ? a.preview.slice(0, 300) : undefined,
    }));
    // Ownership gate: the caller must have access to the conversation's project
    // AND (for user-scoped convos) be the owner, otherwise return 404.
    const existing = loadAllowedConv(req, id);
    if (!existing) {
      reply.code(404);
      return { error: "conversation not found" };
    }
    const msg: ConversationMessage = {
      id: randomUUID(),
      role,
      content: content || "(attachment)",
      createdAt: new Date().toISOString(),
      metadata: attachments.length ? { attachments } : undefined,
    };
    // Persist the user-chosen model for the rest of the conversation.
    if (b.modelId) container.conversationRepo.updateModel?.(id, b.modelId);
    let updated = container.conversationRepo.addMessage(id, msg);
    if (!updated) {
      reply.code(404);
      return { error: "conversation not found" };
    }

    // Remember chosen model if just set
    updated = container.conversationRepo.findById(id)?.data ?? updated;
    // hydrateProject() normalises the record the same way GET /projects does:
    // projects created before multi-repository support have `configRepo`/
    // `branch` but no `repositories` array, and the chat prompt below reads it
    // directly (that crashed every send with "Cannot read properties of
    // undefined (reading 'map')" while the rest of the UI — which hydrates —
    // kept working).
    const project = container.projectRepo.findById(updated.projectId)?.data;
    const safeProject = project ? hydrateProject(project) : undefined;
    if (!safeProject || !canAccessProject(resolveRequestUser(req, container).user, safeProject)) {
      reply.code(404);
      return { error: "project not found" };
    }

    // If the user asked for an execution mode other than plain chat, dispatch
    // a task and return a status message instead of a normal chat reply.
    const mode = b.executionMode ?? "chat";
    if (role === "user" && safeProject && mode !== "chat") {
      const result = dispatchProjectAsk(container, safeProject.id, {
        title: content.slice(0, 80),
        description: content,
        executionMode: mode === "autonomous" || mode === "agent" || mode === "simulation" ? mode : "autonomous",
        agentType: b.agentType,
        correlationId: `conv-chat-${id}-${Date.now()}`,
      });
      if (isAskError(result)) {
        const errMsg: ConversationMessage = {
          id: randomUUID(),
          role: "assistant",
          content: `❌ ${result.error}`,
          createdAt: new Date().toISOString(),
          metadata: { executionMode: mode, error: true },
        };
        updated = container.conversationRepo.addMessage(id, errMsg);
      } else {
        const taskId = (result.task as { id?: string } | undefined)?.id;
        let body: string;
        if (result.simulation) {
          const steps = (result.plan || []).map((s, i) => `${i + 1}. ${s.label}${s.requiresApproval ? " 🛑" : ""}`).join("\n");
          body = `🧪 Simulation plan ready · routed to **${result.routedAgentType || "auto"}**\n\n${steps}`;
        } else if (mode === "autonomous") {
          body = `🚀 Autonomous task **${taskId?.slice(0, 8) || "?"}** queued.\nResearch → implementation → QA will run automatically; updates appear below as the task progresses.`;
        } else {
          body = `▶ Task **${taskId?.slice(0, 8) || "?"}** dispatched to **${result.routedAgentType || b.agentType || "agent"}**.`;
        }
        if (taskId) body += `\n\n[Open runs →](#/projects/${safeProject.id}/runs)`;
        const statusMsg: ConversationMessage = {
          id: randomUUID(),
          role: "assistant",
          content: body,
          createdAt: new Date().toISOString(),
          metadata: { modelId: b.modelId ?? updated.modelId, executionMode: mode, dispatchedTaskId: taskId, simulationPlan: result.simulation ? result.plan : undefined },
        };
        updated = container.conversationRepo.addMessage(id, statusMsg);
      }
    } else if (role === "user" && b.generateResponse !== false && safeProject) {
      // Plain chat: build context including attachments for vision-capable models.
      const attachmentNote = attachments.length
        ? `\n\nThe user also attached ${attachments.length} file(s):\n` +
          attachments
            .map((a, i) => {
              const isImg = a.contentType.startsWith("image/");
              return `${i + 1}. ${a.name} (${a.contentType}, ${a.size} bytes)${isImg ? " [image attached below]" : a.preview ? ` — ${a.preview}` : ""}`;
            })
            .join("\n")
        : "";
      // Give the assistant real repository evidence (file tree, README, manifest
      // excerpts) so questions like "review this project" or "read the README"
      // are answered from the repo instead of invented from the project name.
      // Advisory only: a missing/private repo must never break the send.
      const repoBrief = safeProject.configRepo
        ? await buildRepoBrief({
            github: container.githubForProject(safeProject, resolveRequestUser(req, container).user.id),
            project: safeProject,
          }).catch(() => "")
        : "";
      const systemPrompt = `You are CodeVia's project assistant AI for the project "${safeProject.name}".
Project description: ${safeProject.description || "No description provided"}
Repositories: ${(safeProject.repositories ?? []).map((r) => r.repo).join(", ")}
Language: Respond in the same language the user uses in their message.
Be helpful, concise, and accurate. When relevant, reference project context, skills, and agents available.${attachmentNote ? "\n\nFile attachments the user included are listed in the final user message." : ""}${repoBrief ? `\n\nRepository context (read this before answering questions about the codebase; never claim a file is missing without checking this list):\n${repoBrief}` : ""}`;

      // Build multimodal-ish user message: put images inline as data URLs for
      // vision-capable models when possible; otherwise just list them in text.
      const lastUserContent =
        content +
        (attachments.length
          ? "\n\n[Attachments]\n" +
            attachments
              .map((a) => {
                if (a.contentType.startsWith("image/") && a.dataUrl) {
                  return `${a.name} (image): ${a.preview || "see inline image"}`;
                }
                return `${a.name} (${a.contentType}, ${a.size} bytes)${a.preview ? " — " + a.preview : ""}`;
              })
              .join("\n")
          : "");
      const transcriptMsgs = (updated.messages ?? []).slice(0, -1).map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));
      const messages = [
        { role: "system" as const, content: systemPrompt },
        ...(updated.summary ? [{ role: "system" as const, content: `Conversation summary so far:\n${updated.summary}` }] : []),
        ...transcriptMsgs.slice(-49),
        { role: "user" as const, content: lastUserContent },
      ];

      try {
        if (!b.stream) {
          const res = await container.aiText.complete({
            category: "fast",
            preferredModelId: b.modelId ?? updated.modelId ?? safeProject.defaultModelId,
            projectId: updated.projectId,
            correlationId: `conv-chat-${id}-${Date.now()}`,
            maxTokens: 2000,
            temperature: typeof b.temperature === "number" ? b.temperature : undefined,
            messages,
          });
          if (res && res.content.trim()) {
            const assistantMsg: ConversationMessage = {
              id: randomUUID(),
              role: "assistant",
              content: res.content.trim(),
              createdAt: new Date().toISOString(),
              metadata: { modelId: res.modelId, executionMode: "chat" },
            };
            updated = container.conversationRepo.addMessage(id, assistantMsg);
          }
        }
      } catch (err) {
        console.error("Failed to generate AI response for conversation", id, err);
        const errMsg: ConversationMessage = {
          id: randomUUID(),
          role: "assistant",
          content: `⚠️ Model error: ${(err as Error)?.message || String(err)}`,
          createdAt: new Date().toISOString(),
          metadata: { error: true },
        };
        updated = container.conversationRepo.addMessage(id, errMsg);
      }
    }

    // Auto-summarize when a conversation grows long (AI Context Compression).
    if (updated && (updated.messages ?? []).length >= 20 && (updated.messages ?? []).length % 20 === 0) {
      const r = await summarizeConversation(container, updated);
      container.conversationRepo.updateSummary(id, r.summary);
    }
    await persist(container.conversationRepo.findById(id)?.data);
    return container.conversationRepo.findById(id)?.data ?? { error: "conversation not found" };
  });

  app.post("/conversations/:id/summarize", { schema: { tags: ["conversations"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const conv = container.conversationRepo.findById(id);
    if (!conv) return { error: "conversation not found" };
    if ((conv.data.messages ?? []).length === 0) return { summary: "", method: "heuristic" };
    const result = await summarizeConversation(container, conv.data);
    container.conversationRepo.updateSummary(id, result.summary);
    await persist(container.conversationRepo.findById(id)?.data);
    return result;
  });

  app.delete("/conversations/:id", { schema: { tags: ["conversations"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const conv = container.conversationRepo.findById(id)?.data;
    const p = conv && container.projectRepo.findById(conv.projectId)?.data;
    if (p) await container.projectFiles.tombstone(p, container.projectFiles.pathFor(p, "conversation", id));
    container.conversationRepo.deleteById(id);
    return { ok: true };
  });
}
