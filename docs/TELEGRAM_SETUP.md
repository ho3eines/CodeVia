# Telegram Setup Guide

The Telegram bot is a first-class interface: project-aware, bidirectional, with inline keyboards and natural-language requests (Persian included).

> **You only need a bot token.** The platform registers a webhook when it has a
> public HTTPS URL and otherwise **long-polls** `getUpdates` — so the bot answers
> on a laptop, a NAT'ed VPS, or a preview host without ngrok. The #1 cause of a
> silent bot used to be "webhook required but nobody could reach this server";
> that failure mode no longer exists.

---

## 1. Create the bot

1. Open Telegram and message **@BotFather**.
2. `/newbot` → pick a name and username.
3. Copy the **bot token** (looks like `123456789:AA...`).
4. Set `TELEGRAM_BOT_TOKEN` in Railway Variables / `.env`, or paste it in the web UI on **Telegram → ＋ Connect a bot**.

Without a token, the platform uses **MockTelegramService** (messages are logged, not sent), so local development needs no bot.

---

## 2. How updates reach the bot

| `TELEGRAM_MODE` | Receive path | Needs a public HTTPS URL? |
|---|---|---|
| `auto` *(default)* | webhook if a public HTTPS URL is configured **and** accepted by Telegram, otherwise long polling | no — it falls back |
| `polling` | `getUpdates` long poll (any webhook registration is removed, since Telegram blocks `getUpdates` while one is set) | **no** |
| `webhook` | `setWebhook` only; if the URL is not public HTTPS the status endpoint says so instead of pretending | yes |
| `off` | nothing is received (send-only notifications) | n/a |

The webhook URL is resolved from, in order:

1. `TELEGRAM_WEBHOOK_URL` (explicit override)
2. `PUBLIC_WEB_BASE_URL` (production, e.g. `https://<app>.up.railway.app`)
3. a public URL learned from a real request (`x-forwarded-host` + proto — works behind proxies/preview hosts)
4. `WEB_BASE_URL` (dev default; **not** usable by Telegram, so this means polling)

Telegram rejects `http://` and `localhost` webhooks with
`Bad Request: bad webhook: An HTTPS URL must be provided for webhook`. If you see
that in the logs and still want push delivery, set one of the first two variables
and press **🔗 Use webhook** (or `POST /integrations/telegram/transport {"mode":"webhook"}`).

Verify at any time:

```bash
curl -s localhost:8080/integrations/telegram/diagnostics | jq
```

It returns `getMe`, `getWebhookInfo` (Telegram's own view, including
`pending_update_count` and `last_error_message`), the local poller state and a
list of actionable `fixes`.

---

## 3. Commands

| Command | Action |
|---------|--------|
| `/start` `/menu` | Main menu with inline keyboards |
| `/help` | Command list |
| `/projects` | List / switch projects (with one project it is auto-selected) |
| `/agents` | Agents of the active project |
| `/models` | Registered models |
| `/skills` | Enabled skills (project-scoped when a project is active) |
| `/task <text>` | Create a task from text |
| `/run <text>` | Create + queue a task immediately |
| `/status` | Project run/task/cost summary |
| `/tasks` `/runs` | Recent tasks and runs |
| `/tests` | Recent QA runs |
| `/memory` | Project memory entries |
| `/github` | Linked repos + branches |
| `/issues` | Open GitHub issues |
| `/pr` | Open pull requests |
| `/review` | Status view (review context) |
| `/dashboard` | Platform-wide counters |
| `/settings` | What the bot currently uses (project, model, transport) |
| `/stop` `/cancel` | Cancel this project's queued tasks |
| `/id` | Your Telegram user id + chat id — paste into the **AccountId** field |
| `/ping` | Self-check: transport, webhook, poller, and what to fix |

Plain text that isn't a command is treated as a request: *"در پروژه X Login را بررسی کن و تست Authentication را اجرا کن"* → task created, queued to the worker, result reported back.

> In **groups** Telegram's privacy mode only forwards commands and @mentions. If
> the bot ignores group chatter, that is Telegram's setting, not the platform —
> use `/privacy` in @BotFather.

---

## 4. Inline keyboards / callbacks

The bot builds button rows per context (project list → project actions → agent
→ status/tests/GitHub/memory/ask). Callback data (`project:<id>`,
`action:status:<id>`, `menu:runs`) navigates **in place** via
`editMessageText`, and every callback is acknowledged with `answerCallbackQuery`
so the button spinner stops. Errors inside a handler are answered as a visible
⚠️ message instead of silence.

---

## 5. Human approvals

Dangerous operations (merge, deploy, migration, breaking changes, costly runs)
surface an approval in Telegram. The user approves/rejects; the workflow
continues or stops. The approval channel is wired via `Container.approvalChannel`
(default auto-approve in dev/sim; override to require a real approval).

---

## 6. Conversation memory

Telegram conversations are bound to a project + active agent. Long
conversations are **auto-summarized**; summaries can be pushed to GitHub memory
so project context is preserved across sessions.

---

## 7. Testing a bot without the internet

```bash
npm run mock:telegram                     # local Bot API double on :8099
TELEGRAM_API_BASE=http://127.0.0.1:8099 TELEGRAM_BOT_TOKEN=42:demo npm run dev:server
curl -X POST localhost:8099/push -d '{"text":"/start"}'      # "a user messaged the bot"
curl -s localhost:8099/sent                                   # what the bot replied
```

The mock implements `getMe`/`getUpdates`/`setWebhook`/`deleteWebhook`/
`sendMessage` with real offset semantics, so the polling loop, callbacks and
HTML formatting are all exercised for real.

---

## 8. "My bot is silent" checklist

1. `GET /integrations/telegram/status` → `receiving` true? `transport` = `polling`/`webhook`?
2. `GET /integrations/telegram/diagnostics` → read `fixes[]`; it names the failing step
   (bad token, unreachable webhook, conflict with another instance, pending updates).
3. `webhookInfo.pending_update_count > 0` → Telegram has updates but cannot deliver:
   the URL is wrong/unreachable, or the route returns non-2xx. `TELEGRAM_WEBHOOK_SECRET`
   mismatch is rejected with 401 — check that `setWebhook` sent the same value.
4. Two replicas both polling with one token → Telegram answers 409. Keep the
   webhook (or run exactly one polling replica); the poller already reports this.
5. `connection refused`/`ECONNRESET` to `api.telegram.org` → outbound traffic is
   blocked by the network/egress policy; the log says so explicitly.
