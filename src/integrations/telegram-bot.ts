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

    const view = await this.resolveView(t);
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

  private async resolveView(t: TelegramUpdate): Promise<View> {
    const chatId = t.chatId!;
    if (t.callbackData) {
      return this.resolveCallback(chatId, t.callbackData);
    }
    const text = t.text?.trim() ?? "";
    if (!text) return this.menuHome();

    // Slash commands.
    const cmd = text.toLowerCase();
    if (cmd === "/start" || cmd === "/menu" || cmd === "/home") return this.menuHome();
    if (cmd === "/help" || cmd === "/?" ) return this.helpView();
    if (cmd === "/projects" || cmd === "/project") return this.projectsView();
    if (cmd === "/agents") return this.globalSection(chatId, "agents");
    if (cmd === "/models") return this.globalSection(chatId, "models");
    if (cmd === "/skills") return this.globalSection(chatId, "skills");
    if (cmd === "/tasks") return this.globalSection(chatId, "tasks");
    if (cmd === "/runs") return this.globalSection(chatId, "runs");
    if (cmd === "/status") return this.globalSection(chatId, "status");
    if (cmd === "/tests") return this.globalSection(chatId, "tests");
    if (cmd === "/memory") return this.globalSection(chatId, "memory");
    if (cmd === "/github") return this.globalSection(chatId, "github");
    if (cmd === "/dashboard") return this.globalSection(chatId, "dashboard");

    // Natural language request → run it as a task on the active project.
    return this.handleNaturalLanguage(chatId, text);
  }

  private async resolveCallback(chatId: string, cb: string): Promise<View> {
    if (cb === "menu:home") {
      this.projectByChat.delete(chatId);
      return this.menuHome();
    }
    if (cb === "menu:help") return this.helpView();
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
        return this.menuHome();
    }
  }

  /* ------------------------------------------------------------------ *
   * Menu builders
   * ------------------------------------------------------------------ */

  private menuHome(): View {
    return {
      text: [
        "🤖 *CodeVia — AI Engineering Platform*",
        "",
        "Pick a section below, or just type a request and I'll run it as a task on your active project.",
        "Example: *\"بررسی کن چرا Login بعد از آخرین کامیت خراب شده\"*",
        "",
        "Commands: /projects /agents /models /skills /tasks /runs /status /tests /memory /github /dashboard /help",
      ].join("\n"),
      keyboard: this.homeKeyboard(),
    };
  }

  private homeKeyboard(): InlineKeyboard {
    return [
      [{ text: "📚 Projects", callback_data: "project:list" }],
      [{ text: "🤖 Agents", callback_data: "menu:agents" }, { text: "🧠 Models", callback_data: "menu:models" }],
      [{ text: "🧩 Skills", callback_data: "menu:skills" }, { text: "🛠 Tasks", callback_data: "menu:tasks" }],
      [{ text: "📼 Runs", callback_data: "menu:runs" }, { text: "📊 Status", callback_data: "menu:status" }],
      [{ text: "🧪 Tests", callback_data: "menu:tests" }, { text: "🧠 Memory", callback_data: "menu:memory" }],
      [{ text: "📦 GitHub", callback_data: "menu:github" }, { text: "🎛 Dashboard", callback_data: "menu:dashboard" }],
      [{ text: "🆘 Help", callback_data: "menu:help" }],
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
        "",
        "Send any natural-language message and I'll run it on the active project.",
        "",
        "Select a project first with 📚 Projects → then use its menu.",
      ].join("\n"),
      keyboard: this.homeKeyboard(),
    };
  }

  private projectsView(): View {
    const projects = this.deps.projectRepo.findMany().map((r) => r.data);
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
    const project = this.deps.projectRepo.findById(id)?.data;
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
      default:
        return this.menuHome();
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
    return id ? this.deps.projectRepo.findById(id)?.data : undefined;
  }

  private projectsKeyboardOnly(): InlineKeyboard {
    const projects = this.deps.projectRepo.findMany().map((r) => r.data);
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
    const projects = this.deps.projectRepo.findMany().map((r) => r.data);
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
    const project = id ? this.deps.projectRepo.findById(id)?.data : this.activeProject(chatId);
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
    const p = a.projectId ? this.deps.projectRepo.findById(a.projectId)?.data : undefined;
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

  private async safeGithub<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  }
}
