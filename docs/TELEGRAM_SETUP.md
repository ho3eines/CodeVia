# Telegram Setup Guide

The Telegram bot is a first-class interface: project-aware, bidirectional, with inline keyboards and natural-language requests.

---

## 1. Create the bot

1. Open Telegram and message **@BotFather**.
2. `/newbot` → pick a name and username.
3. Copy the **bot token**.
4. Set `TELEGRAM_BOT_TOKEN` in Railway Secrets / `.env`.

Without a token, the platform uses a **MockTelegramService** (messages are logged, not sent), so local development needs no bot.

---

## 2. Set the webhook

Point Telegram's webhook at the platform:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-app>.up.railway.app/integrations/telegram/webhook
```

The route `POST /integrations/telegram/webhook` accepts Telegram updates and routes them to the bot handler. (An alternate `sendMessage`-based polling mode is available too.)

---

## 3. Commands

| Command | Action |
|---------|--------|
| `/start` | Show main menu + project selection |
| `/help` | Help text |
| `/projects` | List projects |
| `/project` | Select a project |
| `/agents` | List agents for the project |
| `/models` | List models |
| `/task` | Create a task |
| `/run` | Run an agent / task |
| `/status` | Project & agent status |
| `/tests` | Recent test results |
| `/issues` | Open issues |
| `/pr` | Pull requests |
| `/review` | Review a PR |
| `/memory` | Project memory |
| `/skills` | Show skills |
| `/settings` | Bot settings |
| `/stop` / `/cancel` | Stop / cancel work |

> The primary UX is **inline keyboards** (not command-only). Messages can also be **natural language**: e.g. *"در پروژه X Login را بررسی کن و تست Authentication را اجرا کن."* The bot routes to the Agent Manager, which detects the project, picks agents/models, loads memory/skills, runs, and reports.

---

## 4. Inline keyboards / callbacks

The bot builds button rows per context (project list → project actions → agent actions → status/tests/GitHub/memory/ask). Callback data (e.g. `project:<id>`, `action:status`) drives navigation without typing.

---

## 5. Human approvals

Dangerous operations (merge, deploy, migration, breaking changes, costly runs) surface an approval in Telegram. The user approves/rejects; the workflow continues or stops. The approval channel is wired via `Container.approvalChannel` (default auto-approve in dev/sim; override to require a real approval).

---

## 6. Conversation memory

Telegram conversations are bound to a project + active agent. Long conversations are **auto-summarized**; summaries can be pushed to GitHub memory so project context is preserved across sessions.
