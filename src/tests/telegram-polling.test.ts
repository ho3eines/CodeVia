import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { TelegramPoller } from "../integrations/telegram-poller.js";
import {
  MockTelegramService,
  TelegramBotApiService,
  escapeHtml,
  normalizeTelegramUpdate,
  toTelegramHtml,
  verifyTelegramWebhookSecret,
  clampTelegramText,
  type TelegramUpdatesResult,
} from "../integrations/telegram.js";
import { logger } from "../logger.js";

const NOOP_LOGGER = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => NOOP_LOGGER,
} as unknown as typeof logger;

function fakeStore(): { data: Record<string, unknown>; get<T>(k: string): T | undefined; set(k: string, v: unknown): void } {
  const data: Record<string, unknown> = {};
  return { data, get: <T,>(k: string) => data[k] as T | undefined, set: (k, v) => { data[k] = v; } };
}

/** A minimal polling-capable service driven by scripted getUpdates results. */
function fakePollingService(script: Array<TelegramUpdatesResult | Error>) {
  const calls: Array<{ offset?: number }> = [];
  const deleted: boolean[] = [];
  let i = 0;
  const service = {
    kind: "telegram",
    token: "123:token",
    configured: true,
    get tokenProblem() {
      return undefined;
    },
    calls,
    deleted,
    getUpdates: async (params: { offset?: number } = {}) => {
      calls.push({ offset: params.offset });
      const next = script[i];
      i += 1;
      // Past the script: an idle long-poll (no updates) — never repeat the last
      // scripted batch, or the loop becomes a hot spin in tests.
      if (!next) return { ok: true, updates: [] };
      if (next instanceof Error) throw next;
      return next;
    },
    deleteWebhook: async () => {
      deleted.push(true);
      return { ok: true };
    },
    setWebhook: async () => ({ ok: true }),
    getWebhookInfo: async () => ({ empty: true }),
    getMe: async () => ({ ok: true, result: { id: 1, username: "fake_bot" } }),
  };
  return service as unknown as MockTelegramService & typeof service;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TelegramPoller (long-polling receive path)", () => {
  it("delivers updates and advances the offset past the last handled update_id", async () => {
    const service = fakePollingService([
      { ok: true, updates: [{ update_id: 41, message: { chat: { id: 7 } } }] },
      { ok: true, updates: [{ update_id: 42, message: { chat: { id: 7 } } }] },
      { ok: true, updates: [] },
    ]);
    const seen: number[] = [];
    const state = fakeStore();
    const poller = new TelegramPoller({
      name: "test",
      service,
      state,
      logger: NOOP_LOGGER,
      timeoutSec: 0,
      minBackoffMs: 5,
      onUpdate: async (u) => {
        seen.push((u as { update_id: number }).update_id);
      },
    });
    poller.start();
    for (let i = 0; i < 50 && seen.length < 2; i += 1) await wait(10);
    expect(seen).toEqual([41, 42]);
    expect(state.data["telegram:poll-offset:test"]).toBe(43);
    // The next poll must ask Telegram for updates *after* 42.
    expect(service.calls.some((c) => c.offset === 43)).toBe(true);
    await poller.stop();
    expect(poller.status().running).toBe(false);
  });

  it("resumes from the stored offset after a restart (no replay, no lost updates)", async () => {
    const state = fakeStore();
    state.data["telegram:poll-offset:test"] = 100;
    const service = fakePollingService([{ ok: true, updates: [] }]);
    const poller = new TelegramPoller({
      name: "test",
      service,
      state,
      logger: NOOP_LOGGER,
      timeoutSec: 0,
      minBackoffMs: 5,
      onUpdate: async () => undefined,
    });
    poller.start();
    await wait(30);
    expect(service.calls[0]?.offset).toBe(100);
    await poller.stop();
  });

  it("clears a blocking webhook when Telegram answers 409 Conflict", async () => {
    const service = fakePollingService([
      { ok: false, updates: [], errorCode: 409, error: "Conflict: can't use getUpdates method while webhook is active" },
      { ok: true, updates: [{ update_id: 3, message: { chat: { id: 1 } } }] },
    ]);
    let handled = 0;
    const poller = new TelegramPoller({
      name: "conflict",
      service,
      logger: NOOP_LOGGER,
      timeoutSec: 0,
      minBackoffMs: 5,
      onUpdate: async () => {
        handled += 1;
      },
    });
    poller.start();
    let sawConflictNote = false;
    for (let i = 0; i < 80 && (service.deleted.length === 0 || !sawConflictNote); i += 1) {
      if (poller.status().running && /conflict/i.test(poller.status().note ?? "")) sawConflictNote = true;
      await wait(5);
    }
    expect(service.deleted.length).toBeGreaterThan(0);
    expect(sawConflictNote).toBe(true);
    // ...and once the webhook is gone the updates are consumed normally.
    for (let i = 0; i < 80 && handled === 0; i += 1) await wait(5);
    expect(handled).toBe(1);
    await poller.stop();
  });

  it("keeps the loop alive across network failures with a backoff", async () => {
    const service = fakePollingService([
      Object.assign(new Error("ECONNRESET"), { name: "TypeError" }),
      { ok: true, updates: [{ update_id: 9, message: { chat: { id: 1 } } }] },
    ]);
    let handled = 0;
    const poller = new TelegramPoller({
      name: "flaky",
      service,
      logger: NOOP_LOGGER,
      timeoutSec: 0,
      minBackoffMs: 5,
      maxBackoffMs: 20,
      onUpdate: async () => {
        handled += 1;
      },
    });
    poller.start();
    for (let i = 0; i < 60 && handled === 0; i += 1) await wait(10);
    expect(handled).toBe(1);
    expect(poller.status().consecutiveErrors).toBe(0);
    await poller.stop();
  });

  it("surfaces a handler error without stopping the loop", async () => {
    const service = fakePollingService([
      { ok: true, updates: [{ update_id: 11, message: { chat: { id: 1 } } }] },
      { ok: true, updates: [{ update_id: 12, message: { chat: { id: 1 } } }] },
    ]);
    const seen: number[] = [];
    const poller = new TelegramPoller({
      name: "throws",
      service,
      logger: NOOP_LOGGER,
      timeoutSec: 0,
      minBackoffMs: 5,
      onUpdate: async (u) => {
        const id = (u as { update_id: number }).update_id;
        seen.push(id);
        if (id === 11) throw new Error("boom");
      },
    });
    poller.start();
    for (let i = 0; i < 60 && seen.length < 2; i += 1) await wait(10);
    expect(seen).toEqual([11, 12]);
    await poller.stop();
  });
});

describe("TelegramBotApiService (Bot API client)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("refuses to call the API without a token and reports the reason", async () => {
    const svc = new TelegramBotApiService("");
    const res = await svc.call("getMe");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no bot token/);
    expect(await svc.health()).toBe(false);
  });

  it("sends HTML parse_mode so *bold* renders instead of leaking asterisks", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof fetch;
    const svc = new TelegramBotApiService("123456:ABC-DEF_token_value");
    await svc.sendMessage({ chatId: "1", text: "🤖 *CodeVia* — `ok`" });
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toBe("🤖 <b>CodeVia</b> — <code>ok</code>");
  });

  it("escapes user text so HTML cannot break the message", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof fetch;
    const svc = new TelegramBotApiService("123456:ABC-DEF_token_value");
    await svc.sendMessage({ chatId: "1", text: "<script>alert(1)</script>" });
    expect(body.text).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("keeps the Telegram failure reason (403 = blocked bot) for diagnostics", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }),
        { status: 403 },
      )) as typeof fetch;
    const svc = new TelegramBotApiService("123456:ABC-DEF_token_value");
    const ok = await svc.sendMessage({ chatId: "1", text: "hi" });
    expect(ok).toBe(false);
    expect(svc.lastError).toMatch(/blocked/);
    expect(svc.lastErrorCode).toBe(403);
  });

  it("passes allowed_updates when registering the webhook and honours the secret", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof fetch;
    const svc = new TelegramBotApiService("123456:ABC-DEF_token_value");
    const res = await svc.setWebhook("https://app.example.com/integrations/telegram/webhook", { secretToken: "s3cr3t" });
    expect(res.ok).toBe(true);
    expect(body.secret_token).toBe("s3cr3t");
    expect(body.allowed_updates).toContain("callback_query");
  });

  it("getUpdates returns the parsed update list and forwards the offset", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
      url = String(u);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: [{ update_id: 77 }] }), { status: 200 });
    }) as typeof fetch;
    const svc = new TelegramBotApiService("123456:ABC-DEF_token_value");
    const res = await svc.getUpdates({ offset: 76, timeoutSec: 0 });
    expect(res.ok).toBe(true);
    expect(res.updates).toHaveLength(1);
    expect(body.offset).toBe(76);
    expect(url).toMatch(/\/getUpdates$/);
  });
});

describe("Telegram update normalization", () => {
  it("reads the chat from a callback_query's message (inline buttons)", () => {
    const t = normalizeTelegramUpdate({
      update_id: 1,
      callback_query: { id: "cb", data: "menu:home", from: { id: 9 }, message: { chat: { id: 42, type: "private" }, message_id: 5 } },
    });
    expect(t?.chatId).toBe("42");
    expect(t?.messageId).toBe(5);
    expect(t?.callbackId).toBe("cb");
    expect(t?.chatType).toBe("private");
  });

  it("handles edited messages and ignores service chatter", () => {
    expect(normalizeTelegramUpdate({ update_id: 2, edited_message: { chat: { id: 5 }, from: { id: 5 }, text: "/status" } })?.text).toBe("/status");
    expect(normalizeTelegramUpdate({ update_id: 3, message: { chat: { id: 5 }, from: { id: 5 }, new_chat_member: { id: 7 } } })).toBeUndefined();
  });

  it("escapes and converts our markdown-lite to Telegram-safe HTML", () => {
    expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
    expect(toTelegramHtml("*Projects*")).toBe("<b>Projects</b>");
    expect(toTelegramHtml("use `/status` now")).toBe("use <code>/status</code> now");
    // Emphasis markers inside code must not be turned into tags.
    expect(toTelegramHtml("`*keep*`")).toBe("<code>*keep*</code>");
  });

  it("clamps to Telegram's 4096-char message limit", () => {
    expect(clampTelegramText("x".repeat(5000)).length).toBe(4096);
  });

  it("verifies the webhook secret token when one is configured", () => {
    expect(verifyTelegramWebhookSecret(undefined, undefined)).toBe(true);
    expect(verifyTelegramWebhookSecret("right", "right")).toBe(true);
    expect(verifyTelegramWebhookSecret("wrong", "right")).toBe(false);
    expect(verifyTelegramWebhookSecret(undefined, "right")).toBe(false);
  });
});
