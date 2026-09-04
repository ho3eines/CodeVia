import { DocumentRepository } from "../db/repository.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import type { ID } from "../types.js";
import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ *
 * Per-user Telegram bot account.
 *
 * Each platform user can register their own Telegram bot token (+ their
 * Telegram AccountId/chat). The token is encrypted at rest (AES-256-GCM)
 * in the runtime store; API responses only ever return a mask. A real
 * Telegram Bot API connection is verified with `getMe`, and the public
 * webhook URL can be registered with `setWebhook`.
 * ------------------------------------------------------------------ */

export interface TelegramAccount {
  id: ID;
  /** Platform user that owns this bot account (undefined = server/global bot). */
  userId?: ID;
  name?: string;
  /** AES-GCM encrypted Telegram bot token. */
  tokenEnc: string;
  /** Telegram numeric account id / chat id the user wants this bot bound to. */
  accountId?: string;
  /** Telegram chat id used for outgoing messages (defaults to accountId). */
  chatId?: string;
  botUsername?: string;
  botId?: string;
  connected: boolean;
  webhookSet?: boolean;
  /** How this bot receives updates: pushed webhook, long polling (no URL needed), or off. */
  transport?: "webhook" | "polling" | "off";
  /** Long polling is active for this account right now. */
  pollingActive?: boolean;
  lastCheckedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export class TelegramAccountRepository extends DocumentRepository<TelegramAccount> {
  constructor(db: Db = getDb()) {
    super("telegram-account", db);
  }

  create(data: Omit<TelegramAccount, "id" | "createdAt" | "updatedAt">): TelegramAccount {
    const now = new Date().toISOString();
    const account: TelegramAccount = { ...data, id: randomUUID(), createdAt: now, updatedAt: now };
    this.upsert(account);
    return account;
  }

  byUser(userId: string | undefined): TelegramAccount[] {
    const all = this.findMany().map((r) => r.data);
    return userId ? all.filter((a) => a.userId === userId) : all.filter((a) => !a.userId);
  }

  findByIdAndUser(id: string, userId?: string): TelegramAccount | undefined {
    return this.byUser(userId).find((a) => a.id === id);
  }

  byTelegramId(telegramId: string | undefined): TelegramAccount[] {
    if (!telegramId) return [];
    const all = this.findMany().map((r) => r.data);
    return all.filter((a) => a.accountId === telegramId || a.chatId === telegramId);
  }
}

export function getTelegramAccountRepo(): TelegramAccountRepository {
  return new TelegramAccountRepository();
}
