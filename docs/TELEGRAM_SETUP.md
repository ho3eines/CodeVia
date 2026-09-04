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

### One bot per user — entered in Settings, never in an env var

`TELEGRAM_BOT_TOKEN` is the **operator's** bot (one per deployment, shared by everyone). For
"each user has their own bot", nothing is set in the environment: each person opens
**Settings → Your Telegram bot**, pastes the token from BotFather, and saves. The platform then:

1. verifies the token with `getMe` and stores it **encrypted at rest** (AES-256-GCM); the UI only
   ever shows a mask — and a `422` is returned instead of saving a token Telegram rejects;
2. brings up a receive path for *that* token: webhook when this deployment has a public HTTPS URL,
   otherwise **long polling** (no URL, no tunnel);
3. shows a **6-character pairing code**. The bot answers no chat until its owner sends
   `/pair CODE` to it on Telegram — after that it answers *only* that chat. Anyone else gets
   "this is a private CodeVia bot". Without this, a token pasted into a group would turn into a
   bot that reads and drives the owner's projects for whoever finds it;
4. scopes what the bot can see: it lists only projects owned by that user (projects created
   through the web UI while signed in are stamped with `ownerId`; pre-existing/unowned projects
   stay visible to everyone, so single-user installs are unaffected);
5. routes that bot's incoming messages to that user's data — both the per-account webhook path
   (`POST /integrations/telegram/webhook/:accountId`) and the account's poller build a bot bound
   to the account row, and re-read it live, so linking a chat takes effect without a restart.

Re-pairing (new phone, new chat, leaked code) = **🔗 Link another chat** in Settings, which
invalidates the old chat and issues a fresh code. Two users must not paste the *same* token: the
platform warns when an account's token equals the operator's, because both receivers then answer
every message twice.

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
| `/pair CODE` | **Per-user bots only**: binds this chat as the bot's owner. The code is shown in Settings when the token is entered |
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

---

## 9. Environment variables that change this behaviour

| Variable | Effect when set |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | The only thing needed for a working bot (long polling). |
| `TELEGRAM_MODE` | `auto` (default) · `webhook` · `polling` · `off`. |
| `TELEGRAM_POLL_TIMEOUT` | Long-poll hold seconds (default 25). |
| `TELEGRAM_WEBHOOK_URL` | Exact webhook URL to register, skipping URL discovery. |
| `PUBLIC_WEB_BASE_URL` | Public base used to build the webhook URL. |
| `TELEGRAM_WEBHOOK_SECRET` | Registered on `setWebhook` **and** required on every inbound post. |
| `TELEGRAM_WEBHOOK_INSECURE` | Keep `http://` for a public host behind a proxy that reports `x-forwarded-proto: http`. |
| `TELEGRAM_WEBHOOK_ALLOW_LOOPBACK` | Test-only: allows `http://127.0.0.1:…` webhooks (offline Bot API double, tunnels). Never in production. |
| `TELEGRAM_API_BASE` | Point the client at a proxy/mirror or the mock (`npm run mock:telegram`). |
| `ENABLE_TELEGRAM` | Enable-only switch. A token already means intent; use `TELEGRAM_MODE=off` to stop receiving. |

## 10. What *you* have to do (checklist)

The platform automates everything it can (webhook registration, polling fallback,
offset, retries). These are the steps only an operator can do:

**BotFather**
1. `/newbot` (or `/mybots` → API tokens → `/revoke` if the token was ever shared) → copy the token.
2. Groups only: `/setprivacy` → *Disable*, otherwise the bot sees just commands/@mentions.
3. Nothing else in BotFather — **do not** paste a webhook URL there; the platform registers it.

**Railway / server**
4. Variables → `TELEGRAM_BOT_TOKEN=<token>`. That is the minimum for a working bot.
5. Redeploy (env changes need a restart).
6. Optional, only if you specifically want push delivery:
   `PUBLIC_WEB_BASE_URL=https://<app>.up.railway.app` (Railway's domain is already public HTTPS)
   and `TELEGRAM_WEBHOOK_SECRET=<any random string>` so nobody else can POST fake updates to
   your webhook. `ENABLE_TELEGRAM` and a tunnel are **not** required.
7. Optional: run exactly **one** replica while using long polling — two replicas polling one
   token make Telegram answer `409 Conflict`.

**In the UI (Telegram page)**
8. Press **🧪 Run connection test** (`GET /integrations/telegram/test`) — it walks
   token → outbound network → webhook registration → our endpoint answering 200 →
   a running transport, and prints the one action that fixes each failing step.
   `verdict: "blocked"` with `This host cannot reach api.telegram.org` means the
   environment has no outbound HTTPS (CI runners and sandboxed previews usually
   don't) — nothing in Telegram's settings will change that.
9. Send `/start` to your bot in Telegram. No answer? Send `/ping` to the bot: it reports the
   transport it is actually using and what to fix.
10. Still silent? `curl -s https://<app>/integrations/telegram/diagnostics` and read `fixes[]`.

**Meaning of the common webhook errors**

| Message you see | What it means | Do this |
|---|---|---|
| `webhook URL must be HTTPS (got "http://localhost:8080/…")` | no public URL was learned | set `PUBLIC_WEB_BASE_URL`, or press **📡 Use long polling** |
| `bad webhook: An HTTPS URL must be provided for webhook` | Telegram refused the URL | same as above |
| `connection refused` / `timed out` in `webhookInfo.last_error_message` | URL is public but the app is not answering | fix ingress/auth/replica, or use polling |
| `Polling error: … 409` | a webhook is registered, or two replicas poll the same token | **🔗 Use webhook** (or keep one polling replica) |
| `telegram getMe network error: fetch failed — ECONNRESET` | this host cannot reach `api.telegram.org` | allow that egress, or run the app somewhere with internet access |
| `webhook URL must be HTTPS (got "http://<public-host>/…")` | the base was configured/derived as `http` | fixed automatically now: a **public** host configured as `http://` is upgraded to `https://`. If you really need http (internal proxy), set `TELEGRAM_WEBHOOK_INSECURE=true` |
| `TELEGRAM_API_BASE is set to … — this instance is talking to that endpoint, NOT to api.telegram.org` | a mock/proxy base is configured, so "verified token" results are fake | unset `TELEGRAM_API_BASE` for a real bot; it exists for the offline mock and mirrors |
| `Nothing was sent to Telegram: …` | our own check rejected the URL before calling Telegram | fix that one reason — Telegram was never involved, so don't debug its settings |
| `Forbidden: bot was blocked by the user` | you blocked the bot | `/unblock` it in Telegram |
