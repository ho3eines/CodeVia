import type { ITelegramService, TelegramUpdate } from "./telegram.js";
import type { ProjectRepository, TaskRepository } from "../domain/repos.js";
import type { AgentRepository } from "../agents/agent-repo.js";
import type { RunRepository } from "../observability/repos.js";
import type { AgentManager } from "../agents/manager.js";
import type { IGitHubService } from "../github/types.js";
import type { Logger } from "../logger.js";
import { eventBus } from "../events/bus.js";

export interface TelegramBotDeps {
  telegram: ITelegramService;
  projectRepo: ProjectRepository;
  taskRepo: TaskRepository;
  agentRepo: AgentRepository;
  runRepo: RunRepository;
  agentManager: AgentManager;
  github: IGitHubService;
  logger: Logger;
}

/**
 * Telegram command + inline keyboard handler. The bot is project-aware: every
 * conversation binds to a project and agent context. Natural-language requests
 * are routed through the Agent Manager (project detection -> agents -> models).
 */
export class TelegramBot {
  private currentProjectId: string | undefined;

  constructor(private readonly deps: TelegramBotDeps) {}

  async handle(update: unknown): Promise<TelegramUpdate | undefined> {
    const t = await this.deps.telegram.handleUpdate(update);
    if (!t?.chatId) return t;
    await this.deps.telegram.sendButtons({
      chatId: t.chatId,
      text: this.buildMenu(t.text),
      inlineKeyboard: await this.buildKeyboard(t.text, t.callbackData),
    });
    await eventBus.publish("telegram.command", { chatId: t.chatId, text: t.text, callbackData: t.callbackData });
    return t;
  }

  private buildMenu(text: string | undefined): string {
    const cmd = text?.toLowerCase() ?? "";
    if (cmd.startsWith("/start") || cmd.startsWith("/help")) {
      return [
        "🤖 *CodeVia AI Engineering Platform*",
        "",
        "Select an option below, or type a natural-language request.",
        "Example: *\"بررسی کن چرا Login بعد از آخرین Commit خراب شده\"*",
        "",
        "Commands: /projects /agents /models /task /run /status /tests /issues /pr /memory /skills",
      ].join("\n");
    }
    if (this.currentProjectId) {
      const project = this.deps.projectRepo.findById(this.currentProjectId)?.data;
      if (project) return `📁 Project: *${project.name}*\n\n${text ?? "Choose an action"}`;
    }
    return text ?? "Choose an action";
  }

  private async buildKeyboard(text: string | undefined, callback?: string): Promise<Array<Array<{ text: string; callback_data?: string }>>> {
    const cmd = (callback ?? text ?? "").toLowerCase();
    // Project selection.
    if (cmd.includes("project") && !callback) {
      const projects = this.deps.projectRepo.findMany().map((r) => r.data);
      if (projects.length === 0) return [[{ text: "ℹ️ No projects yet", callback_data: "noop" }]];
      return projects.map((p) => [{ text: `📁 ${p.name}`, callback_data: `project:${p.id}` }]);
    }
    if (callback?.startsWith("project:")) {
      const id = callback.split(":")[1];
      this.currentProjectId = id;
      const project = this.deps.projectRepo.findById(id)?.data;
      const agents = this.deps.agentRepo.byProject(id);
      return [
        ...agents.slice(0, 4).map((a) => [{ text: `🤖 ${a.name}`, callback_data: `agent:${a.id}` }]),
        [{ text: "🔬 Run Task", callback_data: "action:run" }, { text: "🧪 Tests", callback_data: "action:tests" }],
        [{ text: "📦 GitHub", callback_data: "action:github" }, { text: "🧠 Memory", callback_data: "action:memory" }],
        [{ text: "✅ Status", callback_data: "action:status" }, { text: "❓ Ask AI", callback_data: "action:ask" }],
        [{ text: "📚 Projects", callback_data: "list:projects" }],
      ];
    }
    if (cmd.startsWith("action:status")) {
      const id = this.currentProjectId;
      if (!id) return [];
      const runs = this.deps.runRepo.byProject(id);
      const running = runs.filter((r) => r.status === "running").length;
      const failed = runs.filter((r) => r.status === "failed").length;
      const html = `📊 Status\nRunning: ${running}\nFailed: ${failed}\nTotal runs: ${runs.length}`;
      void html;
      return [[{ text: "🔙 Back", callback_data: this.currentProjectId ? `project:${this.currentProjectId}` : "list:projects" }]];
    }
    if (cmd.startsWith("action:tests")) {
      const id = this.currentProjectId;
      if (!id) return [];
      const runs = this.deps.runRepo.byProject(id).filter((r) => r.agentType === "qa-test");
      const html = runs.slice(0, 5).map((r) => `${r.status === "succeeded" ? "✅" : "❌"} ${r.status}`).join("\n");
      void html;
      return [[{ text: "🔙 Back", callback_data: this.currentProjectId ? `project:${this.currentProjectId}` : "list:projects" }]];
    }
    if (cmd.startsWith("list:projects")) return this.buildKeyboard("project");
    return [[{ text: "📚 Projects", callback_data: "list:projects" }]];
  }
}
