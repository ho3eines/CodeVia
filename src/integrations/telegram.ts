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
  /** Telegram chat type ("private" | "group" | "supergroup" | "channel"). */
  chatType?: string;
  /** Sender display name, used to greet users and to diagnose "why is my bot silent". */
  username?: string;
}

/** Result of a raw Bot API call: never a silent `false` — the reason is kept. */
export interface TelegramApiResult<T = unknown> {
  ok: boolean;
  result?: T;
  /** Telegram `error_code` (400/401/403/409/429/5xx). */
  errorCode?: number;
  /** Telegram `description`, i.e. the human-readable reason the call failed. */
  error?: string;
  /** `parameters.retry_after` for 429 flood limits. */
  retryAfterSec?: number;
}

export interface TelegramUpdatesParams {
  offset?: number;
  timeoutSec?: number;
  limit?: number;
  allowedUpdates?: string[];
  signal?: AbortSignal;
}

export interface TelegramUpdatesResult extends TelegramApiResult {
  updates: unknown[];
}

export interface TelegramWebhookInfo {
  url?: string;
  hasCustomCertificate?: boolean;
  pendingUpdateCount?: number;
  lastError?: string;
  lastErrorDate?: number;
  maxConnections?: number;
  allowedUpdates?: string[];
  /** True when no webhook is registered (i.e. getUpdates/polling is allowed). */
  empty?: boolean;
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
 * Services that can actively talk to a bot (verify the token, register a
 * webhook, long-poll updates). The mock does not implement this, which is how
 * the platform knows polling/webhook management is unavailable in offline mode.
 */
export interface TelegramConnection {
  readonly token: string;
  readonly configured: boolean;
  /** Why the token cannot be used (missing / malformed), if it cannot. */
  readonly tokenProblem?: string;
  getMe(signal?: AbortSignal): Promise<TelegramApiResult<{ id?: number; username?: string; can_read_all_group_messages?: boolean; supports_inline_queries?: boolean }>>;
  getWebhookInfo(signal?: AbortSignal): Promise<TelegramWebhookInfo>;
  setWebhook(url: string, opts?: { secretToken?: string; maxConnections?: number }): Promise<TelegramApiResult>;
  deleteWebhook(dropPending?: boolean): Promise<TelegramApiResult>;
  getUpdates(params?: TelegramUpdatesParams): Promise<TelegramUpdatesResult>;
}

/** The update types a polling bot must ask for (mirrors the webhook payload). */
export const TELEGRAM_ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "channel_post"] as const;

/* ------------------------------------------------------------------ *\
 * Text formatting
 *
 * The bot writes lightweight Markdown (`*bold*`, `` `code` ``). Telegram only
 * renders that if the message is sent with a `parse_mode` — without it the
 * asterisks show up verbatim and every menu looks broken. We render HTML, which
 * (unlike Telegram's legacy Markdown) survives arbitrary user/agent text as
 * long as everything is escaped first.
 * ------------------------------------------------------------------ */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert our Markdown-ish text into escaped Telegram-safe HTML. */
export function toTelegramHtml(text: string): string {
  const parts = String(text ?? "").split(/(`[^`\n]+`)/g);
  return parts
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/\*([^\n*]+)\*/g, "<b>$1</b>")
        .replace(/__([^\n_]+)__/g, "<u>$1</u>");
    })
    .join("");
}

/** Telegram hard-caps a text message at 4096 characters. */
export const TELEGRAM_TEXT_LIMIT = 4096;

export function clampTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  return `${s.slice(0, limit - 1)}\u2026`;
}

function markup(keyboard?: TelegramMessage["inlineKeyboard"]): Record<string, unknown> | undefined {
  return keyboard?.length ? { inline_keyboard: keyboard } : undefined;
}

/**
 * Real Telegram Bot API adapter via `fetch`. Token comes from the environment
 * (TELEGRAM_BOT_TOKEN) or from a per-user account, and is never stored in the repo.
 */
export class TelegramBotApiService implements ITelegramService, TelegramConnection {
  readonly token: string;
  /** Last API failure, surfaced in /integrations/telegram/status so "it doesn't work" is debuggable. */
  lastError?: string;
  lastErrorCode?: number;
  lastErrorAt?: string;
  lastOkAt?: string;
  /** True once a call has been made with the configured token (used by health()). */
  readonly kind = "telegram" as const;

  constructor(token?: string) {
    this.token = (token ?? getEnv().TELEGRAM_BOT_TOKEN ?? "").trim();
  }

  /** A syntactically plausible `@BotFather` token (used for warnings, never to
   *  block a call — Telegram itself rejects bad tokens with 401 and we surface
   *  that verbatim rather than second-guessing a token that might be valid). */
  get configured(): boolean {
    return /^\d+:[\w-]{8,}$/.test(this.token);
  }

  get tokenProblem(): string | undefined {
    if (!this.token) return "no bot token configured";
    if (!this.configured) return 'token format looks wrong — expected "<botId>:<secret>" from @BotFather';
    return undefined;
  }

  private get base(): string {
    let apiBase = "https://api.telegram.org";
    try {
      apiBase = (getEnv().TELEGRAM_API_BASE || apiBase).replace(/\/$/, "");
    } catch {
      /* env unavailable (bare unit test) — use the real API */
    }
    return `${apiBase}/bot${encodeURIComponent(this.token)}`;
  }

  private noteFailure(res: TelegramApiResult): void {
    this.lastError = res.error ?? "Telegram API call failed";
    this.lastErrorCode = res.errorCode;
    this.lastErrorAt = new Date().toISOString();
  }

  /**
   * Single choke point for every Bot API call. Returns a structured result
   * instead of a boolean so callers can log/act on the *reason* (401 = bad
   * token, 403 = bot blocked/not a member, 409 = webhook conflict, 429 = flood).
   */
  async call<T = unknown>(
    method: string,
    body?: Record<string, unknown> | FormData,
    opts: { retries?: number; signal?: AbortSignal } = {},
  ): Promise<TelegramApiResult<T>> {
    if (!this.token) {
      const res: TelegramApiResult<T> = { ok: false, error: `telegram ${method}: no bot token configured` };
      this.noteFailure(res);
      return res;
    }
    const maxRetries = opts.retries ?? 1;
    let attempt = 0;
    // 429 responses carry `retry_after`; everything else is a single attempt.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      try {
        const isForm = body instanceof FormData;
        const res = await fetch(`${this.base}/${method}`, {
          method: "POST",
          // Never set Content-Type for FormData — fetch must add the multipart boundary.
          headers: isForm ? undefined : { "Content-Type": "application/json" },
          body: isForm ? body : body ? JSON.stringify(body) : undefined,
          signal: opts.signal,
        });
        const json = (await res.json().catch(() => undefined)) as
          | { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }
          | undefined;
        if (json?.ok) {
          this.lastOkAt = new Date().toISOString();
          return { ok: true, result: json.result };
        }
        const out: TelegramApiResult<T> = {
          ok: false,
          errorCode: json?.error_code ?? res.status,
          error: json?.description || `telegram ${method} failed (HTTP ${res.status})`,
          retryAfterSec: json?.parameters?.retry_after,
        };
        if (out.errorCode === 429 && attempt <= maxRetries) {
          await sleep(((out.retryAfterSec ?? 1) + 0.2) * 1000, opts.signal);
          continue;
        }
        this.noteFailure(out);
        logger.warn(`telegram ${method} failed`, { error: out.error, errorCode: out.errorCode });
        return out;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          return { ok: false, error: "aborted" };
        }
        const out: TelegramApiResult<T> = {
          ok: false,
          error: `telegram ${method} network error: ${describeErr(err)}`,
        };
        if (attempt <= maxRetries) {
          await sleep(500 * attempt, opts.signal);
          continue;
        }
        this.noteFailure(out);
        logger.error(`telegram ${method} error`, { err: String(err) });
        return out;
      }
    }
  }

  private async post(method: string, body: Record<string, unknown>): Promise<boolean> {
    return (await this.call(method, body)).ok;
  }

  async sendMessage(msg: TelegramMessage): Promise<boolean> {
    return this.post("sendMessage", {
      chat_id: msg.chatId,
      text: clampTelegramText(toTelegramHtml(msg.text ?? "")),
      parse_mode: "HTML",
      // Links/mentions must not swallow the keyboard: Telegram rejects an empty
      // text with reply_markup, and MarkdownV2 would need heavy escaping.
      disable_web_page_preview: true,
      reply_markup: markup(msg.inlineKeyboard),
    });
  }

  async sendButtons(msg: TelegramMessage): Promise<boolean> {
    return this.sendMessage(msg);
  }

  async sendDocument(chatId: string, filename: string, content: string): Promise<boolean> {
    // Real multipart upload (a plain sendMessage of a long log gets truncated
    // and unreadable); fall back to a text message if the upload is rejected.
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("caption", clampTelegramText(toTelegramHtml(`📄 ${filename}`), 1024));
    form.set("document", new Blob([content], { type: "text/plain" }), filename);
    if (await this.post("sendDocument", form as unknown as Record<string, unknown>)) return true;
    return this.sendMessage({ chatId, text: `📄 ${filename}\n\n${content.slice(0, 3500)}` });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.post("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }

  async editMessage(msg: TelegramMessage & { messageId: number }): Promise<boolean> {
    return this.post("editMessageText", {
      chat_id: msg.chatId,
      message_id: msg.messageId,
      text: clampTelegramText(toTelegramHtml(msg.text ?? "")),
      parse_mode: "HTML",
      reply_markup: markup(msg.inlineKeyboard),
    });
  }

  async handleUpdate(update: unknown): Promise<TelegramUpdate | undefined> {
    return normalizeTelegramUpdate(update);
  }

  async getMe(signal?: AbortSignal): Promise<TelegramApiResult<{ id?: number; username?: string }>> {
    return this.call("getMe", undefined, { signal });
  }

  async getWebhookInfo(signal?: AbortSignal): Promise<TelegramWebhookInfo> {
    const res = await this.call<{
      url?: string;
      has_custom_certificate?: boolean;
      pending_update_count?: number;
      last_error_message?: string;
      last_error_date?: number;
      max_connections?: number;
      allowed_updates?: string[];
    }>("getWebhookInfo", undefined, { signal });
    if (!res.ok) {
      // Never report "no webhook is registered" when we could not ask — that
      // misdiagnosis costs people an hour.
      return { lastError: res.error };
    }
    const r = res.result ?? {};
    return {
      url: r.url || undefined,
      hasCustomCertificate: r.has_custom_certificate,
      pendingUpdateCount: r.pending_update_count,
      lastError: r.last_error_message || undefined,
      lastErrorDate: r.last_error_date,
      maxConnections: r.max_connections,
      allowedUpdates: r.allowed_updates,
      empty: !r.url,
    };
  }

  async setWebhook(url: string, opts: { secretToken?: string; maxConnections?: number } = {}): Promise<TelegramApiResult> {
    const valid = validateTelegramWebhookUrl(url);
    if (!valid.ok) return { ok: false, error: valid.error };
    return this.call("setWebhook", {
      url,
      secret_token: opts.secretToken || undefined,
      max_connections: opts.maxConnections ?? 40,
      drop_pending_updates: false,
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    });
  }

  async deleteWebhook(dropPending = false): Promise<TelegramApiResult> {
    return this.call("deleteWebhook", { drop_pending_updates: dropPending });
  }

  async getUpdates(params: TelegramUpdatesParams = {}): Promise<TelegramUpdatesResult> {
    const res = await this.call<unknown[]>("getUpdates", {
      offset: params.offset,
      timeout: Math.max(0, Math.min(60, params.timeoutSec ?? getEnv().TELEGRAM_POLL_TIMEOUT ?? 25)),
      limit: params.limit ?? 100,
      allowed_updates: params.allowedUpdates ?? [...TELEGRAM_ALLOWED_UPDATES],
    }, { signal: params.signal, retries: 0 });
    return { ...res, updates: Array.isArray(res.result) ? res.result : [] };
  }

  async health(): Promise<boolean> {
    return !!this.token;
  }
}

/**
 * Normalize any inbound Telegram update into the platform's flat shape.
 *
 * Updates arrive as `message` (commands / natural language), `edited_message`,
 * `callback_query` (inline-button press) or `channel_post`. A callback carries
 * its own `message.chat`, so chat/user/text must be read from BOTH shapes —
 * otherwise the bot never knows where to reply and inline buttons go dead.
 */
export function normalizeTelegramUpdate(update: unknown): TelegramUpdate | undefined {
  const u = update as {
    update_id?: number;
    message?: RawTelegramMessage;
    edited_message?: RawTelegramMessage;
    channel_post?: RawTelegramMessage;
    callback_query?: {
      id?: string;
      data?: string;
      from?: { id?: number; username?: string; first_name?: string };
      message?: { chat?: { id?: number; type?: string }; message_id?: number };
    };
  };
  const src = u.message ?? u.edited_message ?? u.channel_post;
  const chat = src ?? u.callback_query?.message;
  const chatId = chat?.chat?.id ?? u.callback_query?.from?.id ?? src?.from?.id;
  const userId = src?.from?.id ?? u.callback_query?.from?.id;
  // Ignore service chatter (e.g. "user joined the group") — it has no text and
  // must not wake the bot up with a help message.
  if (!src && !u.callback_query) return undefined;
  if (src && src.text === undefined && src.caption === undefined) return undefined;
  return {
    updateId: u.update_id ?? 0,
    chatId: chatId != null ? String(chatId) : undefined,
    userId: userId != null ? String(userId) : undefined,
    text: src?.text ?? src?.caption,
    callbackData: u.callback_query?.data,
    callbackId: u.callback_query?.id,
    messageId: chat?.message_id,
    chatType: chat?.chat?.type,
    username: src?.from?.username ?? u.callback_query?.from?.username,
  };
}

interface RawTelegramMessage {
  chat?: { id?: number; type?: string };
  from?: { id?: number; username?: string; first_name?: string };
  text?: string;
  caption?: string;
  message_id?: number;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function describeErr(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.cause?.message;
  return [e?.message, cause].filter(Boolean).join(" — ") || String(err);
}

/** Mock telegram service for dev/test — records messages instead of sending. */
export class MockTelegramService implements ITelegramService {
  sent: TelegramMessage[] = [];
  readonly kind = "mock" as const;
  /** Updates a test can queue so the polling loop has something to consume. */
  pending: unknown[] = [];
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
    return normalizeTelegramUpdate(update) ?? { updateId: 0 };
  }
  async health(): Promise<boolean> {
    return true;
  }
  /** Mock getUpdates: drains `pending` so polling logic is testable offline. */
  async getUpdates(params: TelegramUpdatesParams = {}): Promise<TelegramUpdatesResult> {
    void params;
    const updates = this.pending;
    this.pending = [];
    return { ok: true, updates, result: updates };
  }
  /** Test helper: queue an inbound update for the polling loop to drain. */
  pushUpdate(update: unknown): void {
    this.pending.push(update);
  }
}

export function isTelegramConnection(svc: ITelegramService | undefined): svc is ITelegramService & TelegramConnection {
  if (!svc) return false;
  const c = svc as unknown as Partial<TelegramConnection>;
  return typeof c.getUpdates === "function" && typeof c.getWebhookInfo === "function" && typeof c.setWebhook === "function";
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

/* ------------------------------------------------------------------ *\
 * Webhook URL resolution
 *
 * Telegram only accepts a public HTTPS webhook URL. The platform may run in
 * several places (local dev, a Railway/container deployment, or the Arena
 * preview at https://{port}-{sandboxId}.e2b.app). Rather than requiring the
 * operator to hard-code PUBLIC_WEB_BASE_URL, we resolve the webhook URL from,
 * in order of precedence:
 *
 *   1. TELEGRAM_WEBHOOK_URL       (explicit override)
 *   2. PUBLIC_WEB_BASE_URL        (public production URL)
 *   3. a URL learned from a real incoming request (host + forwarded proto)
 *   4. WEB_BASE_URL               (dev default)
 *
 * If none of those is a public HTTPS URL the platform falls back to
 * **long polling**, which needs no inbound connectivity at all.
 * ------------------------------------------------------------------ */

let learnedPublicBaseUrl: string | undefined;

/** Remember a public base URL we observed from an actual request (e.g. the
 *  Arena preview host) so later registrations reuse it. */
export function learnPublicBaseUrl(url: string | undefined): void {
  if (!url) return;
  const clean = url.replace(/\/$/, "");
  if (/^https:\/\//i.test(clean) && !/@/.test(clean)) learnedPublicBaseUrl = clean;
}

/** Test hook: forget a learned URL. */
export function resetLearnedPublicBaseUrl(): void {
  learnedPublicBaseUrl = undefined;
}

/** Hosts Telegram can never reach. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h.startsWith("localhost:") || h === "127.0.0.1" || h.startsWith("127.") || h.endsWith(".local");
}

/** `TELEGRAM_WEBHOOK_INSECURE=true` opts out of the https upgrade for public hosts. */
function forceHttpsForPublicHosts(): boolean {
  try {
    return getEnv().TELEGRAM_WEBHOOK_INSECURE !== true;
  } catch {
    return true;
  }
}

export function getPublicBaseUrl(host?: string, proto?: string): string {
  const env = getEnv();
  if (env.PUBLIC_WEB_BASE_URL?.trim()) return env.PUBLIC_WEB_BASE_URL.trim();
  if (learnedPublicBaseUrl) return learnedPublicBaseUrl;
  // Derive from the caller's request: the proxy forwards the real scheme/host.
  if (host && !isLocalHost(host)) {
    // Telegram only accepts HTTPS webhooks. A proxy that reports
    // `x-forwarded-proto: http` in front of a public host (TLS terminated at the
    // edge — Railway, Fly, most k8s ingresses, preview proxies) used to produce
    // `http://host/...` and get rejected with "an HTTPS URL must be provided".
    // For a public host we therefore assume https.
    const scheme = proto === "http" && !forceHttpsForPublicHosts() ? "http" : "https";
    return `${scheme}://${host}`;
  }
  return env.WEB_BASE_URL;
}

export function getTelegramWebhookPath(): string {
  return "/integrations/telegram/webhook";
}

export function getTelegramWebhookUrl(host?: string, proto?: string): string {
  const env = getEnv();
  if (env.TELEGRAM_WEBHOOK_URL?.trim()) {
    return env.TELEGRAM_WEBHOOK_URL.trim();
  }
  const base = getPublicBaseUrl(host, proto);
  return `${String(base).replace(/\/$/, "")}${getTelegramWebhookPath()}`;
}

/** Telegram only accepts HTTPS webhooks. Returns a friendly reason if not. */
export function validateTelegramWebhookUrl(url: string): { ok: boolean; error?: string } {
  if (!url) return { ok: false, error: "no public webhook URL is configured" };
  if (allowLoopbackWebhook()) {
    // Explicit dev/testing opt-in: skip both Telegram's https-only rule and the
    // loopback rule so a webhook round-trip can be exercised against a local Bot
    // API double or a tunnel that only resolves on this machine.
    try {
      new URL(url);
      return { ok: true };
    } catch {
      return { ok: false, error: `invalid webhook URL "${url}"` };
    }
  }
  if (!/^https:\/\//i.test(url)) {
    return {
      ok: false,
      error: `webhook URL must be HTTPS (got "${url}"). Set PUBLIC_WEB_BASE_URL or TELEGRAM_WEBHOOK_URL to a public HTTPS URL — e.g. https://<your-app>.up.railway.app — or use an HTTPS tunnel (ngrok/cloudflared) for local dev.`,
    };
  }
  // A localhost webhook will never be reachable from Telegram — unless the
  // operator explicitly opted in (tailscale, a tunnel that resolves locally, or
  // testing the webhook round-trip against a Bot API double).
  try {
    const host = new URL(url).hostname;
    const loopback = host === "localhost" || host === "127.0.0.1" || host.startsWith("127.") || host.endsWith(".local");
    if (loopback && !allowLoopbackWebhook()) {
      return { ok: false, error: `webhook URL "${url}" points at localhost, which Telegram cannot reach. Use a public HTTPS URL — or set TELEGRAM_WEBHOOK_ALLOW_LOOPBACK=true for local/tunnel testing.` };
    }
  } catch {
    return { ok: false, error: `invalid webhook URL "${url}"` };
  }
  return { ok: true };
}

export function allowLoopbackWebhook(): boolean {
  try {
    return getEnv().TELEGRAM_WEBHOOK_ALLOW_LOOPBACK === true;
  } catch {
    return false;
  }
}

export interface TelegramGetMe {
  ok: boolean;
  username?: string;
  id?: number;
  botId?: string;
  error?: string;
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
  const res = await new TelegramBotApiService(token).getMe();
  if (res.ok && res.result) {
    return {
      ok: true,
      username: res.result.username,
      id: res.result.id,
      botId: res.result.id != null ? String(res.result.id) : undefined,
    };
  }
  if (res.errorCode === 401) return { ok: false, error: "Telegram rejected the token (invalid bot token?)" };
  return {
    ok: false,
    // Keep Telegram's own description when there is one; for network failures the
    // client already says what went wrong ("telegram getMe network error: …"), so
    // don't wrap it in a second "Telegram API error:" layer.
    error: res.error ?? "Telegram rejected the token (invalid bot token?)",
  };
}

/** Register the platform webhook for a user bot (real connection). */
export async function setTelegramWebhook(token: string, url: string, secretToken?: string): Promise<{ ok: boolean; error?: string }> {
  const valid = validateTelegramWebhookUrl(url);
  if (!valid.ok) return { ok: false, error: valid.error };
  const res = await new TelegramBotApiService(token).setWebhook(url, { secretToken: secretToken ?? getEnv().TELEGRAM_WEBHOOK_SECRET });
  return res.ok ? { ok: true } : { ok: false, error: res.error || "setWebhook failed" };
}

/** Remove a webhook so `getUpdates` (long polling) becomes usable again. */
export async function deleteTelegramWebhook(token: string): Promise<{ ok: boolean; error?: string }> {
  const res = await new TelegramBotApiService(token).deleteWebhook(false);
  return res.ok ? { ok: true } : { ok: false, error: res.error || "deleteWebhook failed" };
}

/**
 * Constant-time-ish secret check for inbound webhook posts. Telegram echoes the
 * `secret_token` we passed to setWebhook in the `X-Telegram-Bot-Api-Secret-Token`
 * header; when the operator configured one, anything else is a forgery attempt.
 */
export function verifyTelegramWebhookSecret(headerValue: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true; // no secret configured — nothing to verify
  if (!headerValue) return false;
  if (headerValue.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= headerValue.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * True when a call failed because *this host* could not reach Telegram, as
 * opposed to Telegram rejecting what we sent. Without this distinction a blocked
 * egress policy looks like "the webhook is broken", which sends people off
 * debugging URLs and tokens instead of the network.
 */
export function isTelegramUnreachable(error: string | undefined): boolean {
  if (!error) return false;
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|SSL_ERROR|socket hang up|fetch failed|network error|could not connect/i.test(error);
}

/** Actionable guidance for the most common "bot is silent" causes. */
export function telegramWebhookFixHints(info: TelegramWebhookInfo | undefined, mode: string): string[] {
  const hints: string[] = [];
  const err = info?.lastError ?? "";
  // A failed *query* is not "no webhook" — say which one it is, or people debug
  // a registration that was never the problem.
  if (isTelegramUnreachable(err)) {
    hints.push(`Cannot query Telegram (${err}) — this host has no outbound HTTPS to api.telegram.org. Fix egress first; webhook and polling both need it.`);
    return hints;
  }
  if (info?.empty === true && mode !== "polling") hints.push("No webhook is registered and polling is off — the bot cannot receive messages. Set TELEGRAM_MODE=polling.");
  if (/HTTPS URL must be provided/i.test(err)) hints.push("Telegram rejected the webhook URL: it must be public HTTPS. Set PUBLIC_WEB_BASE_URL or TELEGRAM_WEBHOOK_URL.");
  if (/connection refused|timed out|not enough|bad webhook/i.test(err)) {
    hints.push(`Telegram cannot reach ${info?.url ?? "the webhook URL"} (${err}). Make sure the app is publicly reachable, then press "Reconnect".`);
  }
  if (mode === "webhook" && !info?.url) hints.push('TELEGRAM_MODE=webhook but no webhook is set — run "Refresh webhook" or switch to TELEGRAM_MODE=auto.');
  if ((info?.pendingUpdateCount ?? 0) > 0) {
    hints.push(`${info?.pendingUpdateCount} update(s) queued at Telegram but not delivered — the webhook endpoint is failing or unreachable.`);
  }
  return hints;
}
