import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import { TelegramBot } from "../../integrations/telegram-bot.js";
import { resolveTelegramService } from "../../integrations/telegram.js";
import { eventBus } from "../../events/bus.js";
import { logger } from "../../logger.js";

export function registerTelegramRoutes(app: FastifyInstance, container: Container): void {
  const telegram = resolveTelegramService();
  const bot = new TelegramBot({
    telegram,
    projectRepo: container.projectRepo,
    taskRepo: container.taskRepo,
    agentRepo: container.agentRepo,
    runRepo: container.runRepo,
    agentManager: container.agentManager,
    github: container.github,
    logger: logger.child({ component: "telegram-bot" }),
  });

  app.get("/integrations/telegram/status", { schema: { tags: ["telegram"] } }, async () => {
    return { connected: await telegram.health(), kind: telegram.constructor.name };
  });

  app.post("/integrations/telegram/webhook", { schema: { tags: ["telegram"] } }, async (req, reply) => {
    const body = req.body;
    try {
      const update = await bot.handle(body);
      reply.code(200);
      return { ok: true, update };
    } catch (err) {
      logger.error("telegram webhook error", { err: String(err) });
      reply.code(200);
      return { ok: false, error: String(err) };
    }
  });

  // Manually drive a telegram-style message (for the web UI "Telegram" preview).
  app.post("/integrations/telegram/command", { schema: { tags: ["telegram"] } }, async (req) => {
    const b = req.body as { chatId?: string; text?: string };
    const update = await bot.handle({ update_id: Date.now(), message: { chat: { id: b.chatId ?? "web" }, from: { id: "web" }, text: b.text } });
    return { ok: true, update };
  });

  app.post("/integrations/telegram/send", { schema: { tags: ["telegram"] } }, async (req) => {
    const b = req.body as { chatId?: string; text?: string };
    const ok = await telegram.sendMessage({ chatId: b.chatId ?? "web", text: b.text ?? "" });
    void eventBus;
    return { ok };
  });
}
