import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Container } from "../../app/container.js";
import {
  accountTelegramService,
  accountTelegramToken,
  encryptTelegramToken,
  getPublicBaseUrl,
  getTelegramWebhookPath,
  isTelegramConnection,
  learnPublicBaseUrl,
  maskTelegramToken,
  testTelegramToken,
  verifyTelegramWebhookSecret,
} from "../../integrations/telegram.js";
import type { TelegramAccount } from "../../domain/telegram.js";
import type { TelegramMode } from "../../integrations/telegram-runtime.js";
import { resolveRequestUser } from "../auth.js";
import { getEnv } from "../../config/env.js";
import { logger } from "../../logger.js";

function fail(reply: FastifyReply, status: number, message: string, extra: Record<string, unknown> = {}): { error: string } {
  reply.code(status);
  return { error: message, ...extra };
}

const MODES: TelegramMode[] = ["auto", "webhook", "polling", "off"];

export function registerTelegramRoutes(app: FastifyInstance, container: Container): void {
  // Reuse the container's singleton Telegram service (same token connection the
  // rest of the platform and the worker use), rather than creating a fresh one.
  const telegram = container.telegram;
  const runtime = container.telegramRuntime;
  const bot = container.telegramBotFor(telegram);
  const botFor = (svc = telegram) => container.telegramBotFor(svc);

  /** Resolve the public HTTPS base URL this deployment is reachable at, using the
   *  real forwarded host/proto so the webhook points at a URL Telegram can reach
   *  (works out of the box behind a proxy / the Arena preview host). */
  const publicBaseFrom = (req: FastifyRequest) => {
    const h = req.headers as Record<string, unknown>;
    const proto = String(h["x-forwarded-proto"] ?? req.protocol ?? "https");
    const host = String(h["x-forwarded-host"] ?? h.host ?? "");
    const base = getPublicBaseUrl(host, proto);
    learnPublicBaseUrl(base);
    return base;
  };

  const webhookUrlFor = (base: string) => `${base.replace(/\/$/, "")}${getTelegramWebhookPath()}`;

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
    transport: a.transport ?? (a.webhookSet ? "webhook" : "off"),
    pollingActive: !!a.pollingActive,
    lastCheckedAt: a.lastCheckedAt,
    lastError: a.lastError,
    tokenMasked: maskTelegramToken(accountTelegramToken(a)),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  });

  /**
   * Verify a user's bot token and choose how it receives updates:
   * webhook when this deployment is publicly reachable, otherwise **long
   * polling** with the account's own token. The polling fallback is what makes a
   * bot work for people who have no HTTPS host to point Telegram at (local dev,
   * a preview URL, a NAT'ed VPS) — previously such an account was "connected"
   * in the UI yet could never hear a message.
   */
  function sameTokenAsPlatformBot(token: string): boolean {
  const global = getEnv().TELEGRAM_BOT_TOKEN;
  return Boolean(global) && global === token;
}

async function connectAccount(account: TelegramAccount, publicBase?: string): Promise<TelegramAccount> {
    const token = accountTelegramToken(account);
    const now = () => new Date().toISOString();
    if (!token) {
      return { ...account, connected: false, lastError: "Token cannot be decrypted", updatedAt: now() };
    }
    const me = await testTelegramToken(token);
    if (!me.ok) {
      return {
        ...account,
        connected: false,
        lastError: me.error,
        lastCheckedAt: now(),
        botId: account.botId,
        botUsername: account.botUsername,
        updatedAt: now(),
      };
    }
    const base = publicBase ?? getPublicBaseUrl();
    const webhookUrl = webhookUrlFor(base);
    const service = accountTelegramService(account);
    const webhookResult = isTelegramConnection(service)
      ? await service.setWebhook(webhookUrl, { secretToken: getEnv().TELEGRAM_WEBHOOK_SECRET })
      : { ok: false as const, error: "mock telegram service" };

    let transport: TelegramAccount["transport"] = webhookResult.ok ? "webhook" : "polling";
    let pollingActive = false;
    let lastError: string | undefined;

    if (webhookResult.ok) {
      await runtime.stopAccountPolling(account.id);
    } else {
      // No webhook → keep polling as the receive path. If polling cannot start
      // either, that is the error the user needs to see.
      const status = await runtime.startAccountPolling(account);
      pollingActive = !!status?.running;
      transport = pollingActive ? "polling" : "off";
      lastError = pollingActive
        ? `Bot is live. Webhook was not usable (${webhookResult.error ?? "no public HTTPS URL"}) — receiving messages via long polling instead.`
        : `Bot token is valid, but no update transport could be started: ${webhookResult.error ?? "unknown"}`;
    }

    const updated: TelegramAccount = {
      ...account,
      botId: me.botId ?? account.botId,
      botUsername: me.username ?? account.botUsername,
      connected: true,
      webhookSet: webhookResult.ok,
      transport,
      pollingActive,
      lastCheckedAt: now(),
      lastError,
      updatedAt: now(),
    };
    container.telegramAccountRepo.upsert(updated);
    return updated;
  }

  const currentUserId = (req: FastifyRequest) => {
    const { user } = resolveRequestUser(req, container);
    return user.id;
  };

  app.get("/integrations/telegram/status", { schema: { tags: ["telegram"] } }, async (req) => {
    const userId = currentUserId(req);
    const accounts = container.telegramAccountRepo.byUser(userId).map(serialize);
    // "connected" must mean a real bot token is in play — the mock service
    // answers health() with true, which used to make the UI claim a global bot
    // existed when there was none.
    const globalConfigured = runtime.status().enabled && runtime.status().hasToken;
    const publicBase = publicBaseFrom(req);
    // Reconcile the receive path (webhook registration and/or the poller) and
    // any account that asked for polling. Both are idempotent no-ops when
    // nothing changed, so this is safe to run on every UI poll.
    await runtime.start(publicBase);
    await runtime.syncAccountPollers().catch(() => undefined);
    const status = runtime.status();
    const receiving = status.transport !== "off" || accounts.some((a) => a.transport === "polling" || a.webhookSet);
    return {
      connected: (globalConfigured || accounts.some((a) => a.connected)) && receiving,
      configured: globalConfigured || accounts.some((a) => a.connected),
      // "ready" is about the *platform* bot: a receive path is running and Telegram
      // accepted the token. The UI colours its dot with this, never with
      // `configured`, so a rejected or half-registered bot can't look healthy.
      // Personal bots report for themselves in `accounts[]`.
      ready: status.ready,
      receiving,
      hasToken: status.hasToken,
      tokenProblem: status.tokenProblem,
      globalConnected: globalConfigured,
      kind: telegram.constructor.name,
      // Show the actual public HTTPS URL the webhook uses (from the request host
      // or PUBLIC_WEB_BASE_URL), not the http://localhost default.
      baseUrl: publicBase,
      webhookUrl: webhookUrlFor(publicBase),
      transport: status.transport,
      mode: status.mode,
      apiBase: status.apiBase,
      realApi: status.realApi,
      botUsername: status.botUsername,
      webhookSet: status.webhookSet,
      webhookError: status.webhookError,
      webhookInfo: status.webhookInfo,
      polling: status.polling,
      fixes: status.fixes,
      note: status.note,
      accounts,
    };
  });

  /** Step-by-step "what do I have to do" answer, from Telegram's own point of view. */
  app.get("/integrations/telegram/test", { schema: { tags: ["telegram"] } }, async () => runtime.connectionTest());

  // Round-trip diagnostics straight from Telegram's own view of this bot.
  app.get("/integrations/telegram/diagnostics", { schema: { tags: ["telegram"] } }, async (req) => {
    const status = await runtime.diagnostics(true);
    return { ...status, checkedFrom: publicBaseFrom(req) };
  });

  /** Switch the receive transport without redeploying (UI toggle / curl). */
  app.post("/integrations/telegram/transport", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    const b = (req.body ?? {}) as { mode?: string; baseUrl?: string };
    const mode = String(b.mode ?? "").trim() as TelegramMode;
    if (!MODES.includes(mode)) return fail(reply, 400, `mode must be one of ${MODES.join(" | ")}`);
    const status = await runtime.setMode(mode, b.baseUrl ? String(b.baseUrl).replace(/\/$/, "") : publicBaseFrom(req));
    // Report the *outcome*, not the intent: a requested mode that could not be
    // brought up (no public URL, token rejected) must not look like success.
    const ok = mode === "off" ? true : status.transport === mode && !status.webhookError;
    return {
      ok,
      mode,
      transport: status.transport,
      message: ok
        ? mode === "off"
          ? "Telegram receiving is off; sending still works."
          : `receiving via ${status.transport}`
        : status.webhookError ?? status.fixes[0] ?? `could not switch to ${mode}`,
      status,
    };
  });

  /** Re-register the webhook now (e.g. right after setting PUBLIC_WEB_BASE_URL). */
  app.post("/integrations/telegram/webhook/refresh", { schema: { tags: ["telegram"] } }, async (req) => {
    const base = publicBaseFrom(req);
    const res = await runtime.registerWebhook(webhookUrlFor(base));
    const status = await runtime.diagnostics(true);
    return { ok: res.ok, url: webhookUrlFor(base), error: res.error, status };
  });

  /** Drop Telegram's queued backlog so a restarted bot doesn't replay old messages. */
  app.post("/integrations/telegram/updates/skip", { schema: { tags: ["telegram"] } }, async (_req, reply) => {
    const skipped = await runtime.skipPendingUpdates().catch(() => undefined);
    if (skipped === undefined) return fail(reply, 409, "long polling is not active for this deployment");
    return { ok: true, skipped };
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
    const connected = await connectAccount(account, publicBaseFrom(req));
    reply.code(201);
    return {
      account: serialize(connected),
      webhookUrl: runtime.status().webhookUrl ?? webhookUrlFor(getPublicBaseUrl()),
      // Tell the user exactly where their bot is now listening, and what to do
      // if they'd rather have a webhook (serverless/multi-replica setups).
      receiving: connected.transport === "polling" ? "long polling (getUpdates)" : connected.webhookSet ? "webhook" : "nothing — see lastError",
      chatIdHint: !accountId
        ? "Tip: message your bot, send /id to it, and put that number in AccountId so updates route to your account."
        : undefined,
      // Two receivers on one token = every message answered twice.
      warning: sameTokenAsPlatformBot(token)
        ? "This is the same bot token as the platform bot, so both receivers will answer every message. Create a separate bot in @BotFather for a personal account, or delete this account and use the platform bot."
        : undefined,
    };
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
      const connected = await connectAccount(next, publicBaseFrom(req));
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
    const connected = await connectAccount(account, publicBaseFrom(req));
    return serialize(connected);
  });

  /** Force an account onto polling (or back onto the webhook). */
  app.post("/integrations/telegram/accounts/:id/transport", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = currentUserId(req);
    const account = container.telegramAccountRepo.findByIdAndUser(id, userId);
    if (!account) return fail(reply, 404, "Telegram account not found");
    const b = (req.body ?? {}) as { transport?: string };
    const want = String(b.transport ?? "polling");
    if (want === "polling") {
      const status = await runtime.startAccountPolling(account);
      const updated: TelegramAccount = {
        ...account,
        transport: "polling",
        pollingActive: !!status?.running,
        webhookSet: false,
        lastCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: status?.running ? undefined : status?.note ?? "poller not running",
      };
      container.telegramAccountRepo.upsert(updated);
      return { ok: !!status?.running, account: serialize(updated), status };
    }
    await runtime.stopAccountPolling(id);
    const connected = await connectAccount({ ...account, transport: "webhook" }, publicBaseFrom(req));
    return { ok: true, account: serialize(connected) };
  });

  app.delete("/integrations/telegram/accounts/:id", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = currentUserId(req);
    const account = container.telegramAccountRepo.findByIdAndUser(id, userId);
    if (!account) return fail(reply, 404, "Telegram account not found");
    await runtime.stopAccountPolling(id);
    container.telegramAccountRepo.deleteById(id);
    return { ok: true };
  });

  // Global + per-account webhook. A user bot's webhook points at the same
  // public URL; the router picks the right account by :accountId or the
  // incoming chat/user id.
  const handleWebhook = async (body: unknown, accountId?: string, req?: FastifyRequest) => {
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
    // A successful delivery proves the webhook path works — record it so the UI
    // can say "receiving via webhook" without another API round-trip.
    if (account && !account.webhookSet && req) {
      container.telegramAccountRepo.upsert({
        ...account,
        webhookSet: true,
        transport: "webhook",
        lastCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    if (req) learnPublicBaseUrl(publicBaseFrom(req).replace(/\/$/, ""));
    return { ok: true, account: account ? account.id : undefined, update };
  };

  /**
   * Telegram posts updates here. Two rules matter:
   *  • always answer 200 — a 4xx/5xx makes Telegram retry and, after repeated
   *    failures, *disable the webhook*, which looks like "the bot died";
   *  • when a secret token is configured, require it, because this route is
   *    public and anyone could otherwise forge "approved" callbacks.
   */
  const webhookHandler = async (req: FastifyRequest, reply: FastifyReply, accountId?: string) => {
    const expected = getEnv().TELEGRAM_WEBHOOK_SECRET;
    const provided = req.headers["x-telegram-bot-api-secret-token"];
    if (!verifyTelegramWebhookSecret(provided == null ? undefined : String(provided), expected)) {
      logger.warn("telegram webhook rejected: secret token mismatch");
      reply.code(401);
      return { error: "invalid telegram webhook secret token" };
    }
    try {
      reply.code(200);
      return await handleWebhook(req.body, accountId, req);
    } catch (err) {
      logger.error("telegram webhook error", { err: String(err) });
      // 200 anyway: the failure is reported to the chat (below) and logged.
      reply.code(200);
      return { ok: false, error: String(err) };
    }
  };

  app.post("/integrations/telegram/webhook/:accountId", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    return webhookHandler(req, reply, accountId);
  });

  app.post("/integrations/telegram/webhook", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    return webhookHandler(req, reply);
  });

  // Manually drive a telegram-style message (for the web UI "Telegram" preview).
  app.post("/integrations/telegram/command", { schema: { tags: ["telegram"] } }, async (req) => {
    const b = req.body as { chatId?: string; text?: string; callbackData?: string; deliver?: boolean };
    const payload: Record<string, unknown> = b.callbackData
      ? { update_id: Date.now(), callback_query: { id: `web-${Date.now()}`, data: b.callbackData, from: { id: b.chatId ?? "web" }, message: { chat: { id: b.chatId ?? "web", type: "private" }, message_id: 1 } } }
      : { update_id: Date.now(), message: { chat: { id: b.chatId ?? "web", type: "private" }, from: { id: b.chatId ?? "web" }, text: b.text } };
    // "Deliver" actually sends through the configured service (a real bot gets
    // the message); otherwise this is a dry-run preview of what the bot replies.
    if (b.deliver) {
      const update = await botFor().handle(payload);
      return { ok: true, update, delivered: true };
    }
    const { update, reply, error } = await botFor().preview(payload);
    return { ok: !error, update, reply, error };
  });

  app.post("/integrations/telegram/send", { schema: { tags: ["telegram"] } }, async (req) => {
    const b = req.body as { chatId?: string; text?: string };
    const chatId = b.chatId ?? "";
    if (!chatId) return { ok: false, error: "chatId is required — message your bot and send /id to get it" };
    const ok = await telegram.sendMessage({ chatId, text: b.text ?? "" });
    return { ok, transport: runtime.status().transport };
  });
}
