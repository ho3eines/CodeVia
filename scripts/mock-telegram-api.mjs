#!/usr/bin/env node
/**
 * Offline Telegram Bot API mock — for testing the real bot flow with no token,
 * no public URL and no internet.
 *
 *   node scripts/mock-telegram-api.mjs            # listens on 127.0.0.1:8099
 *   TELEGRAM_API_BASE=http://127.0.0.1:8099 npm run dev:server
 *
 * Then:
 *   curl -s -X POST localhost:8099/push -d '{"text":"/start"}'     # "a user said something"
 *   curl -s localhost:8099/sent                                     # what the bot replied
 *
 * The platform's polling loop talks to this exactly like it talks to
 * api.telegram.org (same JSON shape, same getUpdates offset semantics), so a
 * green run here means the receive path genuinely works.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_TELEGRAM_PORT || 8099);
const HOST = process.env.MOCK_TELEGRAM_HOST || "127.0.0.1";

let nextUpdateId = 1;
const queue = []; // pending updates for getUpdates
const sent = []; // sendMessage / editMessageText / sendDocument calls
let webhook = null;

const readJson = (req) =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });

const send = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // Developer controls (not part of the Bot API).
  if (path === "/push" && req.method === "POST") {
    const body = await readJson(req);
    const id = Number(body.update_id ?? nextUpdateId++);
    const update = { update_id: id };
    if (body.callback_query) {
      update.callback_query = {
        id: `cb-${id}`,
        data: body.callback_query.data,
        from: { id: 555010, username: "dev" },
        message: { chat: { id: 555010, type: "private" }, message_id: Number(body.callback_query.message_id ?? 42) },
      };
    } else {
      update.message = {
        chat: { id: 555010, type: "private" },
        from: { id: 555010, username: "dev", first_name: "Hooman" },
        message_id: 100 + (id % 900),
        text: body.text ?? "/start",
        ...(body.message ?? {}),
      };
    }
    queue.push(update);
    if (webhook) {
      // Emulate a webhook delivery so both transports can be exercised.
      fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(webhook.secret_token ? { "X-Telegram-Bot-Api-Secret-Token": webhook.secret_token } : {}),
        },
        body: JSON.stringify(update),
      }).catch((err) => console.log("[mock-telegram] webhook delivery failed:", err.message));
    }
    return send(res, 200, { ok: true, result: update });
  }
  if (path === "/sent") return send(res, 200, { ok: true, result: sent });
  if (path === "/state") {
    return send(res, 200, { ok: true, result: { pending: queue.length, webhook, sent: sent.length } });
  }

  const botCall = path.match(/^\/bot[^/]+\/(\w+)$/);
  if (!botCall) return send(res, 404, { ok: false, description: `not found: ${path}` });
  const method = botCall[1];
  const body = req.method === "POST" ? await readJson(req) : {};

  switch (method) {
    case "getMe":
      return send(res, 200, { ok: true, result: { id: 42, is_bot: true, username: "codevia_mock_bot", first_name: "CodeVia (mock)" } });
    case "getUpdates": {
      const timeoutSec = Number(body.timeout ?? 0);
      const offset = Number(body.offset ?? 0);
      const deadline = Date.now() + Math.min(timeoutSec, 5) * 1000;
      // Long-poll semantics: hold the connection until an update exists.
      while (!queue.some((u) => u.update_id >= offset) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const result = queue.filter((u) => u.update_id >= offset).slice(0, Number(body.limit ?? 100));
      for (const u of result) queue.splice(queue.indexOf(u), 1);
      return send(res, 200, { ok: true, result });
    }
    case "setWebhook":
      webhook = { url: body.url, secret_token: body.secret_token };
      return send(res, 200, { ok: true, result: true });
    case "deleteWebhook":
      webhook = null;
      return send(res, 200, { ok: true, result: true });
    case "getWebhookInfo":
      return send(res, 200, { ok: true, result: { url: webhook?.url ?? "", pending_update_count: queue.length, ...(webhook ? { last_error_message: "" } : {}) } });
    case "sendMessage":
    case "editMessageText":
    case "sendDocument":
    case "answerCallbackQuery":
      sent.push({ method, ...body });
      return send(res, 200, { ok: true, result: { message_id: 200 + sent.length } });
    default:
      return send(res, 200, { ok: true, result: true });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-telegram] Bot API mock on http://${HOST}:${PORT}`);
  console.log(`[mock-telegram] controls: POST /push {text} · GET /sent · GET /state`);
});
