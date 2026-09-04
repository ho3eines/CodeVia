import type { ITelegramService, TelegramWebhookInfo } from "./telegram.js";
import {
  isTelegramUnreachable,
  getTelegramWebhookPath,
  getPublicBaseUrl,
  isTelegramConnection,
  learnPublicBaseUrl,
  telegramWebhookFixHints,
  validateTelegramWebhookUrl,
} from "./telegram.js";
import { TelegramPoller, type TelegramPollerStatus, type TelegramPollStateStore } from "./telegram-poller.js";

/** Loopback check for a full URL (Telegram can never deliver to it). */
function isLocalHostUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h.startsWith("127.") || h.endsWith(".local");
  } catch {
    return true;
  }
}
import type { TelegramBot } from "./telegram-bot.js";
import type { TelegramAccount } from "../domain/telegram.js";
import { accountTelegramService } from "./telegram.js";
import type { Logger } from "../logger.js";

export type TelegramMode = "auto" | "webhook" | "polling" | "off";
export type TelegramTransport = "webhook" | "polling" | "off";

export interface TelegramRuntimeStatus {
  enabled: boolean;
  /** A token is configured (may still be rejected by Telegram — see `tokenProblem`). */
  configured: boolean;
  /** The bot is actually alive: a receive path is running and Telegram accepted us. */
  ready: boolean;
  mode: TelegramMode;
  transport: TelegramTransport;
  mock: boolean;
  hasToken: boolean;
  tokenProblem?: string;
  botUsername?: string;
  botId?: string;
  baseUrl?: string;
  webhookUrl?: string;
  webhookSet: boolean;
  webhookError?: string;
  webhookInfo?: TelegramWebhookInfo;
  polling?: TelegramPollerStatus;
  accountPolling?: Record<string, TelegramPollerStatus>;
  lastCheckedAt?: string;
  fixes: string[];
  note?: string;
}

export interface TelegramTestStep {
  name: string;
  label: string;
  /** "pass" | "fail" | "skip" — skip means "not applicable here", not broken. */
  status: "pass" | "fail" | "skip";
  detail?: string;
  /** What the operator must actually do, when the step is not a pass. */
  action?: string;
}

export interface TelegramConnectionTest {
  steps: TelegramTestStep[];
  verdict: "ready" | "blocked" | "degraded";
  summary: string;
  transport: TelegramTransport;
  mode: TelegramMode;
}

export interface TelegramRuntimeDeps {
  telegram: ITelegramService;
  /** Builds a bot bound to a specific service (global token or a user's token). */
  createBot: (service: ITelegramService) => TelegramBot;
  telegramAccountRepo: {
    findMany(): Array<{ data: TelegramAccount }>;
    upsert(account: TelegramAccount): unknown;
  };
  state?: TelegramPollStateStore;
  logger: Logger;
  mode?: TelegramMode;
  pollTimeoutSec?: number;
  webhookSecret?: string;
}

/**
 * Owns *how* the platform receives Telegram updates — the part that decides
 * whether a bot is alive or silent:
 *
 *   • webhook  — register `setWebhook` and let Telegram push updates to us;
 *   • polling  — long-poll `getUpdates` (needs only a token: no public HTTPS
 *                host, no tunnel, nothing for Telegram to reach);
 *   • auto     — webhook when a public HTTPS URL is actually usable, polling
 *                otherwise. This is the default, so a fresh bot token is enough.
 *
 * Per-user bot accounts get their own poller when their webhook cannot be
 * registered, so a user who connects a bot from the UI is never stuck on the
 * "I have no server to point Telegram at" problem.
 */
export class TelegramRuntime {
  private poller?: TelegramPoller;
  private readonly accountPollers = new Map<string, TelegramPoller>();
  private currentMode: TelegramMode;
  private transport: TelegramTransport = "off";
  private webhookUrl?: string;
  private webhookError?: string;
  private webhookInfo?: TelegramWebhookInfo;
  private registeredWebhookUrl?: string;
  private botUsername?: string;
  private botId?: string;
  private lastCheckedAt?: string;
  private note?: string;
  /** Why we ended up on polling instead of the webhook (kept until it changes). */
  private fallbackReason?: string;
  private started = false;
  private signature = "";

  constructor(private readonly deps: TelegramRuntimeDeps) {
    this.currentMode = deps.mode ?? "auto";
  }

  get mode(): TelegramMode {
    return this.currentMode;
  }

  get service(): ITelegramService {
    return this.deps.telegram;
  }

  private get connection() {
    return isTelegramConnection(this.deps.telegram) ? this.deps.telegram : undefined;
  }

  /** Base URL Telegram would reach us on (explicit config > learned from requests). */
  resolveBaseUrl(host?: string, proto?: string): string {
    const base = getPublicBaseUrl(host, proto).replace(/\/$/, "");
    learnPublicBaseUrl(base);
    return base;
  }

  webhookUrlFor(base: string): string {
    return `${base}${getTelegramWebhookPath()}`;
  }

  /**
   * Decide the transport and bring it up. Safe to call repeatedly: the webhook
   * is only re-registered when the URL actually changed, and the poller is
   * idempotent, so a request-time "heal" call costs nothing when all is well.
   */
  async start(baseOverride?: string): Promise<TelegramRuntimeStatus> {
    const conn = this.connection;
    // The UI polls /integrations/telegram/status; re-running getMe + webhook
    // registration on every poll wastes Telegram API calls (and 429s are a real
    // risk), so an unchanged, healthy configuration short-circuits here.
    const probeBase = baseOverride ?? (conn ? this.resolveBaseUrl() : undefined);
    const probeUrl = probeBase ? this.webhookUrlFor(probeBase) : undefined;
    const signature = [this.currentMode, probeUrl ?? "", conn?.tokenProblem ?? ""].join("|");
    if (conn && this.started && signature === this.signature) {
      const healthy =
        this.transport === "polling" ? !!this.poller?.status().running
        : this.transport === "webhook" ? this.registeredWebhookUrl === probeUrl
        : false;
      if (healthy) return this.status();
    }
    if (!conn) {
      this.transport = "off";
      this.note = this.deps.telegram.constructor.name === "MockTelegramService"
        ? "mock Telegram mode — messages are logged, not sent. Set TELEGRAM_BOT_TOKEN for a real bot."
        : "no Telegram service configured";
      this.started = true;
      return this.status();
    }
    this.started = true;
    this.note = undefined;

    // Verify the token once so the status UI can tell "bad token" from "no route".
    const me = await conn.getMe();
    if (me.ok && me.result) {
      this.botUsername = me.result.username;
      this.botId = me.result.id != null ? String(me.result.id) : undefined;
      this.webhookError = undefined;
    } else {
      this.webhookError = me.error;
      this.note = isTelegramUnreachable(me.error)
        ? "This server cannot reach api.telegram.org (outbound HTTPS is blocked), so neither webhook nor polling can work here."
        : "Telegram rejected the bot token — check TELEGRAM_BOT_TOKEN (or reconnect the account).";
      this.transport = "off";
      this.signature = "";
      // A token Telegram rejects must not keep hammering getUpdates: the poller
      // would spin forever on 401 and `ready` would stay true on a deaf bot.
      // (Blocked egress is different — keep the poller so it self-heals.)
      if (!isTelegramUnreachable(me.error)) await this.stopPolling().catch(() => undefined);
      this.lastCheckedAt = new Date().toISOString();
      return this.status();
    }
    this.lastCheckedAt = new Date().toISOString();

    const base = baseOverride ?? this.resolveBaseUrl();
    const url = this.webhookUrlFor(base);
    const urlValid = validateTelegramWebhookUrl(url).ok;
    const mode = this.currentMode;

    if (mode === "off") {
      await this.stopPolling();
      this.signature = signature;
      this.transport = "off";
      this.note = "Telegram receiving is disabled (TELEGRAM_MODE=off). Sending notifications still works.";
      return this.status();
    }

    if (mode === "polling") {
      await this.usePolling(true);
      this.signature = signature;
      return this.status();
    }

    if (mode === "webhook") {
      if (!urlValid) {
        this.transport = "webhook";
        this.webhookError = validateTelegramWebhookUrl(url).error;
        this.webhookSet(false);
        this.signature = "";
        this.note = "TELEGRAM_MODE=webhook requires a public HTTPS URL — set PUBLIC_WEB_BASE_URL / TELEGRAM_WEBHOOK_URL, or switch TELEGRAM_MODE to auto/polling.";
        return this.status();
      }
      await this.registerWebhook(url);
      return this.status();
    }

    // auto: webhook when we have a URL Telegram can actually reach, else polling.
    if (!urlValid) {
      this.note = "No public HTTPS URL is configured — the bot falls back to long polling, so it works without a tunnel.";
      await this.usePolling(true);
      this.signature = signature;
      return this.status();
    }
    const res = await this.registerWebhook(url);
    if (!res.ok) {
      this.note = `setWebhook failed (${res.error}) — falling back to long polling so the bot still receives messages.`;
      await this.usePolling(true);
    }
    this.signature = signature;
    return this.status();
  }

  /** Change the transport at runtime (UI toggle / API) and bring it back up. */
  async setMode(mode: TelegramMode, baseOverride?: string): Promise<TelegramRuntimeStatus> {
    this.currentMode = mode;
    if (mode === "off" || mode === "webhook") await this.stopPolling();
    return this.start(baseOverride);
  }

  /** Register/refresh the global webhook (idempotent per URL). */
  async registerWebhook(url: string): Promise<{ ok: boolean; error?: string }> {
    const conn = this.connection;
    if (!conn) return { ok: false, error: "mock Telegram service cannot register a webhook" };
    const valid = validateTelegramWebhookUrl(url);
    this.webhookUrl = url;
    if (!valid.ok) {
      this.webhookError = valid.error;
      this.webhookSet(false);
      return { ok: false, error: valid.error };
    }
    if (this.registeredWebhookUrl === url && this.transport === "webhook") {
      return { ok: true };
    }
    const res = await conn.setWebhook(url, { secretToken: this.deps.webhookSecret });
    if (!res.ok) this.fallbackReason = res.error;
    if (res.ok) {
      this.registeredWebhookUrl = url;
      this.webhookError = undefined;
      this.fallbackReason = undefined;
      this.note = undefined;
      this.transport = "webhook";
      await this.stopPolling();
      this.deps.logger.info("Telegram webhook registered", { url });
      return { ok: true };
    }
    this.webhookError = res.error;
    this.webhookSet(false);
    this.deps.logger.warn("Telegram webhook registration failed", { url, error: res.error });
    return { ok: false, error: res.error };
  }

  /**
   * Switch the global bot to long polling. `dropWebhook` removes an existing
   * registration — Telegram refuses `getUpdates` while a webhook is set, so a
   * stale/broken webhook is itself a common cause of a silent bot.
   */
  /**
   * Switch the global bot to long polling. If Telegram still has a webhook
   * registered it must go first — `getUpdates` returns 409 while one exists,
   * which is itself a common cause of a bot that "ignores" everyone.
   */
  async usePolling(dropWebhook = true): Promise<TelegramRuntimeStatus> {
    // Explicit polling is a choice, not a fallback — nothing to explain.
    if (this.currentMode === "polling") this.fallbackReason = undefined;
    const conn = this.connection;
    this.transport = "polling";
    if (conn && dropWebhook) {
      const info = await conn.getWebhookInfo();
      if (info.url) {
        const del = await conn.deleteWebhook(false);
        if (del.ok) {
          this.registeredWebhookUrl = undefined;
          this.webhookInfo = { url: undefined, empty: true };
          this.webhookError = undefined;
          this.deps.logger.info("removed the registered Telegram webhook so long polling could take over");
        } else if (del.error && del.error !== "aborted") {
          this.webhookError = del.error;
        }
      } else {
        this.webhookInfo = { ...info, empty: true };
      }
    }
    this.ensurePoller();
    return this.status();
  }

  private ensurePoller(): TelegramPoller | undefined {
    const conn = this.connection;
    if (!conn) return undefined;
    if (!this.poller) {
      const bot = this.deps.createBot(this.deps.telegram);
      this.poller = new TelegramPoller({
        name: "global",
        service: this.deps.telegram,
        onUpdate: async (update) => {
          await bot.handle(update);
        },
        logger: this.deps.logger.child({ component: "telegram-poller" }),
        state: this.deps.state,
        timeoutSec: this.deps.pollTimeoutSec,
        deleteWebhookOnStart: true,
      });
    }
    this.poller.start();
    return this.poller;
  }

  private async stopPolling(): Promise<void> {
    await this.poller?.stop();
    for (const p of this.accountPollers.values()) await p.stop();
    this.accountPollers.clear();
  }

  /* ---------------- per-user bot accounts ---------------- */

  /**
   * Start long polling for a user-connected bot. Used when the account's
   * webhook cannot be registered (no public HTTPS URL, dev laptop, preview
   * host) so the user's own bot still receives messages.
   */
  async startAccountPolling(account: TelegramAccount): Promise<TelegramPollerStatus | undefined> {
    const service = accountTelegramService(account);
    if (!isTelegramConnection(service)) return undefined;
    const existing = this.accountPollers.get(account.id);
    if (existing) {
      await existing.stop();
    }
    const bot = this.deps.createBot(service);
    const poller = new TelegramPoller({
      name: `account:${account.id}`,
      service,
      onUpdate: async (update) => {
        await bot.handle(update);
      },
      logger: this.deps.logger.child({ component: "telegram-poller", telegramAccount: account.id }),
      state: this.deps.state,
      timeoutSec: this.deps.pollTimeoutSec,
      deleteWebhookOnStart: true,
    });
    poller.start();
    this.accountPollers.set(account.id, poller);
    return poller.status();
  }

  async stopAccountPolling(accountId: string): Promise<void> {
    const p = this.accountPollers.get(accountId);
    if (!p) return;
    await p.stop();
    this.accountPollers.delete(accountId);
  }

  /** Keep pollers in sync with the accounts that currently want polling. */
  async syncAccountPollers(): Promise<void> {
    const accounts = this.deps.telegramAccountRepo.findMany().map((r) => r.data);
    const wanted = new Set(accounts.filter((a) => a.transport === "polling" && a.connected).map((a) => a.id));
    for (const [id, poller] of [...this.accountPollers.entries()]) {
      if (!wanted.has(id)) {
        await poller.stop();
        this.accountPollers.delete(id);
      }
    }
    for (const account of accounts) {
      if (!wanted.has(account.id)) continue;
      const poller = this.accountPollers.get(account.id);
      if (poller && !poller.status().running) this.accountPollers.delete(account.id);
      if (!this.accountPollers.has(account.id)) await this.startAccountPolling(account);
    }
  }

  /* ---------------- diagnostics ---------------- */

  /** Live round-trip with Telegram: token, webhook registration, polling state. */
  async diagnostics(force = false): Promise<TelegramRuntimeStatus> {
    const conn = this.connection;
    if (!conn) return this.status();
    const me = await conn.getMe();
    if (me.ok && me.result) {
      this.botUsername = me.result.username;
      this.botId = me.result.id != null ? String(me.result.id) : undefined;
      this.webhookError = undefined;
    } else {
      this.webhookError = me.error;
    }
    if (this.transport !== "polling" || force) {
      this.webhookInfo = await conn.getWebhookInfo();
    } else {
      this.webhookInfo = { ...(this.webhookInfo ?? {}), empty: true, url: undefined };
    }
    this.lastCheckedAt = new Date().toISOString();
    return this.status();
  }

  private webhookSet(ok: boolean): void {
    this.transport = ok ? "webhook" : this.transport;
    if (ok) this.registeredWebhookUrl = this.webhookUrl;
  }

  /**
   * End-to-end "is my bot wired up correctly" check, in the order things
   * actually break: token → outbound network → webhook registration → our own
   * endpoint being reachable and answering 200 → a transport that is running.
   * Each failing step carries the one action that fixes it, so the answer to
   * "the webhook has an error" is a specific instruction, not a guess.
   */
  async connectionTest(): Promise<TelegramConnectionTest> {
    const steps: TelegramTestStep[] = [];
    const conn = this.connection;
    const push = (step: TelegramTestStep) => steps.push(step);

    if (!conn) {
      push({
        name: "token",
        label: "Bot token",
        status: "fail",
        detail: "The platform is running the mock Telegram service.",
        action: "Set TELEGRAM_BOT_TOKEN (from @BotFather), or connect a bot in the UI, then restart.",
      });
      return { steps, verdict: "blocked", summary: "No real Telegram connection is configured.", transport: this.transport, mode: this.currentMode };
    }

    const me = await conn.getMe();
    const networkish = /network error|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(me.error ?? "");
    push({
      name: "token",
      label: "Bot token is accepted by Telegram",
      status: me.ok ? "pass" : "fail",
      detail: me.ok ? `@${me.result?.username ?? "?"} (id ${me.result?.id ?? "?"})` : me.error,
      action: me.ok
        ? undefined
        : networkish
          ? undefined // the egress step below carries the real instruction
          : "Copy a fresh token from @BotFather (/token) and set TELEGRAM_BOT_TOKEN — it changes when you run /revoke.",
    });
    push({
      name: "egress",
      label: "This server can reach api.telegram.org",
      status: me.ok ? "pass" : networkish ? "fail" : "pass",
      detail: networkish ? me.error : "outbound HTTPS to Telegram works",
      action: networkish
        ? "This host cannot reach api.telegram.org over HTTPS. Allow egress to that host (port 443), or run CodeVia somewhere with internet access (Railway, your laptop, a VPS). No webhook or polling setting can work around a blocked network — this is why a bot looks 'broken' in a sandbox."
        : undefined,
    });

    const info = await conn.getWebhookInfo();
    this.webhookInfo = info;
    const expected = this.webhookUrl ?? (this.started ? this.webhookUrlFor(this.resolveBaseUrl()) : undefined);
    if (isTelegramUnreachable(info.lastError)) {
      push({
        name: "webhook",
        label: "Telegram can deliver to the webhook",
        status: "skip",
        detail: `Telegram's webhook state could not be read (${info.lastError}).`,
        action: "Blocked outbound HTTPS — resolve the egress step first; this check is inconclusive until then.",
      });
    } else if (info.lastError) {
      push({
        name: "webhook",
        label: "Telegram can deliver to the webhook",
        status: "fail",
        detail: `${info.url ?? "(no url)"} — ${info.lastError}${info.pendingUpdateCount ? ` (${info.pendingUpdateCount} update(s) queued)` : ""}`,
        action: /HTTPS URL must be provided/i.test(info.lastError ?? "")
          ? "Telegram requires a public HTTPS webhook. Set PUBLIC_WEB_BASE_URL=https://<your-app>.up.railway.app (or TELEGRAM_WEBHOOK_URL), or just switch to long polling."
          : "Telegram cannot reach that URL. Check the app is publicly exposed (health endpoint answers from outside), that the path is not behind auth, and that the replica receiving traffic is this one — or switch to long polling.",
      });
    } else if (info.url && expected && info.url !== expected) {
      push({
        name: "webhook",
        label: "Registered webhook points at this deployment",
        status: "fail",
        detail: `Telegram is posting to ${info.url}, this instance expects ${expected}.`,
        action: "Two environments share one bot token. Give each its own bot, or press “Re-register webhook” here to point it at this deployment.",
      });
    } else if (info.url) {
      push({ name: "webhook", label: "Registered webhook points at this deployment", status: "pass", detail: info.url });
    } else {
      push({
        name: "webhook",
        label: "Webhook registration",
        status: this.transport === "polling" ? "skip" : "fail",
        detail: this.transport === "polling"
          ? "No webhook — not needed while long polling is active."
          : "Telegram has no webhook for this bot and polling is not running.",
        action: this.transport === "polling"
          ? undefined
          : `Press 🔗 Use webhook (registers ${expected ?? "the public URL"}) or 📡 Use long polling.`,
      });
    }

    // Probe our own webhook endpoint: proves the route exists, is public and
    // answers 200 (a non-2xx makes Telegram stop delivering and eventually drop
    // the webhook — the classic "connected but silent").
    const probeUrl = expected;
    if (!probeUrl || isLocalHostUrl(probeUrl)) {
      push({
        name: "endpoint",
        label: "Webhook endpoint answers 200",
        status: "skip",
        detail: probeUrl ? `${probeUrl} is a loopback URL — Telegram cannot post to it, so it was not probed.` : "no public URL to probe",
        action: "Set PUBLIC_WEB_BASE_URL to the public HTTPS URL of this deployment to enable this check — or use long polling.",
      });
    } else {
      try {
        const probe = await fetch(probeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.deps.webhookSecret ? { "X-Telegram-Bot-Api-Secret-Token": this.deps.webhookSecret } : {}),
          },
          // A payload with no text/callback is parsed and ignored by the handler.
          body: JSON.stringify({ update_id: 0, message: { chat: { id: 0 }, from: { id: 0 } } }),
          signal: AbortSignal.timeout(8000),
        });
        push({
          name: "endpoint",
          label: "Webhook endpoint answers 200",
          status: probe.ok ? "pass" : "fail",
          detail: `${probeUrl} → HTTP ${probe.status}`,
          action: probe.ok
            ? undefined
            : `The endpoint answered ${probe.status}. It must always answer 200: check the path is in the public allowlist, that no proxy/auth sits in front of it, and that REQUIRE_AUTH is not gating /integrations/telegram/webhook.`,
        });
      } catch (err) {
        push({
          name: "endpoint",
          label: "Webhook endpoint answers 200",
          status: "fail",
          detail: `self-request failed: ${err instanceof Error ? err.message : String(err)}`,
          action: "This server cannot reach its own public URL (DNS/ingress/redirect). Fix the public route, or use long polling.",
        });
      }
    }

    const polling = this.poller?.status();
    push({
      name: "transport",
      label: "A receive path is running",
      status: this.transport === "webhook" ? "pass" : this.transport === "polling" ? (polling?.running ? "pass" : "fail") : "fail",
      detail: this.transport === "polling"
        ? `long polling ${polling?.running ? `running — ${polling.updatesReceived} update(s) read, offset ${polling.offset ?? 0}` : "NOT running"}${polling?.lastError ? ` · last error: ${polling.lastError}` : ""}`
        : this.transport === "webhook"
          ? "webhook registered"
          : "nothing is receiving updates",
      action: this.transport === "off" ? 'Press 📡 Use long polling (works with only a token), or POST /integrations/telegram/transport {"mode":"auto"}.' : polling?.resolvingConflict ? "Polling is fighting a webhook/second instance for the same token — keep exactly one receiver." : undefined,
    });

    const fails = steps.filter((st) => st.status === "fail");
    const blocked = fails.some((st) => st.name === "token" || st.name === "egress");
    return {
      steps,
      verdict: blocked ? "blocked" : fails.length ? "degraded" : "ready",
      summary: blocked
        ? "Telegram itself is unreachable or the token is rejected — fix that first, nothing else can work."
        : fails.length === 0
          ? "The bot is wired up: token valid and a receive path is running."
          : `${fails.length} step(s) need attention — see the actions below.`,
      transport: this.transport,
      mode: this.currentMode,
    };
  }

  /**
   * Drain the backlog Telegram has queued for us, without answering it. Useful
   * after downtime, when replaying hours of old messages would be noise.
   */
  async skipPendingUpdates(): Promise<number | undefined> {
    if (!this.poller) return undefined;
    let total = 0;
    for (let i = 0; i < 20; i += 1) {
      const n = await this.poller.skipPending();
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  async stop(): Promise<void> {
    await this.stopPolling();
    this.started = false;
  }

  status(): TelegramRuntimeStatus {
    const conn = this.connection;
    const tokenProblem = conn?.tokenProblem;
    const base = conn ? this.resolveBaseUrl() : undefined;
    const webhookUrl = this.webhookUrl ?? (base ? this.webhookUrlFor(base) : undefined);
    const accountPolling: Record<string, TelegramPollerStatus> = {};
    for (const [id, p] of this.accountPollers) accountPolling[id] = p.status();
    const fixes: string[] = [];
    if (tokenProblem) fixes.push(`Bot token: ${tokenProblem}.`);
    // `ENABLE_TELEGRAM=false` used to be the kill switch for *receiving*, which
    // meant a perfectly good token produced a deaf bot. A token now means "the
    // user wants a bot"; say so instead of silently honouring the old flag.
    const rawEnableFlag = String(process.env.ENABLE_TELEGRAM ?? "").trim().toLowerCase();
    if (["false", "0", "no", "off"].includes(rawEnableFlag) && conn) {
      fixes.push('ENABLE_TELEGRAM is false but a token is set, so the bot still runs (that flag no longer gates receiving). Use TELEGRAM_MODE=off to silence it.');
    }
    if (this.webhookError) fixes.push(`Telegram: ${this.webhookError}`);
    if (this.transport === "polling" && this.fallbackReason) {
      fixes.push(`Webhook not usable (${this.fallbackReason}) — the bot receives updates by long polling instead, which needs no public URL.`);
    }
    const polling = this.poller?.status();
    if (polling?.lastError) fixes.push(`Polling error: ${polling.lastError}`);
    fixes.push(...telegramWebhookFixHints(this.webhookInfo, this.transport));
    // Only nag when a real bot is configured and *still* nothing is arriving —
    // in mock/off mode the note already explains the situation.
    const optedOut = this.currentMode === "off";
    if (this.transport === "off" && this.started && conn && !tokenProblem && fixes.length === 0 && !optedOut) {
      fixes.push('Nothing is receiving updates — run POST /integrations/telegram/transport {"mode":"auto"} or press “Use polling”.');
    }
    // `ready` answers "is my bot alive?" — a transport is running *and* Telegram
    // accepted our last call. `enabled` only means "not turned off", which used to
    // let a rejected token or a half-registered webhook look healthy in the UI.
    const pollingRunning = Boolean(this.poller?.status().running);
    const webhookLive = this.transport === "webhook"
      && Boolean(this.registeredWebhookUrl)
      && !this.webhookError
      && !tokenProblem;
    const ready = this.currentMode !== "off" && !!conn && !tokenProblem && (pollingRunning || webhookLive);
    return {
      enabled: !!conn && !tokenProblem,
      configured: !!conn,
      ready,
      mode: this.currentMode,
      transport: this.transport,
      mock: !conn,
      hasToken: !!conn?.token,
      tokenProblem,
      botUsername: this.botUsername,
      botId: this.botId,
      baseUrl: base,
      webhookUrl,
      webhookSet: this.transport === "webhook" && !!this.registeredWebhookUrl,
      webhookError: this.webhookError,
      webhookInfo: this.webhookInfo,
      polling,
      accountPolling: Object.keys(accountPolling).length ? accountPolling : undefined,
      lastCheckedAt: this.lastCheckedAt,
      fixes,
      note: this.note ?? (this.started ? undefined : "telegram runtime not started yet"),
    };
  }
}
