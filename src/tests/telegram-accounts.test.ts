import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";

const ENV_KEYS = ["REQUIRE_AUTH"] as const;
let savedEnv: Record<string, string | undefined>;
let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;

async function boot(): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
  return app;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  getEnvFresh();
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  getEnvFresh();
  cleanup?.();
});

describe("per-user Telegram bot accounts", () => {
  it("connects a user bot with a real getMe/webhook check and never leaks the token", async () => {
    const srv = await boot();
    const origFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/getMe")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { id: 999, username: "my_custom_bot" } }), { status: 200 }));
      }
      if (url.includes("/setWebhook")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 404 }));
    }) as typeof fetch;

    try {
      const created = await srv.inject({ method: "POST", url: "/integrations/telegram/accounts", payload: { token: "12345:ABC_SECRET", accountId: "777777", name: "My bot" } });
      expect(created.statusCode).toBe(201);
      const body = created.json();
      expect(body.account.connected).toBe(true);
      expect(body.account.webhookSet).toBe(true);
      expect(body.account.botUsername).toBe("my_custom_bot");
      expect(body.account.tokenMasked).toContain("•");
      expect(JSON.stringify(body)).not.toContain("ABC_SECRET");
      expect(calls.some((u) => u.includes("/getMe"))).toBe(true);
      expect(calls.some((u) => u.includes("/setWebhook"))).toBe(true);

      const list = (await srv.inject({ method: "GET", url: "/integrations/telegram/accounts" })).json() as Array<{ accountId: string; connected: boolean }>;
      expect(list).toHaveLength(1);
      expect(list[0].accountId).toBe("777777");
      expect(list[0].connected).toBe(true);

      const reconnect = await srv.inject({ method: "POST", url: `/integrations/telegram/accounts/${body.account.id}/connect` });
      expect(reconnect.statusCode).toBe(200);
      expect(reconnect.json().connected).toBe(true);

      const del = await srv.inject({ method: "DELETE", url: `/integrations/telegram/accounts/${body.account.id}` });
      expect(del.statusCode).toBe(200);
      expect((await srv.inject({ method: "GET", url: "/integrations/telegram/accounts" })).json()).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
