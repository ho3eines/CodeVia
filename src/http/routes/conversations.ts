import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../../app/container.js";
import { randomUUID } from "node:crypto";
import type { Conversation, ConversationMessage, Model, ModelProvider, Project } from "../../domain/entities.js";
import { accessibleProjectIds } from "../project-access.js";
import { canAccessProject, resolveRequestUser } from "../auth.js";
import { dispatchProjectAsk, isAskError } from "./project-ask-shared.js";
import { hydrateProject } from "../../domain/project-options.js";
import { buildRepoBrief } from "../../agents/context.js";
import { logger } from "../../logger.js";
import { streamModelChat } from "../../ai/model-stream.js";
import { toCandidate } from "../../ai/model-router.js";
import { ModelBenchmarkRepository } from "../../observability/model-bench-repo.js";
import type { ChatMessage } from "../../ai/types.js";

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

interface SendMessageBody {
  role?: "user" | "assistant";
  content?: string;
  generateResponse?: boolean;
  stream?: boolean;
  attachments?: Array<{ name: string; contentType: string; size: number; dataUrl?: string; preview?: string }>;
  modelId?: string;
  executionMode?: "chat" | "autonomous" | "agent" | "simulation";
  agentType?: string;
  temperature?: number;
}

interface ParsedAttachment {
  name: string;
  contentType: string;
  size: number;
  dataUrl?: string;
  preview?: string;
}

/** Normalise the client-supplied attachments (never throws on malformed input). */
function parseAttachments(raw: unknown): ParsedAttachment[] {
  // A non-array `attachments` (older clients / hand-crafted payloads) must not
  // take the whole request down with "…slice is not a function".
  const list: Array<Record<string, unknown>> = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  return list.slice(0, 8).map((a) => ({
    name: String(a.name || "file").slice(0, 200),
    contentType: String(a.contentType || "application/octet-stream").slice(0, 100),
    size: Number(a.size) || 0,
    dataUrl: typeof a.dataUrl === "string" && a.dataUrl.length < 1_000_000 ? a.dataUrl : undefined,
    preview: typeof a.preview === "string" ? a.preview.slice(0, 300) : undefined,
  }));
}

/** Race a promise against a timeout; resolves `undefined` when the timer wins. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Build the model prompt for a plain-chat reply. Shared by the JSON endpoint
 * and the SSE streaming endpoint so both answer identically.
 */
function buildChatMessages(opts: {
  safeProject: Project;
  updated: Conversation;
  content: string;
  attachments: ParsedAttachment[];
  repoBrief: string;
}): ChatMessage[] {
  const { safeProject, updated, content, attachments, repoBrief } = opts;
  const attachmentNote = attachments.length
    ? `\n\nThe user also attached ${attachments.length} file(s):\n` +
      attachments
        .map((a, i) => {
          const isImg = a.contentType.startsWith("image/");
          return `${i + 1}. ${a.name} (${a.contentType}, ${a.size} bytes)${isImg ? " [image attached below]" : a.preview ? ` — ${a.preview}` : ""}`;
        })
        .join("\n")
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
  return [
    { role: "system" as const, content: systemPrompt },
    ...(updated.summary ? [{ role: "system" as const, content: `Conversation summary so far:\n${updated.summary}` }] : []),
    ...transcriptMsgs.slice(-49),
    { role: "user" as const, content: lastUserContent },
  ];
}

/**
 * Order the active models exactly like AiTextService does (smart-router order
 * with benchmark telemetry), keeping only models whose provider is active.
 * Used by the streaming endpoint so it answers with the same model the JSON
 * endpoint would have picked — with automatic fallback to the next model when
 * the first one errors before producing any text.
 */
function resolveOrderedModels(
  container: Container,
  preferredModelId?: string,
): Array<{ model: Model; provider: ModelProvider }> {
  try {
    const available = container.modelRepo.listActive().map(toCandidate);
    if (!available.length) return [];
    const perfStats = container.benchRepo.computeStats();
    const liveIds = new Set(available.map((m) => m.id));
    ModelBenchmarkRepository.addSpeedNormalisation(perfStats.filter((s) => liveIds.has(s.modelId)));
    const candidates = container.modelRouter.route(
      available,
      { primary: "", fallbacks: [], specialized: {} },
      "fast",
      { userPreferredModelId: preferredModelId },
      perfStats,
    );
    const out: Array<{ model: Model; provider: ModelProvider }> = [];
    for (const c of candidates) {
      const model = container.modelRepo.findById(c.id)?.data;
      if (!model) continue;
      const provider = container.providerRepo.findById(model.providerId)?.data;
      if (!provider || !provider.active) continue;
      out.push({ model, provider });
    }
    return out;
  } catch (err) {
    logger.warn("conversation streaming model resolution failed", { err: String(err) });
    return [];
  }
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
  /** Fire-and-forget GitHub mirror — never blocks the HTTP response. */
  const persistAsync = (conv: Conversation | undefined): void => {
    void persist(conv);
  };
  /**
   * Background auto-summarise when a conversation grows long (AI Context
   * Compression). Runs after the reply was delivered so the extra model call
   * never delays the message the user is waiting for.
   */
  const maybeAutoSummarize = (convId: string): void => {
    const current = container.conversationRepo.findById(convId)?.data;
    const len = current?.messages?.length ?? 0;
    if (!current || len < 20 || len % 20 !== 0) return;
    void summarizeConversation(container, current)
      .then((r) => {
        container.conversationRepo.updateSummary(convId, r.summary);
        persistAsync(container.conversationRepo.findById(convId)?.data);
      })
      .catch((err) => logger.warn("conversation auto-summarize failed", { conversationId: convId, err: String(err) }));
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
    persistAsync(conv);
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
    const b = (req.body ?? {}) as SendMessageBody;
    const role = b.role ?? "user";
    const content = (b.content ?? "").trim();
    if (!content && !(Array.isArray(b.attachments) && b.attachments.length)) {
      reply.code(400);
      return { error: "Message content or an attachment is required" };
    }
    const attachments = parseAttachments(b.attachments);
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
      // Give the assistant real repository evidence (file tree, README, manifest
      // excerpts) so questions like "review this project" or "read the README"
      // are answered from the repo instead of invented from the project name.
      // Advisory only: a missing/private repo must never break the send — and a
      // slow GitHub must never stall it either (8s budget, then chat without it).
      const repoBrief = safeProject.configRepo
        ? ((await withTimeout(
            buildRepoBrief({
              github: container.githubForProject(safeProject, resolveRequestUser(req, container).user.id),
              project: safeProject,
            }).catch(() => ""),
            8000,
          )) ?? "")
        : "";
      const messages = buildChatMessages({ safeProject, updated, content, attachments, repoBrief });

      try {
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

    const latest = container.conversationRepo.findById(id)?.data ?? updated;
    // GitHub mirror + auto-summary run in the background: the reply is already
    // in the database, so the response goes out immediately instead of waiting
    // on network calls.
    persistAsync(latest);
    maybeAutoSummarize(id);
    return latest ?? { error: "conversation not found" };
  });

  /**
   * Streaming chat with a conversation — Server-Sent Events, ChatGPT-style.
   * The user message is persisted first, then the assistant reply streams in
   * token-by-token so the UI never sits on a blank send and never needs a
   * manual reload to see what happened.
   *
   * Frames: `user` (echo of the persisted user message) → `meta` (answering
   * model) → `delta`* → `done` (full conversation) | `error`.
   * Non-chat execution modes dispatch a task and finish with a single
   * `message` + `done` instead of deltas.
   */
  app.post("/conversations/:id/messages/stream", { schema: { tags: ["conversations"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as SendMessageBody;
    const role = b.role ?? "user";
    const content = (b.content ?? "").trim();
    if (!content && !(Array.isArray(b.attachments) && b.attachments.length)) {
      reply.code(400);
      return { error: "Message content or an attachment is required" };
    }
    const existing = loadAllowedConv(req, id);
    if (!existing) {
      reply.code(404);
      return { error: "conversation not found" };
    }
    const project = container.projectRepo.findById(existing.projectId)?.data;
    const safeProject = project ? hydrateProject(project) : undefined;
    if (!safeProject || !canAccessProject(resolveRequestUser(req, container).user, safeProject)) {
      reply.code(404);
      return { error: "project not found" };
    }
    const attachments = parseAttachments(b.attachments);
    if (b.modelId) container.conversationRepo.updateModel?.(id, b.modelId);
    const msg: ConversationMessage = {
      id: randomUUID(),
      role,
      content: content || "(attachment)",
      createdAt: new Date().toISOString(),
      metadata: attachments.length ? { attachments } : undefined,
    };
    const afterUser = container.conversationRepo.addMessage(id, msg);
    if (!afterUser) {
      reply.code(404);
      return { error: "conversation not found" };
    }

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // The client may navigate away mid-stream; writes after that must be silent
    // no-ops, never uncaught exceptions that crash the request handler.
    const send = (event: unknown): void => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client gone */
      }
    };
    const ctrl = new AbortController();
    reply.raw.on("close", () => ctrl.abort());
    const end = (): void => {
      try {
        reply.raw.end();
      } catch {
        /* already closed */
      }
    };
    /** Latest conversation + background side-effects (GitHub mirror, summary). */
    const finish = (fallback: Conversation): Conversation => {
      const latest = container.conversationRepo.findById(id)?.data ?? fallback;
      persistAsync(latest);
      maybeAutoSummarize(id);
      return latest;
    };

    try {
      // Echo the persisted user message immediately so the UI can render it
      // without waiting for the model.
      send({ type: "user", message: msg, conversation: afterUser });

      const mode = b.executionMode ?? "chat";
      if (role === "user" && mode !== "chat") {
        const result = dispatchProjectAsk(container, safeProject.id, {
          title: content.slice(0, 80),
          description: content,
          executionMode: mode === "autonomous" || mode === "agent" || mode === "simulation" ? mode : "autonomous",
          agentType: b.agentType,
          correlationId: `conv-chat-${id}-${Date.now()}`,
        });
        let statusMsg: ConversationMessage;
        if (isAskError(result)) {
          statusMsg = {
            id: randomUUID(),
            role: "assistant",
            content: `❌ ${result.error}`,
            createdAt: new Date().toISOString(),
            metadata: { executionMode: mode, error: true },
          };
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
          statusMsg = {
            id: randomUUID(),
            role: "assistant",
            content: body,
            createdAt: new Date().toISOString(),
            metadata: {
              modelId: b.modelId ?? afterUser.modelId,
              executionMode: mode,
              dispatchedTaskId: taskId,
              simulationPlan: result.simulation ? result.plan : undefined,
            },
          };
        }
        const updated = container.conversationRepo.addMessage(id, statusMsg) ?? afterUser;
        send({ type: "message", message: statusMsg, conversation: updated });
        send({ type: "done", conversation: finish(updated), message: statusMsg });
        end();
        return reply;
      }

      if (!(role === "user" && b.generateResponse !== false)) {
        send({ type: "done", conversation: finish(afterUser) });
        end();
        return reply;
      }

      const current = container.conversationRepo.findById(id)?.data ?? afterUser;
      const repoBrief = safeProject.configRepo
        ? ((await withTimeout(
            buildRepoBrief({
              github: container.githubForProject(safeProject, resolveRequestUser(req, container).user.id),
              project: safeProject,
            }).catch(() => ""),
            8000,
          )) ?? "")
        : "";
      const messages = buildChatMessages({ safeProject, updated: current, content, attachments, repoBrief });
      const ordered = resolveOrderedModels(container, b.modelId ?? current.modelId ?? safeProject.defaultModelId);
      if (!ordered.length) {
        const errMsg: ConversationMessage = {
          id: randomUUID(),
          role: "assistant",
          content: "⚠️ No active model is available. Activate a provider and a model first (Settings → Providers / Models).",
          createdAt: new Date().toISOString(),
          metadata: { error: true },
        };
        const updated = container.conversationRepo.addMessage(id, errMsg) ?? afterUser;
        send({ type: "error", message: errMsg.content, conversation: finish(updated) });
        end();
        return reply;
      }

      const started = Date.now();
      let full = "";
      let usedModel: Model | undefined;
      let usedProvider: ModelProvider | undefined;
      let lastError = "";
      for (const { model, provider } of ordered) {
        if (ctrl.signal.aborted) break;
        // A model that errored before producing any text falls through to the
        // next candidate; once deltas went out we stay with that model.
        if (full) break;
        if (usedModel) {
          send({ type: "retry", modelId: model.id, message: `Trying fallback ${model.displayName}…` });
        } else {
          send({ type: "meta", modelId: model.id, providerId: provider.id, displayName: model.displayName });
        }
        let attemptError = "";
        try {
          for await (const ev of streamModelChat(provider, model.modelId, {
            messages,
            temperature: model.temperature ?? (typeof b.temperature === "number" ? b.temperature : 0.3),
            maxTokens: model.maxTokens ?? 2000,
            omitTemperature: model.omitTemperature === true,
            signal: ctrl.signal,
          })) {
            if (ev.type === "delta" && ev.text) {
              full += ev.text;
              usedModel = model;
              usedProvider = provider;
              send({ type: "delta", text: ev.text });
            } else if (ev.type === "done") {
              // Providers that ignore `stream: true` answer in one `done`.
              if (ev.text && !full) {
                full = ev.text;
                usedModel = model;
                usedProvider = provider;
                send({ type: "delta", text: ev.text });
              }
            } else if (ev.type === "error") {
              attemptError = ev.message + (ev.hint ? ` (${ev.hint})` : "");
            }
          }
        } catch (err) {
          attemptError = err instanceof Error ? err.message : String(err);
        }
        if (!full.trim() && attemptError) lastError = attemptError;
      }

      if (full.trim()) {
        const assistantMsg: ConversationMessage = {
          id: randomUUID(),
          role: "assistant",
          content: full.trim(),
          createdAt: new Date().toISOString(),
          metadata: { modelId: usedModel?.id, executionMode: "chat" },
        };
        const updated = container.conversationRepo.addMessage(id, assistantMsg) ?? afterUser;
        // Best-effort cost attribution (token counts estimated from length).
        try {
          const m = usedModel ?? ordered[0]?.model;
          if (m) {
            const inChars = messages.reduce((s, x) => s + x.content.length, 0);
            const inputTokens = Math.max(1, Math.round(inChars / 4));
            const outputTokens = Math.max(1, Math.round(full.length / 4));
            container.costRepo.create({
              providerId: usedProvider?.id ?? ordered[0]?.provider.id,
              modelId: m.id,
              projectId: safeProject.id,
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              estimatedCostUsd: (inputTokens / 1000) * (m.inputCostPer1k ?? 0) + (outputTokens / 1000) * (m.outputCostPer1k ?? 0),
              durationMs: Date.now() - started,
            });
          }
        } catch {
          /* accounting must never break the stream */
        }
        send({ type: "done", conversation: finish(updated), message: assistantMsg, modelId: usedModel?.id });
      } else {
        const errMsg: ConversationMessage = {
          id: randomUUID(),
          role: "assistant",
          content: `⚠️ Model error: ${lastError || "the model returned an empty response"}`,
          createdAt: new Date().toISOString(),
          metadata: { error: true },
        };
        const updated = container.conversationRepo.addMessage(id, errMsg) ?? afterUser;
        send({ type: "error", message: errMsg.content, conversation: finish(updated) });
      }
      end();
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      end();
    }
    return reply;
  });

  app.post("/conversations/:id/summarize", { schema: { tags: ["conversations"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const conv = container.conversationRepo.findById(id);
    if (!conv) return { error: "conversation not found" };
    if ((conv.data.messages ?? []).length === 0) return { summary: "", method: "heuristic" };
    const result = await summarizeConversation(container, conv.data);
    container.conversationRepo.updateSummary(id, result.summary);
    persistAsync(container.conversationRepo.findById(id)?.data);
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
