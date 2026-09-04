import type { FastifyInstance, FastifyReply } from "fastify";
import type { Container } from "../../app/container.js";
import { TelegramBot } from "../../integrations/telegram-bot.js";
import {
  accountTelegramService,
  accountTelegramToken,
  encryptTelegramToken,
  getTelegramWebhookUrl,
  maskTelegramToken,
  setTelegramWebhook,
  testTelegramToken,
} from "../../integrations/telegram.js";
import type { TelegramAccount } from "../../domain/telegram.js";
import { resolveRequestUser } from "../auth.js";
import { logger } from "../../logger.js";

function fail(reply: FastifyReply, status: number, message: string, extra: Record<string, unknown> = {}): { error: string } {
  reply.code(status);
  return { error: message, ...extra };
}

export function registerTelegramRoutes(app: FastifyInstance, container: Container): void {
  // Reuse the container's singleton Telegram service (same token connection the
  // rest of the platform and the worker use), rather than creating a fresh one.
  const telegram = container.telegram;
  const botDeps = {
    projectRepo: container.projectRepo,
    taskRepo: container.taskRepo,
    workflowRepo: container.workflowRepo,
    conversationRepo: container.conversationRepo,
    agentRepo: container.agentRepo,
    runRepo: container.runRepo,
    agentManager: container.agentManager,
    github: container.github,
    modelRepo: container.modelRepo,
    skillRepo: container.skillRepo,
    memoryRepo: container.memoryRepo,
    queue: container.queue,
    logger: logger.child({ component: "telegram-bot" }),
  };
  const bot = new TelegramBot({ telegram, ...botDeps });
  const botFor = (svc = telegram) => new TelegramBot({ telegram: svc, ...botDeps });

  const serialize = (a: TelegramAccount) => ({
    id: a.id,
    userId: a.userId,
    name: a.name,
    accountId: a.accountId,
    chatId: a.chatId,
    botId: a.botId,
    botUsername: a.botUsername,
    connected: a.connected,
    webhookSet: !!a.webhookSet,
    lastError: a.lastError,
    tokenMasked: maskTelegramToken(accountTelegramToken(a)),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  });

  async function connectAccount(account: TelegramAccount): Promise<TelegramAccount> {
    const token = accountTelegramToken(account);
    if (!token) {
      return { ...account, connected: false, lastError: "Token cannot be decrypted" };
    }
    const me = await testTelegramToken(token);
    if (!me.ok) {
      return { ...account, connected: false, lastError: me.error, botId: account.botId, botUsername: account.botUsername, updatedAt: new Date().toISOString() };
    }
    // The bot token is real (getMe passed). A webhook is required for the bot to
    // receive updates, but Telegram demands a public HTTPS URL. If the platform
    // only has a localhost URL (local dev), still mark the bot as connected so
    // `status` is accurate, but surface a clear, actionable message.
    const webhookUrl = getTelegramWebhookUrl();
    const webhookResult = await setTelegramWebhook(token, webhookUrl);
    const updated: TelegramAccount = {
      ...account,
      botId: me.botId ?? account.botId,
      botUsername: me.username ?? account.botUsername,
      connected: true,
      webhookSet: webhookResult.ok,
      lastError: webhookResult.ok ? undefined : `Bot is live, but it can't receive messages yet: ${webhookResult.error}`,
      updatedAt: new Date().toISOString(),
    };
    container.telegramAccountRepo.upsert(updated);
    return updated;
  }

  const currentUserId = (req: Parameters<typeof resolveRequestUser>[0]) => {
    const { user } = resolveRequestUser(req, container);
    return user.id;
  };

  app.get("/integrations/telegram/status", { schema: { tags: ["telegram"] } }, async (req) => {
    const userId = currentUserId(req);
    const accounts = container.telegramAccountRepo.byUser(userId).map(serialize);
    const globalConnected = await telegram.health();
    return {
      connected: globalConnected || accounts.some((a) => a.connected),
      globalConnected,
      kind: telegram.constructor.name,
      webhookUrl: getTelegramWebhookUrl(),
      accounts,
    };
  });

  // Per-user bot accounts: list / create / update / connect / remove.
  app.get("/integrations/telegram/accounts", { schema: { tags: ["telegram"] } }, async (req) => {
    const userId = currentUserId(req);
    return container.telegramAccountRepo.byUser(userId).map(serialize);
  });

  app.post("/integrations/telegram/accounts", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = String(b.token ?? "").trim();
    if (!token) return fail(reply, 400, "Telegram bot token is required");
    const userId = currentUserId(req);
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined;
    const accountId = typeof b.accountId === "string" && b.accountId.trim() ? b.accountId.trim() : undefined;
    const chatId = typeof b.chatId === "string" && b.chatId.trim() ? b.chatId.trim() : accountId;
    // Real connection test: token must be accepted by the Telegram Bot API.
    const me = await testTelegramToken(token);
    if (!me.ok) return fail(reply, 422, me.error ?? "Telegram token rejected");
    const account = container.telegramAccountRepo.create({
      userId,
      name,
      tokenEnc: encryptTelegramToken(token),
      accountId,
      chatId,
      botId: me.botId,
      botUsername: me.username,
      connected: true,
      webhookSet: false,
      lastError: undefined,
    });
    const connected = await connectAccount(account);
    reply.code(201);
    return { account: serialize(connected), webhookUrl: getTelegramWebhookUrl() };
  });

  app.patch("/integrations/telegram/accounts/:id", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = currentUserId(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const account = container.telegramAccountRepo.findByIdAndUser(id, userId);
    if (!account) return fail(reply, 404, "Telegram account not found");
    const next: TelegramAccount = {
      ...account,
      name: typeof b.name === "string" ? b.name.trim() || undefined : account.name,
      accountId: typeof b.accountId === "string" ? b.accountId.trim() || undefined : account.accountId,
      chatId: typeof b.chatId === "string" ? b.chatId.trim() || undefined : (typeof b.accountId === "string" ? (b.accountId.trim() || undefined) : account.chatId),
      updatedAt: new Date().toISOString(),
    };
    if (typeof b.token === "string" && b.token.trim()) {
      next.tokenEnc = encryptTelegramToken(b.token.trim());
      const connected = await connectAccount(next);
      container.telegramAccountRepo.upsert(connected);
      return serialize(connected);
    }
    container.telegramAccountRepo.upsert(next);
    return serialize(next);
  });

  app.post("/integrations/telegram/accounts/:id/connect", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = currentUserId(req);
    const account = container.telegramAccountRepo.findByIdAndUser(id, userId);
    if (!account) return fail(reply, 404, "Telegram account not found");
    const connected = await connectAccount(account);
    return serialize(connected);
  });

  app.delete("/integrations/telegram/accounts/:id", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = currentUserId(req);
    const account = container.telegramAccountRepo.findByIdAndUser(id, userId);
    if (!account) return fail(reply, 404, "Telegram account not found");
    container.telegramAccountRepo.deleteById(id);
    return { ok: true };
  });

  // Global + per-account webhook. A user bot's webhook points at the same
  // public URL; the router picks the right account by :accountId or the
  // incoming chat/user id.
  const handleWebhook = async (body: unknown, accountId?: string) => {
    let account: TelegramAccount | undefined;
    if (accountId) {
      account = container.telegramAccountRepo.findMany().map((r) => r.data).find((a) => a.id === accountId);
    }
    // If no account was named, route by the sender's telegram id / chat id.
    if (!account) {
      const update = body as { message?: { chat?: { id?: number }; from?: { id?: number } }; callback_query?: { from?: { id?: number } } };
      const telegramId = update.message?.chat?.id ?? update.message?.from?.id ?? update.callback_query?.from?.id;
      account = container.telegramAccountRepo.byTelegramId(telegramId != null ? String(telegramId) : undefined)[0];
    }
    const activeBot = account ? botFor(accountTelegramService(account)) : bot;
    const update = await activeBot.handle(body);
    return { ok: true, account: account ? account.id : undefined, update };
  };

  app.post("/integrations/telegram/webhook/:accountId", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    try {
      reply.code(200);
      return await handleWebhook(req.body, accountId);
    } catch (err) {
      logger.error("telegram webhook error", { err: String(err) });
      reply.code(200);
      return { ok: false, error: String(err) };
    }
  });

  app.post("/integrations/telegram/webhook", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    try {
      reply.code(200);
      return await handleWebhook(req.body);
    } catch (err) {
      logger.error("telegram webhook error", { err: String(err) });
      reply.code(200);
      return { ok: false, error: String(err) };
    }
  });

  // Manually drive a telegram-style message (for the web UI "Telegram" preview).
  app.post("/integrations/telegram/command", { schema: { tags: ["telegram"] } }, async (req) => {
    const b = req.body as { chatId?: string; text?: string };
    const update = await botFor().handle({ update_id: Date.now(), message: { chat: { id: b.chatId ?? "web" }, from: { id: "web" }, text: b.text } });
    return { ok: true, update };
  });

  app.post("/integrations/telegram/send", { schema: { tags: ["telegram"] } }, async (req) => {
    const b = req.body as { chatId?: string; text?: string };
    const ok = await telegram.sendMessage({ chatId: b.chatId ?? "web", text: b.text ?? "" });
    return { ok };
  });
}
