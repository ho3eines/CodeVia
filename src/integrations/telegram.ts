import { getEnv } from "../config/env.js";
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
