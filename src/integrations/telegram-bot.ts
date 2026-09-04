import type { ITelegramService, TelegramUpdate } from "./telegram.js";
import type { ProjectRepository, TaskRepository, WorkflowRepository, ConversationRepository, MemoryRepository } from "../domain/repos.js";
import type { AgentRepository } from "../agents/agent-repo.js";
import type { RunRepository } from "../observability/repos.js";
import type { AgentManager } from "../agents/manager.js";
import type { IGitHubService } from "../github/types.js";
import type { ModelRepository } from "../ai/model-repo.js";
import type { SkillRepository } from "../skills/registry.js";
import type { JobQueue } from "../db/queue.js";
import type { Project } from "../domain/entities.js";
import type { Logger } from "../logger.js";
import type { TelegramRuntimeStatus } from "./telegram-runtime.js";
import { eventBus } from "../events/bus.js";

export interface TelegramBotDeps {
  telegram: ITelegramService;
  projectRepo: ProjectRepository;
  taskRepo: TaskRepository;
  workflowRepo?: WorkflowRepository;
  conversationRepo?: ConversationRepository;
  agentRepo: AgentRepository;
  runRepo: RunRepository;
  agentManager: AgentManager;
  github: IGitHubService;
  modelRepo?: ModelRepository;
  skillRepo?: SkillRepository;
  memoryRepo?: MemoryRepository;
  queue?: JobQueue;
  logger: Logger;
  /** Live "how am I receiving messages" report, surfaced by /ping and /start. */
  runtimeStatus?: () => TelegramRuntimeStatus | undefined;
  /** Platform user this bot belongs to (per-user bot). Undefined = the operator's global bot. */
  userId?: string;
  /**
   * Access control for a user's own bot. Without it a bot answers whoever finds
   * it — with a leaked token that means strangers browsing (and commanding) the
   * owner's projects. The state is read through `current()` because pairing can
   * happen at any moment, including from this very handler.
   */
  access?: TelegramBotAccess;
}

export interface TelegramBotAccess {
  current(): { ownerChatId?: string; pairCode?: string };
  /** Bind the chat that presented the right code to this bot's owner. */
  link(chatId: string): void | Promise<void>;
}

type InlineButton = { text: string; callback_data?: string; url?: string };
type InlineKeyboard = InlineButton[][];

interface View {
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * Telegram command + inline keyboard handler. The bot is project-aware: every
 * conversation binds to a project and agent context. The bot exposes the same
 * sections as the web UI (projects, agents, models, skills, tasks, runs, status,
 * tests, memory, GitHub, dashboard) as inline keyboards, so a user can drive the
 * platform from Telegram as if they were in the site. Natural-language requests
 * create a task and enqueue it to the background worker.
 */
export class TelegramBot {
  /** Active project per chat, so multiple chats don't bleed state into each other. */
  private readonly projectByChat = new Map<string, string>();

  constructor(private readonly deps: TelegramBotDeps) {}

  async handle(update: unknown): Promise<TelegramUpdate | undefined> {
    const t = await this.deps.telegram.handleUpdate(update);
    if (!t) return t;

    // Acknowledge inline-button callbacks so Telegram stops the button spinner.
    if (t.callbackId) {
      try {
        await this.deps.telegram.answerCallbackQuery(t.callbackId);
      } catch {
        /* non-fatal */
      }
    }

    if (!t.chatId) return t;

    // Per-user bots answer their paired chat only.
    const denied = await this.gateAccess(t);
    if (denied !== undefined) {
      await this.deps.telegram.sendMessage({ chatId: t.chatId, text: denied });
      return t;
    }

    // A thrown handler must never look like "the bot ignored me": answer with
    // the reason instead of going silent.
    let view: View;
    try {
      view = await this.resolveView(t);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.logger.error("telegram handler failed", { chatId: t.chatId, err: detail });
      view = {
        text: `⚠️ Something went wrong while handling that:\n\`${detail}\`\n\nSend /start to get back to the menu.`,
        keyboard: this.homeKeyboard(),
      };
    }
    // Inline-button presses navigate in place (edit the tapped message) so the
    // menu behaves like a real app; commands and plain text send a new message.
    if (t.callbackData && t.messageId != null) {
      await this.deps.telegram.editMessage({
        chatId: t.chatId,
        messageId: t.messageId,
        text: view.text,
        inlineKeyboard: view.keyboard,
      });
    } else {
      await this.deps.telegram.sendButtons({
        chatId: t.chatId,
        text: view.text,
        inlineKeyboard: view.keyboard,
      });
    }
    await eventBus.publish("telegram.command", { chatId: t.chatId, text: t.text, callbackData: t.callbackData });
    return t;
  }

  /* ------------------------------------------------------------------ *
   * Routing
   * ------------------------------------------------------------------ */

  /**
   * Resolve what the bot *would* answer for an update, without sending it.
   * Used by the web UI's Telegram preview, so the menu can be exercised without
   * a bot token — and so "is my bot broken?" has an answer that does not
   * require reading server logs.
   */
  async preview(update: unknown): Promise<{ update?: TelegramUpdate; reply?: View; error?: string }> {
    const t = await this.deps.telegram.handleUpdate(update);
    if (!t) return {};
    if (!t.chatId) return { update: t };
    try {
      return { update: t, reply: await this.resolveView(t) };
    } catch (err) {
      return { update: t, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Returns the text to send when this chat must not be served, or undefined when
   * the update may proceed. `/pair CODE` is the only thing a stranger is allowed
   * to do, and only with the code the owner sees in Settings.
   */
  private async gateAccess(t: TelegramUpdate): Promise<string | undefined> {
    const access = this.deps.access;
    if (!access) return undefined;
    const chatId = t.chatId!;
    const { ownerChatId, pairCode } = access.current();
    if (ownerChatId && ownerChatId === chatId) return undefined;
    const raw = (t.text ?? "").trim();
    const m = /^\/pair(?:@\w+)?\s+(\S+)$/i.exec(raw);
    if (m && pairCode && m[1]!.trim().toUpperCase() === pairCode.toUpperCase()) {
      await access.link(chatId);
      return `✅ Linked — this bot now answers this chat and nobody else.

Send /start for the menu.`;
    }
    if (ownerChatId) {
      return "🔒 This is a private CodeVia bot: it answers its owner's chat only.";
    }
    return `🔒 This bot is not linked to a chat yet.
Open CodeVia → Settings → Telegram, copy the pairing code, and send it here as:
<code>/pair ${pairCode ?? "CODE"}</code>`;
  }

  /**
   * Projects this bot may touch. A per-user bot sees its owner's projects (plus
   * unowned/legacy ones, so an existing single-user install keeps working); the
   * operator's global bot sees everything.
   */
  private ownedProjects(): Project[] {
    const all = this.deps.projectRepo.findMany().map((r) => r.data);
    const userId = this.deps.userId;
    if (!userId) return all;
    return all.filter((p) => !p.ownerId || p.ownerId === userId);
  }

  private ownedProject(id: string | undefined): Project | undefined {
    if (!id) return undefined;
    const found = this.deps.projectRepo.findById(id)?.data;
    if (!found) return undefined;
    if (this.deps.userId && found.ownerId && found.ownerId !== this.deps.userId) return undefined;
    return found;
  }

  private async resolveView(t: TelegramUpdate): Promise<View> {
    const chatId = t.chatId!;
    if (t.callbackData) {
      return this.resolveCallback(chatId, t.callbackData);
    }
    const raw = t.text?.trim() ?? "";
    if (!raw) return this.menuHome(chatId);

    // In groups Telegram delivers `/start@MyBot`; without stripping the mention
    // every command silently fell through to the natural-language path.
    const [head = "", ...rest] = raw.split(/\s+/);
    const cmd = head.toLowerCase().replace(/@\w+$/, "");
    const args = rest.join(" ").trim();

    if (cmd === "/start" || cmd === "/menu" || cmd === "/home") return this.menuHome(chatId);
    if (cmd === "/help" || cmd === "/?" || cmd === "/کمک") return this.helpView();
    if (cmd === "/id" || cmd === "/chatid" || cmd === "/whoami") return this.identityView(t);
    if (cmd === "/ping" || cmd === "/health") return this.pingView();
    if (cmd === "/projects" || cmd === "/project") return this.projectsView();
    if (cmd === "/agents") return this.globalSection(chatId, "agents");
    if (cmd === "/models") return this.globalSection(chatId, "models");
    if (cmd === "/skills") return this.globalSection(chatId, "skills");
    if (cmd === "/tasks") return this.globalSection(chatId, "tasks");
    if (cmd === "/runs") return this.globalSection(chatId, "runs");
    if (cmd === "/status") return this.globalSection(chatId, "status");
    if (cmd === "/tests") return this.globalSection(chatId, "tests");
    if (cmd === "/memory") return this.globalSection(chatId, "memory");
    if (cmd === "/github" || cmd === "/issues" || cmd === "/pr" || cmd === "/prs") {
      return this.projectScoped(chatId, "github");
    }
    if (cmd === "/review") return this.projectScoped(chatId, "status");
    if (cmd === "/dashboard") return this.globalSection(chatId, "dashboard");
    if (cmd === "/settings") return this.settingsView(chatId);
    if (cmd === "/stop" || cmd === "/cancel") return this.cancelPendingView(chatId);
    if (cmd === "/run") return this.runCommand(chatId, args);
    if (cmd === "/task") return this.taskCommand(chatId, args);

    // Anything else — Persian included — is a natural-language request.
    return this.handleNaturalLanguage(chatId, raw);
  }


  private async resolveCallback(chatId: string, cb: string): Promise<View> {
    if (cb === "menu:home") {
      this.projectByChat.delete(chatId);
      return this.menuHome(chatId);
    }
    if (cb === "menu:help") return this.helpView();
    if (cb === "menu:ping") return this.pingView();
    if (cb === "project:list") return this.projectsView();

    const [action, ...rest] = cb.split(":");
    const arg = rest.join(":");

    switch (action) {
      case "project":
        return this.selectProject(chatId, arg);
      case "menu":
        return this.globalSection(chatId, arg);
      case "agent":
        return this.agentView(arg);
      case "action":
        return this.projectAction(chatId, arg);
      default:
        return this.menuHome(chatId);
    }
  }

  /* ------------------------------------------------------------------ *
   * Menu builders
   * ------------------------------------------------------------------ */

  private menuHome(chatId?: string): View {
    const projects = this.ownedProjects();
    const active = chatId ? this.activeProject(chatId) : undefined;
    const status = this.deps.runtimeStatus?.();
    const lines = [
      "🤖 *CodeVia — AI Engineering Platform*",
      "",
      active
        ? `📁 Active project: *${active.name}*`
        : projects.length === 1
          ? `📁 Project: *${projects[0].name}* (auto-selected — tap 📚 Projects to switch)`
          : projects.length > 0
            ? "📁 No project selected yet — pick one with 📚 Projects."
            : "📁 No projects yet — create one in the web UI first.",
      "",
      "Pick a section below, or just type a request and I'll run it as a task on your active project.",
      "Example: *\"بررسی کن چرا Login بعد از آخرین کامیت خراب شده\"*",
      "",
      "Commands: /projects /agents /models /skills /tasks /runs /status /tests /memory /github /issues /pr /task /run /settings /status /ping /help",
    ];
    if (status && status.enabled && status.transport === "off" && status.mode !== "off") {
      lines.push("", `⚠️ I'm not receiving messages right now — ${status.fixes[0] ?? "check /ping"}`);
    }
    return { text: lines.filter((l) => l !== undefined).join("\n"), keyboard: this.homeKeyboard() };
  }

  /** `GET /integrations/telegram/status`, phrased for a chat. */
  private pingView(): View {
    const s = this.deps.runtimeStatus?.();
    if (!s) {
      return {
        text: "🏓 Pong. Telegram runtime status is not exposed in this context.",
        keyboard: this.homeKeyboard(),
      };
    }
    const text = [
      "🏓 *Bot self-check*",
      "",
      `👤 Bot: ${s.botUsername ? `@${s.botUsername}` : s.hasToken ? "token set (username unknown)" : "no token (mock mode)"}`,
      `📡 Receiving via: *${s.transport}* (mode: ${s.mode})`,
      s.webhookUrl && s.transport === "webhook" ? `🔗 Webhook: ${s.webhookUrl}` : "",
      s.transport === "polling"
        ? `🔄 Polling: ${s.polling?.running ? `running · ${s.polling.updatesReceived} update(s) read` : "not running"}`
        : "",
      s.webhookInfo?.pendingUpdateCount ? `⏳ Pending at Telegram: ${s.webhookInfo.pendingUpdateCount}` : "",
      s.lastCheckedAt ? `🕒 Last check: ${s.lastCheckedAt}` : "",
      "",
      s.fixes.length ? "🛠 How to fix:\n" + s.fixes.map((f) => `• ${f}`).join("\n") : "✅ Nothing to fix — send me a message and I'll answer.",
    ]
      .filter(Boolean)
      .join("\n");
    return { text, keyboard: this.homeKeyboard() };
  }

  /** The chat/user ids the platform's Telegram settings form asks for. */
  private identityView(t: TelegramUpdate): View {
    const text = [
      "🪪 *Your Telegram ids*",
      "",
      `👤 User id (AccountId): \`${t.userId ?? "—"}\``,
      `💬 Chat id: \`${t.chatId ?? "—"}\``,
      t.username ? `🏷 Username: @${t.username}` : "",
      t.chatType ? `📂 Chat type: ${t.chatType}` : "",
      "",
      "Paste the *User id* into the “AccountId” field on the platform's Telegram page if you use your own bot account.",
      t.chatType && t.chatType !== "private"
        ? "\nℹ️ In groups, only messages that are commands (or mention the bot) reach me — that's Telegram's privacy mode, not a bug. Use /privacy in @BotFather to change it."
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { text, keyboard: this.homeKeyboard() };
  }


  private homeKeyboard(): InlineKeyboard {
    return [
      [{ text: "📚 Projects", callback_data: "project:list" }],
      [{ text: "🤖 Agents", callback_data: "menu:agents" }, { text: "🧠 Models", callback_data: "menu:models" }],
      [{ text: "🧩 Skills", callback_data: "menu:skills" }, { text: "🛠 Tasks", callback_data: "menu:tasks" }],
      [{ text: "📼 Runs", callback_data: "menu:runs" }, { text: "📊 Status", callback_data: "menu:status" }],
      [{ text: "🧪 Tests", callback_data: "menu:tests" }, { text: "🧠 Memory", callback_data: "menu:memory" }],
      [{ text: "📦 GitHub", callback_data: "menu:github" }, { text: "🎛 Dashboard", callback_data: "menu:dashboard" }],
      [{ text: "🆘 Help", callback_data: "menu:help" }, { text: "🏓 Self-check", callback_data: "menu:ping" }],
    ];
  }

  private helpView(): View {
    return {
      text: [
        "🤖 *CodeVia Bot Help*",
        "",
        "• *Projects* — switch your active project.",
        "• *Agents* — see the team for the active project.",
        "• *Run Task / Ask AI* — describe what you need and I'll create + run a task.",
        "• *Status / Tests / Tasks / Runs* — project health and history.",
        "• *Memory* — architecture/decisions/lessons for the project.",
        "• *GitHub* — linked repos, branches, opened issues & PRs.",
        "• *Self-check* (`/ping`) — how the bot receives messages + what to fix.",
        "• *Id* (`/id`) — your Telegram user/chat id, i.e. the “AccountId” the web UI asks for.",
        ...(this.deps.access ? ["• *Link* (`/pair CODE`) — binds this chat to a bot created in Settings."] : []),
        "",
        "Send any natural-language message (فارسی هم می‌شود) and I'll run it on the active project.",
        "`/task <شرح>` creates a task, `/run <متن>` runs it now, `/stop` cancels queued work.",
        "",
        "Select a project first with 📚 Projects → then use its menu.",
      ].join("\n"),
      keyboard: this.homeKeyboard(),
    };
  }

  private projectsView(): View {
    const projects = this.ownedProjects();
    if (projects.length === 0) {
      return {
        text: "ℹ️ No projects yet.\n\nCreate one from the web UI, or POST /projects with a GitHub repo.",
        keyboard: this.adHocKeyboard([
          [{ text: "🏠 Home", callback_data: "menu:home" }],
        ]),
      };
    }
    const rows: InlineKeyboard = projects
      .slice(0, 12)
      .map((p) => [{ text: `📁 ${p.name}`, callback_data: `project:${p.id}` }]);
    return {
      text: "📚 *Select a project:*",
      keyboard: this.adHocKeyboard([...rows, [{ text: "🏠 Home", callback_data: "menu:home" }]]),
    };
  }

  private selectProject(chatId: string, id: string): View {
    const project = this.ownedProject(id);
    if (!project) return this.projectsView();
    this.projectByChat.set(chatId, id);
    return {
      text: this.projectHeader(project),
      keyboard: this.projectKeyboard(project),
    };
  }

  private projectHeader(p: Project): string {
    const repos = p.repositories.map((r) => r.repo).join(", ") || p.configRepo || "—";
    return [
      `📁 *${p.name}*`,
      p.description ? p.description : "",
      "",
      `🗃 Repos: ${repos}`,
      `🌿 Branch: ${p.branch || "main"}`,
      p.defaultModelId ? `🧠 Model: ${p.defaultModelId}` : "",
      "",
      "Choose an action:",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private projectKeyboard(p: Project): InlineKeyboard {
    const agents = this.deps.agentRepo.byProject(p.id);
    const agentRows = agents.slice(0, 6).map((a) => [{ text: `🤖 ${a.name}`, callback_data: `agent:${a.id}` }]);
    return this.adHocKeyboard([
      ...agentRows,
      [
        { text: "⬆️ Run Task", callback_data: `action:run:${p.id}` },
        { text: "📊 Status", callback_data: `action:status:${p.id}` },
      ],
      [
        { text: "🛠 Tasks", callback_data: `action:tasks:${p.id}` },
        { text: "📼 Runs", callback_data: `action:runs:${p.id}` },
      ],
      [
        { text: "🧪 Tests", callback_data: `action:tests:${p.id}` },
        { text: "🧠 Memory", callback_data: `action:memory:${p.id}` },
      ],
      [
        { text: "📦 GitHub", callback_data: `action:github:${p.id}` },
        { text: "🧩 Skills", callback_data: `action:skills:${p.id}` },
      ],
      [
        { text: "📚 Projects", callback_data: "project:list" },
        { text: "🏠 Home", callback_data: "menu:home" },
      ],
    ]);
  }

  private adHocKeyboard(rows: Array<Array<InlineButton | undefined>>): InlineKeyboard {
    return rows.filter((r) => r.length > 0).map((r) => r.filter(Boolean) as InlineButton[]);
  }

  /* ------------------------------------------------------------------ *
   * Global (no project required) sections — mirror the site's menus.
   * ------------------------------------------------------------------ */

  private async globalSection(chatId: string, section: string): Promise<View> {
    switch (section) {
      case "agents":
        return this.projectScoped(chatId, "agents");
      case "skills":
        return this.skillsView(this.activeProject(chatId));
      case "models":
        return this.modelsView();
      case "tasks":
        return this.projectScoped(chatId, "tasks");
      case "runs":
        return this.projectScoped(chatId, "runs");
      case "status":
        return this.projectScoped(chatId, "status");
      case "tests":
        return this.projectScoped(chatId, "tests");
      case "memory":
        return this.projectScoped(chatId, "memory");
      case "github":
        return this.githubView(this.activeProject(chatId));
      case "dashboard":
        return this.dashboardView();
      case "issues":
      case "prs":
        return this.projectScoped(chatId, section);
      case "ping":
        return this.pingView();
      case "settings":
        return this.settingsView(chatId);
      default:
        return this.menuHome(chatId);
    }
  }

  /** Sections that need a project: if none is active, ask the user to pick one. */
  private async projectScoped(chatId: string, section: string): Promise<View> {
    const project = this.activeProject(chatId);
    if (!project) {
      return {
        text: `🤔 Choose a project to open *${section}*:`,
        keyboard: this.projectsKeyboardOnly(),
      };
    }
    return this.projectAction(chatId, `${section}:${project.id}`);
  }

  private activeProject(chatId: string): Project | undefined {
    const id = this.projectByChat.get(chatId);
    const bound = this.ownedProject(id);
    if (bound) return bound;
    if (id) this.projectByChat.delete(chatId); // stale id (project deleted)
    // With exactly one project there is nothing to choose — auto-binding it is
    // the difference between "the bot works" and "the bot ignores every message"
    // for the common single-project setup.
    const all = this.ownedProjects();
    if (all.length === 1) {
      this.projectByChat.set(chatId, all[0].id);
      return all[0];
    }
    return undefined;
  }

  private projectsKeyboardOnly(): InlineKeyboard {
    const projects = this.ownedProjects();
    if (projects.length === 0) return [[{ text: "ℹ️ No projects yet", callback_data: "menu:home" }]];
    return projects
      .slice(0, 12)
      .map((p) => [{ text: `📁 ${p.name}`, callback_data: `project:${p.id}` }]);
  }

  private modelsView(): View {
    const models = (this.deps.modelRepo?.listActive() ?? []).slice(0, 12);
    if (models.length === 0) {
      return { text: "ℹ️ No models registered.", keyboard: this.homeKeyboard() };
    }
    const text = ["🧠 *Models*", "", ...models.map((m) => `• ${m.displayName} (${m.modelId}) — ctx ${m.contextWindow}`)].join("\n");
    return { text, keyboard: this.homeKeyboard() };
  }

  private dashboardView(): View {
    const runs = this.deps.runRepo.findMany().map((r) => r.data);
    const tasks = this.deps.taskRepo.findMany().map((r) => r.data);
    const projects = this.ownedProjects();
    const agents = this.deps.agentRepo.findMany().map((r) => r.data);
    const running = runs.filter((r) => r.status === "running").length;
    const succeeded = runs.filter((r) => r.status === "succeeded").length;
    const failed = runs.filter((r) => r.status === "failed").length;
    const text = [
      "🎛 *Dashboard*",
      "",
      `📚 Projects: ${projects.length}`,
      `🤖 Agents: ${agents.length}`,
      `🛠 Tasks: ${tasks.length}`,
      `📼 Runs: ${runs.length}  (✅ ${succeeded} · ⏳ ${running} · ❌ ${failed})`,
      `💸 Cost: $${runs.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`,
    ].join("\n");
    return { text, keyboard: this.homeKeyboard() };
  }

  /* ------------------------------------------------------------------ *
   * Project-scoped actions
   * ------------------------------------------------------------------ */

  private async projectAction(chatId: string, arg: string): Promise<View> {
    const idx = arg.indexOf(":");
    const kind = idx >= 0 ? arg.slice(0, idx) : arg;
    const id = idx >= 0 ? arg.slice(idx + 1) : undefined;
    const project = this.ownedProject(id) ?? this.activeProject(chatId);
    if (!project) return this.projectsView();
    if (id) this.projectByChat.set(chatId, project.id);

    switch (kind) {
      case "status":
        return this.statusView(project);
      case "tests":
        return this.testsView(project);
      case "tasks":
        return this.tasksView(project);
      case "runs":
        return this.runsView(project);
      case "memory":
        return this.memoryView(project);
      case "github":
        return this.githubView(project);
      case "skills":
        return this.skillsView(project);
      case "run":
        return this.promptRunView(project);
      case "ask":
        return this.promptAskView(project);
      case "issues":
        return await this.issuesView(project);
      case "prs":
        return await this.prsView(project);
      case "agents":
        return this.projectAgentsView(project);
      case "stop":
        return this.cancelPendingView(chatId, project);
      default:
        return this.selectProject(chatId, project.id);
    }
  }

  private statusView(p: Project): View {
    const runs = this.deps.runRepo.byProject(p.id);
    const tasks = this.deps.taskRepo.byProject(p.id);
    const agents = this.deps.agentRepo.byProject(p.id);
    const succeeded = runs.filter((r) => r.status === "succeeded").length;
    const running = runs.filter((r) => r.status === "running").length;
    const failed = runs.filter((r) => r.status === "failed").length;
    const text = [
      `📊 *Status — ${p.name}*`,
      "",
      `🤖 Agents: ${agents.length}`,
      `🛠 Tasks: ${tasks.length} (${tasks.filter((t) => t.status === "running").length} running)`,
      `📼 Runs: ${runs.length}  (✅ ${succeeded} · ⏳ ${running} · ❌ ${failed})`,
      `🧠 Tokens: ${runs.reduce((s, r) => s + r.totalTokens, 0)}`,
      `💸 Cost: $${runs.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`,
    ].join("\n");
    return { text, keyboard: this.projectKeyboard(p) };
  }

  private testsView(p: Project): View {
    const runs = this.deps.runRepo
      .byProject(p.id)
      .filter((r) => r.agentType === "qa-test")
      .slice(0, 6);
    const text = runs.length
      ? [`🧪 *Tests — ${p.name}*`, "", ...runs.map((r) => `${r.status === "succeeded" ? "✅" : r.status === "failed" ? "❌" : "⏳"} ${r.status} · ${r.agentType}`)].join("\n")
      : `🧪 *Tests — ${p.name}*\n\nNo test runs yet.`;
    return { text, keyboard: this.projectKeyboard(p) };
  }

  private tasksView(p: Project): View {
    const tasks = this.deps.taskRepo.byProject(p.id).slice(0, 8);
    const text = tasks.length
      ? [`🛠 *Tasks — ${p.name}*`, "", ...tasks.map((t) => `${t.status === "succeeded" ? "✅" : t.status === "failed" ? "❌" : "🔄"} ${t.title.slice(0, 60)}`)].join("\n")
      : `🛠 *Tasks — ${p.name}*\n\nNo tasks yet.`;
    return { text, keyboard: this.projectKeyboard(p) };
  }

  private runsView(p: Project): View {
    const runs = this.deps.runRepo.byProject(p.id).slice(0, 8);
    const text = runs.length
      ? [`📼 *Runs — ${p.name}*`, "", ...runs.map((r) => `${r.status === "succeeded" ? "✅" : r.status === "failed" ? "❌" : "⏳"} ${r.status} · ${r.agentType}`)].join("\n")
      : `📼 *Runs — ${p.name}*\n\nNo runs yet.`;
    return { text, keyboard: this.projectKeyboard(p) };
  }

  private memoryView(p: Project): View {
    const entries = this.deps.memoryRepo?.byProject(p.id) ?? [];
    const text = entries.length
      ? [`🧠 *Memory — ${p.name}*`, "", ...entries.slice(0, 8).map((m) => `• ${m.type ?? "note"}: ${(m.key ?? m.content ?? "").slice(0, 60)}`)].join("\n")
      : `🧠 *Memory — ${p.name}*\n\nNo memory entries yet.`;
    return { text, keyboard: this.projectKeyboard(p) };
  }

  private async githubView(p: Project | undefined): Promise<View> {
    if (!p) {
      const viewer = await this.safeGithub(() => this.deps.github.getViewer());
      return {
        text: `📦 *GitHub*\n\n${viewer ? `👤 ${viewer.login ?? viewer.name ?? "user"}` : "ℹ️ GitHub not configured / mock mode."}\n\nLink a project to see its repos.`,
        keyboard: this.homeKeyboard(),
      };
    }
    const repos = p.repositories.map((r) => r.repo).join(", ") || p.configRepo || "—";
    const text = [
      `📦 *GitHub — ${p.name}*`,
      "",
      `🗃 Repos: ${repos}`,
      `🌿 Branch: ${p.branch || "main"}`,
    ].join("\n");
    return { text, keyboard: this.projectKeyboard(p) };
  }

  private skillsView(p: Project | undefined): View {
    const skills = this.deps.skillRepo?.findMany().map((r) => r.data).filter((s) => s.enabled) ?? [];
    const scoped = p && p.settings?.skills?.length
      ? skills.filter((s) => p.settings?.skills?.includes(s.slug))
      : skills;
    const slice = scoped.slice(0, 10);
    const text = slice.length
      ? [`🧩 *Skills${p ? ` — ${p.name}` : ""}*`, "", ...slice.map((s) => `• ${s.name} (${s.category})`)].join("\n")
      : `🧩 *Skills${p ? ` — ${p.name}` : ""}*\n\nNo skills.`;
    return { text, keyboard: p ? this.projectKeyboard(p) : this.homeKeyboard() };
  }

  private agentView(id: string): View {
    const a = this.deps.agentRepo.findById(id)?.data;
    if (!a) return this.menuHome();
    const p = this.ownedProject(a.projectId);
    const text = [
      `🤖 *${a.name}*`,
      "",
      `Type: ${a.type}`,
      a.role ? `Role: ${a.role}` : "",
      a.description ? a.description : "",
      a.enabled ? "✅ Enabled" : "⛔ Disabled",
      a.skills?.length ? `Skills: ${a.skills.slice(0, 5).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { text, keyboard: p ? this.projectKeyboard(p) : this.homeKeyboard() };
  }

  /* ------------------------------------------------------------------ *
   * Natural language task execution
   * ------------------------------------------------------------------ */

  private promptRunView(p: Project): View {
    return {
      text: `⬆️ *Run a task on ${p.name}*\n\nDescribe what you want (e.g. "Add pagination to the API") and send it. I'll create + run the task.`,
      keyboard: this.projectKeyboard(p),
    };
  }

  private promptAskView(p: Project): View {
    return {
      text: `❓ *Ask AI about ${p.name}*\n\nType your question and I'll run it as a task.`,
      keyboard: this.projectKeyboard(p),
    };
  }

  private async handleNaturalLanguage(chatId: string, text: string): Promise<View> {
    const project = this.activeProject(chatId);
    if (!project || !this.deps.queue || !this.deps.agentManager) {
      return {
        text: "🤔 Select a project first (📚 Projects), then send your request.",
        keyboard: this.projectsKeyboardOnly(),
      };
    }
    const title = text.length > 100 ? `${text.slice(0, 100)}…` : text;
    const task = this.deps.agentManager.createTask({
      projectId: project.id,
      title,
      description: text,
    });
    const job = this.deps.queue.enqueue("agent.run", { taskId: task.id }, { correlationId: task.correlationId });
    return {
      text: [
        `🛠 Task created & queued.`,
        "",
        `📌 ${title}`,
        `🆔 ${task.id}`,
        `📦 ${project.name}`,
        `⚙️ status: queued`,
        "",
        "Run `/status` or open the project menu to track progress.",
      ].join("\n"),
      keyboard: this.projectKeyboard(project),
    };
  }

  /* ------------------------------------------------------------------ *
   * Commands documented in docs/TELEGRAM_SETUP.md that the bot must honour.
   * ------------------------------------------------------------------ */

  private projectAgentsView(p: Project): View {
    const agents = this.deps.agentRepo.byProject(p.id);
    const text = agents.length
      ? [`🤖 *Agents — ${p.name}*`, "", ...agents.slice(0, 18).map((a) => `${a.enabled === false ? "⛔" : "✅"} ${a.name} · ${a.type}`)].join("\n")
      : `🤖 *Agents — ${p.name}*\n\nNo agents yet. They are generated when a project is onboarded.`;
    return { text, keyboard: this.projectKeyboard(p) };
  }

  private async issuesView(p: Project): Promise<View> {
    const ref = p.repositories[0]?.repo ?? p.configRepo;
    const issues = ref ? await this.safeGithub(() => this.deps.github.listIssues({ owner: ref.split("/")[0] ?? "", name: ref.split("/")[1] ?? "" })) : undefined;
    const open = (issues ?? []).filter((i) => i.state !== "closed").slice(0, 10);
    const text = open.length
      ? [`🐙 *Issues — ${p.name}*`, "", ...open.map((i) => `#${i.number} ${i.title.slice(0, 70)}`)].join("\n")
      : `🐙 *Issues — ${p.name}*\n\n${ref ? "No open issues." : "No repository linked to this project."}`;
    return { text, keyboard: this.projectKeyboard(p) };
  }

  private async prsView(p: Project): Promise<View> {
    const ref = p.repositories[0]?.repo ?? p.configRepo;
    const prs = ref ? await this.safeGithub(() => this.deps.github.listPullRequests({ owner: ref.split("/")[0] ?? "", name: ref.split("/")[1] ?? "" })) : undefined;
    const open = (prs ?? []).filter((r) => r.state !== "closed" && r.state !== "merged").slice(0, 10);
    const text = open.length
      ? [`🔀 *Pull requests — ${p.name}*`, "", ...open.map((r) => `#${r.number} ${r.title.slice(0, 60)} · \`${r.head}\``)].join("\n")
      : `🔀 *Pull requests — ${p.name}*\n\n${ref ? "No open pull requests." : "No repository linked to this project."}`;
    return { text, keyboard: this.projectKeyboard(p) };
  }

  /** Bot/project settings as the user sees them from Telegram. */
  private settingsView(chatId: string): View {
    const p = this.activeProject(chatId);
    const s = this.deps.runtimeStatus?.();
    const text = [
      "⚙️ *Bot settings*",
      "",
      p ? `📁 Project: ${p.name}` : "📁 Project: none selected",
      p?.defaultModelId ? `🧠 Model: ${p.defaultModelId}` : "🧠 Model: platform router (auto)",
      p ? `🌿 Branch: ${p.branch || "main"}` : "",
      "",
      `📡 Receiving: ${s ? `${s.transport} (${s.mode})` : "unknown"}`,
      s?.botUsername ? `🤖 Bot: @${s.botUsername}` : "",
      "",
      p?.settings?.notifications?.length
        ? `🔔 Notifications: ${p.settings.notifications.join(", ")}`
        : "🔔 Notifications: task/run summaries only",
      "",
      "Change these on the web UI's project settings page; I pick them up on the next message.",
    ]
      .filter(Boolean)
      .join("\n");
    return { text, keyboard: p ? this.projectKeyboard(p) : this.projectsKeyboardOnly() };
  }

  /** `/task <text>` — explicit task creation, even before the menu is explored. */
  private async taskCommand(chatId: string, args: string): Promise<View> {
    if (!args) {
      const p = this.requireProject(chatId);
      return p ? this.promptRunView(p) : this.projectsView();
    }
    return this.handleNaturalLanguage(chatId, args);
  }

  /** `/run <text>` — same as /task, kept for parity with the documented commands. */
  private async runCommand(chatId: string, args: string): Promise<View> {
    if (!args) {
      const p = this.requireProject(chatId);
      return p ? this.promptRunView(p) : this.projectsView();
    }
    // `/run <text>` runs the request now (same path as a natural-language ask).
    return this.handleNaturalLanguage(chatId, args);
  }

  private requireProject(chatId: string): Project | undefined {
    const p = this.activeProject(chatId);
    if (p) return p;
    // A single project is auto-bound by activeProject(); with several we must
    // not guess, so the caller shows the picker instead.
    return undefined;
  }

  /** `/stop` — cancel everything still queued for this chat's project. */
  private cancelPendingView(chatId: string, project?: Project): View {
    const p = project ?? this.activeProject(chatId);
    if (!p) {
      return { text: "🛑 Nothing to stop — no project is selected here.", keyboard: this.projectsKeyboardOnly() };
    }
    const pending = this.deps.taskRepo
      .byProject(p.id)
      .filter((t) => t.status === "created" || t.status === "queued" || t.status === "waiting_for_approval");
    for (const task of pending) {
      this.deps.taskRepo.upsert({ ...task, status: "cancelled", updatedAt: new Date().toISOString() }, { projectId: p.id, parentId: task.parentTaskId });
    }
    const text = pending.length
      ? [`🛑 *Cancelled ${pending.length} task(s)* on ${p.name}`, "", ...pending.slice(0, 8).map((t) => `• ${t.title.slice(0, 60)}`)].join("\n")
      : `🛑 *Nothing queued* on ${p.name}.

Running work is reported by /status; cancel mid-run from the web UI.`;
    return { text, keyboard: this.projectKeyboard(p) };
  }

  private async safeGithub<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  }
}
