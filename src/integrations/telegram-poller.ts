import type { ITelegramService, TelegramConnection, TelegramUpdatesResult } from "./telegram.js";
import { isTelegramConnection, sleep, TELEGRAM_ALLOWED_UPDATES } from "./telegram.js";
import type { Logger } from "../logger.js";

/** Minimal persistence so a restart does not replay (or drop) every update. */
export interface TelegramPollStateStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface TelegramPollerStatus {
  transport: "polling";
  running: boolean;
  startedAt?: string;
  lastPollAt?: string;
  lastUpdateAt?: string;
  updatesReceived: number;
  /** Consecutive failures — drives the exponential backoff and the UI badge. */
  consecutiveErrors: number;
  lastError?: string;
  lastErrorAt?: string;
  offset?: number;
  /** True while the poller is trying to clear a blocking webhook registration. */
  resolvingConflict: boolean;
  note?: string;
}

export interface TelegramPollerDeps {
  /** Label used in logs/status ("global", account id, …). */
  name?: string;
  service: ITelegramService;
  /** Handle one raw Telegram update. Throwing never kills the loop. */
  onUpdate: (update: unknown) => Promise<void> | void;
  logger: Logger;
  state?: TelegramPollStateStore;
  /** Long-poll hold time (seconds). */
  timeoutSec?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Delete any registered webhook before polling (Telegram returns 409 otherwise). */
  deleteWebhookOnStart?: boolean;
  allowedUpdates?: string[];
}

/**
 * Long-polling receiver (`getUpdates`) — the transport that makes a Telegram bot
 * work with *only* a token: no public HTTPS host, no ngrok, no webhook.
 *
 * Why this exists: webhook-only bots are silent in local dev, behind NAT, on a
 * preview host Telegram cannot reach, or whenever `setWebhook` failed. The #1
 * complaint ("the bot never replies") is a receive-path problem, not a send-path
 * one, and polling removes the entire class of it.
 */
export class TelegramPoller {
  private readonly key: string;
  private running = false;
  private loopPromise?: Promise<void>;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private statusInt: TelegramPollerStatus = {
    transport: "polling",
    running: false,
    updatesReceived: 0,
    consecutiveErrors: 0,
    resolvingConflict: false,
  };
  private conflictSince = 0;
  private conflictRetries = 0;

  constructor(private readonly deps: TelegramPollerDeps) {
    this.key = `telegram:poll-offset:${deps.name ?? "global"}`;
  }

  get connection(): TelegramConnection | undefined {
    return isTelegramConnection(this.deps.service) ? this.deps.service : undefined;
  }

  status(): TelegramPollerStatus {
    return { ...this.statusInt, running: this.running };
  }

  get available(): boolean {
    return !!this.connection;
  }

  start(): void {
    if (this.running) return;
    const conn = this.connection;
    if (!conn) {
      this.statusInt.note = "polling needs a real Telegram connection (mock service has no getUpdates)";
      this.deps.logger.warn("telegram poller not started — service has no getUpdates", { name: this.deps.name });
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.loop();
    this.deps.logger.info("telegram long-polling started", { name: this.deps.name });
  }

  /** Stop the loop and make sure the next `getUpdates` call is aborted too. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = undefined;
    this.statusInt = { ...this.statusInt, running: false };
    this.deps.logger.info("telegram long-polling stopped", { name: this.deps.name });
  }

  /** Forget the stored offset: the next cycle re-reads Telegram's queue. */
  resetOffset(): void {
    this.deps.state?.set(this.key, 0);
    this.statusInt.offset = 0;
  }

  /** Drain Telegram's backlog without replying to old messages (e.g. after downtime). */
  async skipPending(): Promise<number> {
    const conn = this.connection;
    if (!conn) return 0;
    const res = await conn.getUpdates({ timeoutSec: 0, limit: 100 });
    const max = this.maxUpdateId(res);
    if (max > 0) this.setOffset(max + 1);
    return res.updates.length;
  }

  /* ---------------------------------------------------------------- */

  private get offset(): number {
    const raw = this.deps.state?.get<number>(this.key);
    return Number.isFinite(raw) ? Number(raw) : 0;
  }

  private setOffset(offset: number): void {
    this.statusInt.offset = offset;
    try {
      this.deps.state?.set(this.key, offset);
    } catch {
      /* persistence is best-effort; never break the loop over a write failure */
    }
  }

  private maxUpdateId(res: TelegramUpdatesResult): number {
    return res.updates.reduce<number>((m, u) => {
      const id = Number((u as { update_id?: number })?.update_id ?? 0);
      return Number.isFinite(id) && id > m ? id : m;
    }, this.offset - 1 > 0 ? this.offset - 1 : 0);
  }

  private async clearBlockingWebhook(): Promise<void> {
    const conn = this.connection;
    if (!conn) return;
    this.statusInt.resolvingConflict = true;
    this.statusInt.note =
      "Telegram reports a conflict: either a webhook is still registered for this bot, or another instance is polling with the same token.";
    const res = await conn.deleteWebhook(false);
    this.statusInt.resolvingConflict = false;
    if (res.ok) {
      this.deps.logger.info("telegram webhook removed so polling can receive updates");
      this.statusInt.note = "Conflict cleared — blocking webhook removed, polling now receives updates.";
    } else {
      this.deps.logger.warn("telegram deleteWebhook failed", { error: res.error });
      this.statusInt.note = `Conflict detected and deleteWebhook failed: ${res.error}`;
    }
  }

  private async loop(): Promise<void> {
    const minBackoff = this.deps.minBackoffMs ?? 1500;
    const maxBackoff = this.deps.maxBackoffMs ?? 30_000;
    const allowed = this.deps.allowedUpdates ?? [...TELEGRAM_ALLOWED_UPDATES];
    // Give each cycle its own abort signal so stop() never leaves a request hanging.
    while (this.running) {
      const conn = this.connection;
      const abort = this.abort ?? new AbortController();
      this.abort = abort;
      if (!conn) return;
      let res: TelegramUpdatesResult;
      const startedAt = Date.now();
      try {
        res = await conn.getUpdates({
          offset: this.offset || undefined,
          timeoutSec: this.deps.timeoutSec,
          allowedUpdates: allowed,
          signal: abort.signal,
        });
      } catch (err) {
        res = { ok: false, updates: [], error: err instanceof Error ? err.message : String(err) };
      }
      if (!this.running) return;
      this.statusInt.lastPollAt = new Date().toISOString();

      if (res.ok) {
        this.statusInt.consecutiveErrors = 0;
        this.statusInt.note = undefined;
        for (const update of res.updates) {
          const id = Number((update as { update_id?: number })?.update_id ?? 0);
          try {
            await this.deps.onUpdate(update);
            this.statusInt.updatesReceived += 1;
            this.statusInt.lastUpdateAt = new Date().toISOString();
          } catch (err) {
            // One bad update must not stop the bot: log, advance, continue.
            this.deps.logger.error("telegram update handler failed", {
              name: this.deps.name,
              updateId: id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          if (id >= this.offset) this.setOffset(id + 1);
        }
        if (this.conflictSince) {
          this.conflictSince = 0;
          this.conflictRetries = 0;
        }
        // Real long polling blocks server-side until something arrives, so an
        // empty batch costs nothing. But when the call comes back immediately
        // with nothing (`timeoutSec: 0`, a catch-up drain, a proxy that answers
        // instantly) `continue` would spin the loop and hammer the Bot API into
        // a 429 — pace those cycles instead.
        if (res.updates.length === 0) {
          const holdMs = (this.deps.timeoutSec ?? 25) * 1000;
          if (Date.now() - startedAt < Math.max(1000, holdMs * 0.5)) {
            await sleep(Math.max(200, Math.floor(minBackoff / 2)), this.abort?.signal);
          }
        }
        continue; // non-empty batches are handled immediately, no extra sleep
      }

      if (abort.signal.aborted || res.error === "aborted") return;

      this.statusInt.consecutiveErrors += 1;
      this.statusInt.lastError = res.error;
      this.statusInt.lastErrorAt = new Date().toISOString();

      // 409 Conflict: a webhook is registered (getUpdates is then disabled) or
      // another replica is polling. Try to clear the webhook, with backoff so a
      // multi-replica deployment doesn't thrash setWebhook/deleteWebhook forever.
      if (res.errorCode === 409 || /conflict/i.test(res.error ?? "")) {
        const now = Date.now();
        if (!this.conflictSince) this.conflictSince = now;
        this.conflictRetries += 1;
        const inBackoff = now - this.conflictSince < 60_000;
        if (!inBackoff || this.conflictRetries % 5 === 1) {
          await this.clearBlockingWebhook();
        }
        const backoff = Math.min(maxBackoff, minBackoff * 2 ** Math.min(4, this.conflictRetries));
        this.deps.logger.warn("telegram getUpdates conflict — retrying", {
          name: this.deps.name,
          error: res.error,
          retryInMs: backoff,
        });
        await sleep(backoff, this.abort?.signal);
        continue;
      }

      if (res.errorCode === 401 || /unauthorized/i.test(res.error ?? "")) {
        this.statusInt.note = "Telegram rejected the bot token (401) — re-check TELEGRAM_BOT_TOKEN / reconnect the account.";
        await sleep(Math.min(maxBackoff, 15_000), this.abort?.signal);
        continue;
      }

      const retryAfter = res.retryAfterSec != null ? res.retryAfterSec * 1000 : undefined;
      const backoff = retryAfter ?? Math.min(maxBackoff, minBackoff * 2 ** Math.min(5, this.statusInt.consecutiveErrors));
      this.deps.logger.warn("telegram getUpdates failed — backing off", {
        name: this.deps.name,
        error: res.error,
        retryInMs: backoff,
      });
      await sleep(backoff, this.abort?.signal);
    }
  }
}
