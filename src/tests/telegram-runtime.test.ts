import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import {
  getPublicBaseUrl,
  getTelegramWebhookUrl,
  resetLearnedPublicBaseUrl,
  validateTelegramWebhookUrl,
} from "../integrations/telegram.js";
import { freshDb } from "./test-helpers.js";

/**
 * The receive path — how the bot learns that a user said something. This is
 * where "the Telegram bot never replies" actually comes from, so it is covered
 * here rather than in a unit test of the formatting code.
 */

const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_API_BASE",
  "TELEGRAM_WEBHOOK_INSECURE",
  "TELEGRAM_MODE",
  "TELEGRAM_WEBHOOK_SECRET",
  "PUBLIC_WEB_BASE_URL",
  "TELEGRAM_WEBHOOK_INSECURE",
  "WEB_BASE_URL",
  "ENABLE_TELEGRAM",
  "REQUIRE_AUTH",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "AUTH_SECRET",
] as const;

let savedEnv: Record<string, string | undefined>;
let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container | undefined;
let fetchCalls: string[];
let fetchBodies: Record<string, unknown>[];

type Reply = { status: number; body: Record<string, unknown> };

/** Scriptable Telegram Bot API. Any method not in `routes` answers ok:true. */
function mockTelegramApi(routes: Record<string, Reply> = {}, opts: { networkDown?: boolean } = {}): void {
  const orig = globalThis.fetch;
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch = () => {
    globalThis.fetch = orig;
  };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    if (opts.networkDown) {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
    }
    fetchCalls.push(method);
    fetchBodies.push(init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {});
    const reply = routes[method] ?? { status: 200, body: { ok: true, result: method === "getMe" ? { id: 42, username: "codevia_test_bot" } : method === "getUpdates" ? [] : method === "getWebhookInfo" ? { url: "" } : true } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

/** Every container we build, so afterEach can always stop its pollers. */
const created: Container[] = [];

function newContainer(): Container {
  const c = new Container();
  created.push(c);
  return c;
}

async function boot(): Promise<FastifyInstance> {
  container = newContainer();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
  return app;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fetchCalls = [];
  fetchBodies = [];
  created.length = 0;
  resetLearnedPublicBaseUrl();
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  for (const c of created) await c.stopTelegram().catch(() => undefined);
  await container?.stopTelegram().catch(() => undefined);
  container = undefined;
  const restore = (globalThis as { __restoreFetch?: () => void }).__restoreFetch;
  restore?.();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  getEnvFresh();
  resetLearnedPublicBaseUrl();
  cleanup?.();
});

describe("Telegram receive path (webhook vs long polling)", () => {
  it("falls back to long polling when there is no public HTTPS URL", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    getEnvFresh();
    mockTelegramApi();
    const c = newContainer();
    await c.ensureSeed();
    const status = await c.startTelegram();
    expect(status.transport).toBe("polling");
    expect(status.polling?.running).toBe(true);
    expect(status.enabled).toBe(true);
    // Telegram reports no webhook here, so polling can start without touching
    // the registration at all (one API call saved per boot/status poll)…
    expect(fetchCalls).toContain("getWebhookInfo");
    expect(fetchCalls).not.toContain("deleteWebhook");
    expect(status.fixes).toEqual([]);
    await c.stopTelegram();
  });

  it("removes a blocking webhook when it switches to polling", async () => {
    // getUpdates answers 409 while a webhook is registered, so a stale/foreign
    // registration must be cleared — otherwise the fallback silently receives nothing.
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    getEnvFresh();
    mockTelegramApi({
      getWebhookInfo: { status: 200, body: { ok: true, result: { url: "https://somewhere-else.example.com/hook", pending_update_count: 0 } } },
    });
    const c = newContainer();
    await c.ensureSeed();
    const status = await c.startTelegram();
    expect(status.transport).toBe("polling");
    expect(fetchCalls).toContain("deleteWebhook");
    await c.stopTelegram();
  });

  it("registers a webhook when a public HTTPS base URL is configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    process.env.PUBLIC_WEB_BASE_URL = "https://codevia.up.railway.app";
    getEnvFresh();
    mockTelegramApi();
    const c = newContainer();
    await c.ensureSeed();
    const status = await c.startTelegram();
    expect(status.transport).toBe("webhook");
    expect(status.webhookUrl).toBe("https://codevia.up.railway.app/integrations/telegram/webhook");
    const setWebhook = fetchBodies[fetchCalls.indexOf("setWebhook")];
    expect(setWebhook?.url).toBe("https://codevia.up.railway.app/integrations/telegram/webhook");
    expect((setWebhook?.allowed_updates as string[] | undefined) ?? []).toContain("callback_query");
    expect(fetchCalls).not.toContain("deleteWebhook");
    await c.stopTelegram();
  });

  it("falls back to polling when setWebhook is rejected by Telegram", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    process.env.PUBLIC_WEB_BASE_URL = "https://codevia.up.railway.app";
    getEnvFresh();
    mockTelegramApi({ setWebhook: { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: bad webhook: an HTTPS URL must be provided for webhook" } } });
    const c = newContainer();
    await c.ensureSeed();
    const status = await c.startTelegram();
    expect(status.transport).toBe("polling");
    expect(status.note ?? "").toMatch(/falling back to long polling/i);
    expect(status.fixes.join(" ")).toMatch(/HTTPS URL must be provided/i);
    await c.stopTelegram();
  });

  it("reports a rejected token instead of pretending the bot is live", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:not-the-real-token";
    getEnvFresh();
    mockTelegramApi({ getMe: { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } } });
    const c = newContainer();
    await c.ensureSeed();
    const status = await c.startTelegram();
    expect(status.transport).toBe("off");
    expect(status.enabled).toBe(true); // a token exists…
    expect(status.note ?? "").toMatch(/rejected the bot token/i); // …but Telegram says no
    await c.stopTelegram();
  });

  it("stays off in mock mode and says why (no token → messages are logged, not sent)", async () => {
    getEnvFresh();
    mockTelegramApi();
    const c = newContainer();
    await c.ensureSeed();
    await c.startTelegram();
    const status = c.telegramStatus();
    expect(status.mock).toBe(true);
    expect(status.transport).toBe("off");
    expect(status.note ?? "").toMatch(/mock Telegram mode/i);
  });

  it("does not let ENABLE_TELEGRAM=false silence a bot that has a token", async () => {
    // The old behavior: a valid token + the default ENABLE_TELEGRAM=false meant
    // no webhook, no polling, no reply — and nothing in the UI said why.
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    process.env.ENABLE_TELEGRAM = "false";
    getEnvFresh();
    mockTelegramApi();
    const c = newContainer();
    await c.ensureSeed();
    const status = await c.startTelegram();
    expect(status.transport).toBe("polling");
    expect(status.fixes.join(" ")).toMatch(/ENABLE_TELEGRAM is false but a token is set/i);
    await c.stopTelegram();
  });

  it("honours TELEGRAM_MODE=off (send-only deployments)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    process.env.TELEGRAM_MODE = "off";
    getEnvFresh();
    mockTelegramApi();
    const c = newContainer();
    await c.ensureSeed();
    const status = await c.startTelegram();
    expect(status.transport).toBe("off");
    expect(fetchCalls).not.toContain("setWebhook");
    expect(fetchCalls).not.toContain("getUpdates");
    expect(c.telegramStatus().fixes).toEqual([]);
    await c.stopTelegram();
  });
});

describe("Telegram webhook transport (end-to-end through the route)", () => {
  it("registers the webhook and answers an inbound update with a menu", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    process.env.PUBLIC_WEB_BASE_URL = "https://codevia.up.railway.app";
    getEnvFresh();
    const sentBodies: Record<string, unknown>[] = [];
    mockTelegramApi({
      sendMessage: { status: 200, body: { ok: true, result: { message_id: 1 } } },
      setWebhook: { status: 200, body: { ok: true, result: true } },
    });
    const srv = await boot();
    // capture what the platform sends back to Telegram
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sendMessage")) sentBodies.push(JSON.parse(String(init?.body)));
      return orig(input as never, init);
    }) as typeof fetch;
    try {
      const status = await container!.startTelegram();
      expect(status.transport).toBe("webhook");

      const inbound = await srv.inject({
        method: "POST",
        url: "/integrations/telegram/webhook",
        payload: { update_id: 1, message: { chat: { id: 555010, type: "private" }, from: { id: 555010 }, text: "/start" } },
      });
      expect(inbound.statusCode).toBe(200);
      expect(inbound.json().ok).toBe(true);
      expect(sentBodies).toHaveLength(1);
      expect(sentBodies[0]).toMatchObject({ chat_id: "555010", parse_mode: "HTML" });
      expect(String(sentBodies[0].text)).toContain("<b>CodeVia");
      expect((sentBodies[0].reply_markup as { inline_keyboard: unknown[] }).inline_keyboard.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("keeps answering 200 when a handler throws (a 5xx makes Telegram drop the webhook)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    process.env.PUBLIC_WEB_BASE_URL = "https://codevia.up.railway.app";
    getEnvFresh();
    mockTelegramApi();
    const srv = await boot();
    const res = await srv.inject({
      method: "POST",
      url: "/integrations/telegram/webhook",
      payload: { update_id: 2, message: { chat: { id: 7 }, from: { id: 7 }, text: "/ping" } },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("Telegram connection test (what the operator must do)", () => {
  it("lists every step with a pass when the bot is correctly wired", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    getEnvFresh();
    mockTelegramApi();
    const c = newContainer();
    await c.ensureSeed();
    await c.startTelegram();
    const t = await c.telegramRuntime.connectionTest();
    const by = Object.fromEntries(t.steps.map((st) => [st.name, st]));
    expect(by.token.status).toBe("pass");
    expect(by.egress.status).toBe("pass");
    expect(by.transport.status).toBe("pass");
    // Loopback dev URL: the probe is skipped rather than reported as broken.
    expect(by.endpoint.status).toBe("skip");
    expect(by.webhook.status).toBe("skip");
    expect(t.verdict).toBe("ready");
    await c.stopTelegram();
  });

  it("names blocked egress as the root cause instead of blaming the webhook", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    getEnvFresh();
    mockTelegramApi({}, { networkDown: true });
    const c = newContainer();
    await c.ensureSeed();
    await c.startTelegram();
    const t = await c.telegramRuntime.connectionTest();
    const by = Object.fromEntries(t.steps.map((st) => [st.name, st]));
    expect(t.verdict).toBe("blocked");
    expect(by.egress.status).toBe("fail");
    expect(by.egress.action).toMatch(/cannot reach api\.telegram\.org/i);
    // …and do not misreport the unknown webhook state as "no webhook".
    const webhook = by.webhook;
    expect(webhook.status).toBe("skip");
    expect(webhook.detail ?? "").toMatch(/ECONNRESET|fetch failed|network error/i);
    expect(webhook.action).toMatch(/egress step first/i);
    await c.stopTelegram();
  });

  it("detects another environment stealing the webhook", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    process.env.PUBLIC_WEB_BASE_URL = "https://staging.example.com";
    process.env.TELEGRAM_MODE = "webhook";
    getEnvFresh();
    mockTelegramApi({
      getWebhookInfo: { status: 200, body: { ok: true, result: { url: "https://prod.example.com/integrations/telegram/webhook" } } },
    });
    const c = newContainer();
    await c.ensureSeed();
    await c.startTelegram();
    const t = await c.telegramRuntime.connectionTest();
    const webhook = t.steps.find((st) => st.name === "webhook");
    expect(webhook?.status).toBe("fail");
    expect(webhook?.detail).toContain("https://prod.example.com");
    expect(webhook?.action).toMatch(/share one bot token/i);
    await c.stopTelegram();
  });

  it("assumes HTTPS for a public host even when the proxy says http (Telegram rejects http webhooks)", () => {
    const base = getPublicBaseUrl("8080-codevia.e2b.app", "http");
    expect(base).toBe("https://8080-codevia.e2b.app");
    expect(validateTelegramWebhookUrl(getTelegramWebhookUrl("my-app.up.railway.app", "http")).ok).toBe(true);
  });
});

describe("Telegram HTTP surface", () => {
  it("status reports the live transport, not just 'token exists'", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    getEnvFresh();
    mockTelegramApi();
    const srv = await boot();
    const res = await srv.inject({ method: "GET", url: "/integrations/telegram/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transport).toBe("polling");
    expect(body.receiving).toBe(true);
    expect(body.connected).toBe(true);
    expect(body.baseUrl).toBeDefined();
    expect(body.polling?.running).toBe(true);
  });

  it("switches transport at runtime via POST /integrations/telegram/transport", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    process.env.PUBLIC_WEB_BASE_URL = "https://codevia.up.railway.app";
    getEnvFresh();
    mockTelegramApi({
      // After our own setWebhook, Telegram reports the registration — switching
      // to polling must therefore clear it.
      getWebhookInfo: { status: 200, body: { ok: true, result: { url: "https://codevia.up.railway.app/integrations/telegram/webhook" } } },
    });
    const srv = await boot();
    await container!.startTelegram();
    const res = await srv.inject({ method: "POST", url: "/integrations/telegram/transport", payload: { mode: "polling" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status.transport).toBe("polling");
    expect(fetchCalls).toContain("deleteWebhook");
    const bad = await srv.inject({ method: "POST", url: "/integrations/telegram/transport", payload: { mode: "carrier-pigeon" } });
    expect(bad.statusCode).toBe(400);
  });

  it("hands out a pairing code when a user connects a bot in Settings", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN; // no operator bot: users bring their own
    getEnvFresh();
    mockTelegramApi();
    const srv = await boot();
    const created = await srv.inject({
      method: "POST",
      url: "/integrations/telegram/accounts",
      payload: { token: "999999:personal-bot-token", name: "My bot" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    // A token alone is enough: the bot is live (polling) but answers nobody's chat
    // until the owner pairs it.
    expect(body.account.connected).toBe(true);
    expect(body.account.paired).toBe(false);
    expect(body.account.pairCode).toMatch(/^[0-9A-F]{6}$/);
    expect(body.pairing?.howto).toMatch(/\/pair [0-9A-F]{6}/);

    // Re-pairing (new chat, or a leaked code) issues a fresh one.
    const repatched = await srv.inject({
      method: "PATCH",
      url: `/integrations/telegram/accounts/${body.account.id}`,
      payload: { pair: true },
    });
    expect(repatched.json().pairCode).toMatch(/^[0-9A-F]{6}$/);
    expect(repatched.json().chatId ?? "").toBe("");

    // The webhook route for that account refuses an unlinked chat instead of
    // answering it with the owner's data.
    const intruder = await srv.inject({
      method: "POST",
      url: `/integrations/telegram/webhook/${body.account.id}`,
      payload: { update_id: 5, message: { chat: { id: 424242, type: "private" }, from: { id: 424242 }, text: "/projects" } },
    });
    expect(intruder.statusCode).toBe(200);
    const sent = fetchBodies.filter((b) => String(b.text ?? "").includes("not linked to a chat yet"));
    expect(sent.length).toBe(1);
    // …with the *fresh* code, since re-pairing rotated it.
    expect(String(sent[0].text)).toContain(repatched.json().pairCode);
    expect(String(sent[0].text)).not.toContain(body.account.pairCode);
    // …and it never read the owner's projects.
    expect(String(sent[0].text)).not.toMatch(/Select a project/);
  });

  it("reports ready only when a receive path is actually running", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    getEnvFresh();
    mockTelegramApi();
    const srv = await boot();
    await srv.inject({ method: "POST", url: "/integrations/telegram/transport", payload: { mode: "polling" } });
    let res = await srv.inject({ method: "GET", url: "/integrations/telegram/status" });
    let body = res.json();
    expect(body.ready).toBe(true);
    expect(body.configured).toBe(true);

    // A token Telegram rejects must surface as "configured but not ready", never as
    // healthy — and the poller must stop hammering getUpdates with a dead token.
    mockTelegramApi({ getMe: { status: 401, body: { ok: false, description: "Unauthorized" } } });
    await srv.inject({ method: "POST", url: "/integrations/telegram/transport", payload: { mode: "off" } });
    await srv.inject({ method: "POST", url: "/integrations/telegram/transport", payload: { mode: "polling" } });
    res = await srv.inject({ method: "GET", url: "/integrations/telegram/status" });
    body = res.json();
    expect(body.ready).toBe(false);
    expect(body.configured).toBe(true);
    expect(body.transport).toBe("off");
    expect(body.polling?.running ?? false).toBe(false);
    expect(body.note ?? body.fixes.join(" ")).toMatch(/rejected the bot token|unauthorized/i);
  });

  it("upgrades an http public base to https instead of blaming the operator", async () => {
    // Preview proxies and TLS-terminated ingresses answer on https at the same
    // host — an `http://PUBLIC_WEB_BASE_URL` is a scheme typo, not a missing URL.
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    process.env.PUBLIC_WEB_BASE_URL = "http://my-app.up.railway.app";
    getEnvFresh();
    mockTelegramApi();
    expect(getPublicBaseUrl()).toBe("https://my-app.up.railway.app");
    const srv = await boot();
    const res = await srv.inject({ method: "POST", url: "/integrations/telegram/transport", payload: { mode: "webhook" } });
    expect(res.json().ok).toBe(true);
    expect(res.json().status.webhookUrl).toBe("https://my-app.up.railway.app/integrations/telegram/webhook");
    // An explicit opt-out is still honoured for a real http-only host.
    process.env.TELEGRAM_WEBHOOK_INSECURE = "true";
    getEnvFresh();
    expect(getPublicBaseUrl()).toBe("http://my-app.up.railway.app");
  });

  it("refuses to pretend a mock Bot API is Telegram", async () => {
    // The trap this exists for: an instance with TELEGRAM_API_BASE set "verified"
    // a real token against the offline mock, so the UI looked green while no bot
    // was wired to anything.
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    process.env.TELEGRAM_API_BASE = "http://127.0.0.1:8099";
    getEnvFresh();
    mockTelegramApi();
    const srv = await boot();
    const body = (await srv.inject({ method: "GET", url: "/integrations/telegram/status" })).json();
    expect(body.realApi).toBe(false);
    expect(body.apiBase).toBe("http://127.0.0.1:8099");
    expect(body.fixes.join(" ")).toMatch(/NOT to api\.telegram\.org/i);

    const t = (await srv.inject({ method: "GET", url: "/integrations/telegram/test" })).json();
    expect(t.verdict).not.toBe("ready");
    const first = t.steps[0];
    expect(first.label).toMatch(/Bot API endpoint/i);
    expect(first.action).toMatch(/Unset TELEGRAM_API_BASE/i);
  });

  it("does not report success when the requested transport cannot come up", async () => {
    // No public HTTPS URL here: asking for webhook mode must answer ok:false with
    // the reason, instead of a green toast over a bot that receives nothing.
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    getEnvFresh();
    mockTelegramApi();
    const srv = await boot();
    const res = await srv.inject({ method: "POST", url: "/integrations/telegram/transport", payload: { mode: "webhook" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/HTTPS/i);
    expect(fetchCalls).not.toContain("setWebhook");
  });

  it("diagnostics returns Telegram's own view of the bot", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    getEnvFresh();
    mockTelegramApi({
      getWebhookInfo: { status: 200, body: { ok: true, result: { url: "https://old.example.com/hook", pending_update_count: 3, last_error_message: "connection refused" } } },
    });
    const srv = await boot();
    const res = await srv.inject({ method: "GET", url: "/integrations/telegram/diagnostics" });
    const body = res.json();
    expect(body.botUsername).toBe("codevia_test_bot");
    expect(body.webhookInfo.url).toBe("https://old.example.com/hook");
    // The stale webhook + delivery failure is explained, not swallowed.
    expect(body.fixes.join(" ")).toMatch(/connection refused/i);
    expect(body.fixes.join(" ")).toMatch(/3 update\(s\) queued/i);
  });

  it("rejects forged webhook posts when TELEGRAM_WEBHOOK_SECRET is set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:codevia-token-value";
    process.env.TELEGRAM_MODE = "off";
    process.env.TELEGRAM_WEBHOOK_SECRET = "shared-secret";
    getEnvFresh();
    mockTelegramApi();
    const srv = await boot();
    const forged = await srv.inject({
      method: "POST",
      url: "/integrations/telegram/webhook",
      payload: { update_id: 1, message: { chat: { id: 5 }, from: { id: 5 }, text: "/start" } },
    });
    expect(forged.statusCode).toBe(401);
    const legit = await srv.inject({
      method: "POST",
      url: "/integrations/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "shared-secret" },
      payload: { update_id: 2, message: { chat: { id: 5 }, from: { id: 5 }, text: "/start" } },
    });
    expect(legit.statusCode).toBe(200);
    expect(legit.json().ok).toBe(true);
  });

  it("keeps per-account webhook subpaths public even with REQUIRE_AUTH=true", async () => {
    process.env.REQUIRE_AUTH = "true";
    // Strict auth only actually rejects when a login path exists (otherwise the
    // platform deliberately stays in demo mode so nobody can lock themselves out).
    process.env.GITHUB_CLIENT_ID = "Ov23liTESTCLIENTID";
    process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
    process.env.AUTH_SECRET = "test-auth-secret-0123456789";
    process.env.TELEGRAM_MODE = "off";
    getEnvFresh();
    mockTelegramApi();
    const srv = await boot();
    const res = await srv.inject({
      method: "POST",
      url: "/integrations/telegram/webhook/some-account",
      payload: { update_id: 3, message: { chat: { id: 9 }, from: { id: 9 }, text: "/start" } },
    });
    expect(res.statusCode).toBe(200);
    // ...while a guarded route still 401s, proving the allowlist is narrow.
    const guarded = await srv.inject({ method: "GET", url: "/integrations/telegram/status" });
    expect(guarded.statusCode).toBe(401);
  });

  it("routes a per-user bot to long polling when its webhook cannot be set", async () => {
    process.env.TELEGRAM_MODE = "off";
    getEnvFresh();
    mockTelegramApi({
      setWebhook: { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: bad webhook: connect failed" } },
    });
    const srv = await boot();
    const created = await srv.inject({
      method: "POST",
      url: "/integrations/telegram/accounts",
      payload: { token: "999999:personal-bot-token", accountId: "555" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.account.connected).toBe(true);
    expect(body.account.webhookSet).toBe(false);
    expect(body.account.transport).toBe("polling");
    expect(body.account.pollingActive).toBe(true);
    expect(body.receiving).toMatch(/long polling/i);
    expect(body.account.lastError).toMatch(/long polling instead/i);
  });
});
