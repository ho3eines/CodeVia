import { getEnv } from "../config/env.js";
import { decryptSecret, encryptSecret, maskSecret } from "../auth/encrypted-secrets.js";
import type { TelegramAccount } from "../domain/telegram.js";
import { logger } from "../logger.js";

export interface TelegramMessage {
  chatId: string;
  text?: string;
  inlineKeyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

export interface TelegramUpdate {
  updateId: number;
  chatId?: string;
  userId?: string;
  text?: string;
  callbackData?: string;
  /** `callback_query.id` — used to answer the callback so Telegram stops the button spinner. */
  callbackId?: string;
  /** Telegram message id of the message the user interacted with (for callback/edits). */
  messageId?: number;
}

export interface ITelegramService {
  sendMessage(msg: TelegramMessage): Promise<boolean>;
  sendButtons(msg: TelegramMessage): Promise<boolean>;
  sendDocument(chatId: string, filename: string, content: string): Promise<boolean>;
  /** Acknowledge an inline-button callback so the button doesn't spin/fail. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
  /** Edit an existing bot message (used for inline-keyboard navigation). */
  editMessage(msg: TelegramMessage & { messageId: number }): Promise<boolean>;
  handleUpdate(update: unknown): Promise<TelegramUpdate | undefined>;
  health(): Promise<boolean>;
}

/**
 * Real Telegram Bot API adapter via `fetch`. Token comes from the environment
 * (TELEGRAM_BOT_TOKEN) and is never stored in the repo.
 */
export class TelegramBotApiService implements ITelegramService {
  private readonly token?: string;
  constructor(token?: string) {
    this.token = token ?? getEnv().TELEGRAM_BOT_TOKEN;
  }

  private get base(): string {
    return `https://api.telegram.org/bot${this.token}`;
  }

  private async post(method: string, body: Record<string, unknown>): Promise<boolean> {
    if (!this.token) return false;
    try {
      const res = await fetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok: boolean };
      if (!json.ok) logger.warn(`telegram ${method} failed`, { body });
      return json.ok;
    } catch (err) {
      logger.error(`telegram ${method} error`, { err: String(err) });
      return false;
    }
  }

  async sendMessage(msg: TelegramMessage): Promise<boolean> {
    return this.post("sendMessage", {
      chat_id: msg.chatId,
      text: msg.text ?? "",
      reply_markup: msg.inlineKeyboard?.length
        ? { inline_keyboard: msg.inlineKeyboard }
        : undefined,
    });
  }

  async sendButtons(msg: TelegramMessage): Promise<boolean> {
    return this.sendMessage(msg);
  }

  async sendDocument(chatId: string, filename: string, content: string): Promise<boolean> {
    // sendDocument requires multipart; for simplicity use sendMessage with the
    // content. A production adapter would upload via multipart form-data.
    return this.sendMessage({ chatId, text: `📄 ${filename}\n\n${content.slice(0, 3500)}` });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.post("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }

  async editMessage(msg: TelegramMessage & { messageId: number }): Promise<boolean> {
    return this.post("editMessageText", {
      chat_id: msg.chatId,
      message_id: msg.messageId,
      text: msg.text ?? "",
      reply_markup: msg.inlineKeyboard?.length
        ? { inline_keyboard: msg.inlineKeyboard }
        : undefined,
    });
  }

  async handleUpdate(update: TelegramUpdate | unknown): Promise<TelegramUpdate | undefined> {
    // Updates may be a plain text `message` (commands / natural language) or a
    // `callback_query` (inline-button press). A callback carries its own
    // `message.chat`, so we must read chat/user/text from BOTH shapes — otherwise
    // the bot never knows where to reply and inline buttons go dead.
    const u = update as {
      update_id?: number;
      message?: { chat?: { id?: number }; from?: { id?: number }; text?: string; message_id?: number };
      callback_query?: { id?: string; data?: string; from?: { id?: number }; message?: { chat?: { id?: number }; message_id?: number } };
    };
    const chat = u.message ?? u.callback_query?.message ?? undefined;
    const chatId = chat?.chat?.id ?? u.callback_query?.from?.id ?? u.message?.from?.id;
    const userId = u.message?.from?.id ?? u.callback_query?.from?.id;
    return {
      updateId: u.update_id ?? 0,
      chatId: chatId != null ? String(chatId) : undefined,
      userId: userId != null ? String(userId) : undefined,
      text: u.message?.text,
      callbackData: u.callback_query?.data,
      callbackId: u.callback_query?.id,
      messageId: chat?.message_id,
    };
  }

  async health(): Promise<boolean> {
    return !!this.token;
  }
}

/** Mock telegram service for dev/test — records messages instead of sending. */
export class MockTelegramService implements ITelegramService {
  sent: TelegramMessage[] = [];
  readonly kind = "mock" as const;
  async sendMessage(msg: TelegramMessage): Promise<boolean> {
    this.sent.push(msg);
    logger.info("[mock-telegram] sendMessage", { chatId: msg.chatId, text: msg.text?.slice(0, 80) });
    return true;
  }
  async sendButtons(msg: TelegramMessage): Promise<boolean> {
    this.sent.push(msg);
    return true;
  }
  async sendDocument(chatId: string, filename: string, content: string): Promise<boolean> {
    this.sent.push({ chatId, text: `📄 ${filename}\n\n${content.slice(0, 300)}` });
    return true;
  }
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    this.sent.push({ chatId: callbackQueryId, text: text ?? "" });
    return true;
  }
  async editMessage(msg: TelegramMessage & { messageId: number }): Promise<boolean> {
    this.sent.push(msg);
    return true;
  }
  async handleUpdate(update: unknown): Promise<TelegramUpdate> {
    const u = update as {
      update_id?: number;
      message?: { chat?: { id?: number }; text?: string; message_id?: number };
      callback_query?: { id?: string; data?: string; message?: { chat?: { id?: number }; message_id?: number } };
    };
    const chat = u.message ?? u.callback_query?.message ?? undefined;
    const chatId = chat?.chat?.id ?? u.callback_query?.message?.chat?.id;
    return {
      updateId: u.update_id ?? 0,
      chatId: chatId != null ? String(chatId) : undefined,
      text: u.message?.text,
      callbackData: u.callback_query?.data,
      callbackId: u.callback_query?.id,
      messageId: chat?.message_id,
    };
  }
  async health(): Promise<boolean> {
    return true;
  }
}

export function resolveTelegramService(): ITelegramService {
  const env = getEnv();
  if (env.TELEGRAM_BOT_TOKEN) return new TelegramBotApiService();
  logger.info("Using MockTelegramService (no TELEGRAM_BOT_TOKEN)");
  return new MockTelegramService();
}

export function createMockTelegram(): MockTelegramService {
  return new MockTelegramService();
}

/* ------------------------------------------------------------------ *
 * Per-user Telegram accounts
 * ------------------------------------------------------------------ */

export interface TelegramGetMe {
  ok: boolean;
  username?: string;
  id?: number;
  botId?: string;
  error?: string;
}

export function getTelegramWebhookUrl(): string {
  const env = getEnv();
  if (env.TELEGRAM_WEBHOOK_URL?.trim()) {
    return env.TELEGRAM_WEBHOOK_URL.trim();
  }
  const base = env.PUBLIC_WEB_BASE_URL ?? env.WEB_BASE_URL;
  return `${String(base).replace(/\/$/, "")}/integrations/telegram/webhook`;
}

/** Telegram only accepts HTTPS webhooks. Returns a friendly reason if not. */
export function validateTelegramWebhookUrl(url: string): { ok: boolean; error?: string } {
  if (!url) return { ok: false, error: "no public webhook URL is configured" };
  if (!/^https:\/\//i.test(url)) {
    return {
      ok: false,
      error: `webhook URL must be HTTPS (got "${url}"). Set PUBLIC_WEB_BASE_URL or TELEGRAM_WEBHOOK_URL to a public HTTPS URL — e.g. https://<your-app>.up.railway.app — or use an HTTPS tunnel (ngrok/cloudflared) for local dev.`,
    };
  }
  // A localhost webhook will never be reachable from Telegram.
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
      return { ok: false, error: `webhook URL "${url}" points at localhost, which Telegram cannot reach. Use a public HTTPS URL.` };
    }
  } catch {
    return { ok: false, error: `invalid webhook URL "${url}"` };
  }
  return { ok: true };
}

export function accountTelegramToken(account: TelegramAccount): string | undefined {
  return decryptSecret(account.tokenEnc, "telegram-token");
}

export function accountTelegramService(account: TelegramAccount): ITelegramService {
  const token = accountTelegramToken(account);
  return token ? new TelegramBotApiService(token) : new MockTelegramService();
}

export function encryptTelegramToken(token: string): string {
  return JSON.stringify(encryptSecret(token, "telegram-token"));
}

export function maskTelegramToken(token: string | undefined): string {
  return maskSecret(token);
}

/** Real connection verification against the Telegram Bot API. */
export async function testTelegramToken(token: string): Promise<TelegramGetMe> {
  if (!token) return { ok: false, error: "Token is required" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`, { method: "GET" });
    const body = (await res.json()) as { ok: boolean; result?: { username?: string; id?: number } };
    if (body.ok && body.result) {
      return {
        ok: true,
        username: body.result.username,
        id: body.result.id,
        botId: String(body.result.id),
      };
    }
    return { ok: false, error: "Telegram rejected the token (invalid bot token?)" };
  } catch (err) {
    return { ok: false, error: `Telegram API error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Register the platform webhook for a user bot (real connection). */
export async function setTelegramWebhook(token: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const valid = validateTelegramWebhookUrl(url);
  if (!valid.ok) return { ok: false, error: valid.error };
  try {
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = (await res.json()) as { ok: boolean; description?: string };
    return body.ok ? { ok: true } : { ok: false, error: body.description || "setWebhook failed" };
  } catch (err) {
    return { ok: false, error: `setWebhook error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
