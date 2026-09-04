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
}

export interface ITelegramService {
  sendMessage(msg: TelegramMessage): Promise<boolean>;
  sendButtons(msg: TelegramMessage): Promise<boolean>;
  sendDocument(chatId: string, filename: string, content: string): Promise<boolean>;
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

  async handleUpdate(update: TelegramUpdate | unknown): Promise<TelegramUpdate | undefined> {
    const u = update as { update_id?: number; message?: { chat?: { id?: number }; from?: { id?: number }; text?: string }; callback_query?: { data?: string } };
    return {
      updateId: u.update_id ?? 0,
      chatId: u.message?.chat?.id != null ? String(u.message.chat.id) : undefined,
      userId: u.message?.from?.id != null ? String(u.message.from.id) : undefined,
      text: u.message?.text,
      callbackData: u.callback_query?.data,
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
  async handleUpdate(update: unknown): Promise<TelegramUpdate> {
    const u = update as { update_id?: number; message?: { chat?: { id?: number }; text?: string }; callback_query?: { data?: string } };
    return {
      updateId: u.update_id ?? 0,
      chatId: u.message?.chat?.id != null ? String(u.message.chat.id) : undefined,
      text: u.message?.text,
      callbackData: u.callback_query?.data,
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
  const base = env.PUBLIC_WEB_BASE_URL ?? env.WEB_BASE_URL;
  return `${String(base).replace(/\/$/, "")}/integrations/telegram/webhook`;
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
