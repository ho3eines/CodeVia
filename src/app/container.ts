import { getDb } from "../db/client.js";
import { getQueue } from "../db/queue.js";
import { getKv } from "../db/kv.js";
import { getProjectRepo, getTaskRepo, getWorkflowRepo, getConversationRepo, getMemoryRepo } from "../domain/repos.js";
import { getTelegramAccountRepo, type TelegramAccount } from "../domain/telegram.js";
import { getUserRepo } from "../auth/users.js";
import type { ModelProvider } from "../domain/entities.js";
import { getAgentRepo } from "../agents/agent-repo.js";
import { getRunRepo, getCostRepo, getAuditRepo, getNotificationRepo } from "../observability/repos.js";
import { getSkillRepo, SkillRegistry } from "../skills/registry.js";
import { getModelRepo, getProviderRepo } from "../ai/model-repo.js";
import { providerRegistry, ProviderRegistry } from "../ai/provider-registry.js";
import { modelRouter, ModelRouter } from "../ai/model-router.js";
import { contextEngine, ContextEngine } from "../ai/context-engine.js";
import { toolRegistry, ToolRegistry } from "../tools/registry.js";
import { resolveGitHubService } from "../github/registry.js";
import { resolveTelegramService } from "../integrations/telegram.js";
import { TelegramBot } from "../integrations/telegram-bot.js";
import { TelegramRuntime, type TelegramMode, type TelegramRuntimeStatus } from "../integrations/telegram-runtime.js";
import { getEnv } from "../config/env.js";
import { memoryResolver, MemoryResolver } from "../memory/index.js";
import { AgentRouter } from "../agents/router.js";
import { AgentRunner } from "../agents/runner.js";
import { AgentGenerator } from "../agents/generator.js";
import { AgentManager } from "../agents/manager.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { Worker } from "../workers/worker.js";
import { logger } from "../logger.js";
import type { IGitHubService } from "../github/types.js";

/**
 * Composition root — constructs and wires the whole runtime. Every service/domain
 * object is created here exactly once and injected into consumers. The HTTP
 * server and worker(s) share this single container.
 */
export class Container {
  readonly db = getDb();
  readonly queue = getQueue();
  readonly kv = getKv();

  readonly userRepo = getUserRepo();
  readonly projectRepo = getProjectRepo();
  readonly taskRepo = getTaskRepo();
  readonly workflowRepo = getWorkflowRepo();
  readonly conversationRepo = getConversationRepo();
  readonly memoryRepo = getMemoryRepo();
  readonly telegramAccountRepo = getTelegramAccountRepo();
  readonly agentRepo = getAgentRepo();
  readonly runRepo = getRunRepo();
  readonly costRepo = getCostRepo();
  readonly auditRepo = getAuditRepo();
  readonly notificationRepo = getNotificationRepo();
  readonly skillRepo = getSkillRepo();
  readonly modelRepo = getModelRepo();
  readonly providerRepo = getProviderRepo();

  readonly skillsRegistry = new SkillRegistry(this.skillRepo);
  readonly providerRegistry: ProviderRegistry = providerRegistry;
  readonly modelRouter: ModelRouter = modelRouter;
  readonly contextEngine: ContextEngine = contextEngine;
  readonly toolRegistry: ToolRegistry = toolRegistry;
  readonly github: IGitHubService = resolveGitHubService();
  readonly telegram = resolveTelegramService();
  readonly memoryResolver: MemoryResolver = memoryResolver;
  readonly agentRouter = new AgentRouter();

  /** Request human approval. In production wired to Telegram; in sim auto-approve/notify. */
  approvalChannel: (action: string, detail: Record<string, unknown>) => Promise<boolean> = async (action, detail) => {
    logger.info(`approval requested (auto-granted in dev/sim): ${action}`, detail);
    await this.notificationRepo.create({
      severity: "warning",
      title: "Approval requested",
      message: action,
      projectId: (detail as { projectId?: string }).projectId,
    });
    return true;
  };

  readonly agentRunner: AgentRunner;
  readonly workflowEngine: WorkflowEngine;
  readonly agentManager: AgentManager;
  readonly worker: Worker;

  constructor() {
    this.agentRunner = new AgentRunner({
      runRepo: this.runRepo,
      costRepo: this.costRepo,
      toolRegistry: this.toolRegistry,
      skillsRegistry: this.skillsRegistry,
      modelRepo: this.modelRepo,
      providerRepo: this.providerRepo,
      providerRegistry: this.providerRegistry,
      modelRouter: this.modelRouter,
      contextEngine: this.contextEngine,
      github: this.github,
      requestApproval: (a, d) => this.approvalChannel(a, d),
    });
    this.workflowEngine = new WorkflowEngine({
      agentRepo: this.agentRepo,
      agentRunner: this.agentRunner,
      toolRegistry: this.toolRegistry,
      github: this.github,
      requestApproval: (a, d) => this.approvalChannel(a, d),
    });
    const agentGenerator = new AgentGenerator(this.agentRepo, this.skillRepo, this.modelRepo);
    this.agentManager = new AgentManager({
      projectRepo: this.projectRepo,
      taskRepo: this.taskRepo,
      workflowRepo: this.workflowRepo,
      agentRepo: this.agentRepo,
      runRepo: this.runRepo,
      costRepo: this.costRepo,
      auditRepo: this.auditRepo,
      notificationRepo: this.notificationRepo,
      agentRunner: this.agentRunner,
      workflowEngine: this.workflowEngine,
      agentRouter: this.agentRouter,
      agentGenerator,
      skillsRepo: this.skillRepo,
      modelRepo: this.modelRepo,
      providerRepo: this.providerRepo,
      github: this.github,
    });
    this.worker = new Worker({
      queue: this.queue,
      agentManager: this.agentManager,
      agentRunner: this.agentRunner,
      workflowRepo: this.workflowRepo,
      projectRepo: this.projectRepo,
      taskRepo: this.taskRepo,
      github: this.github,
      telegram: this.telegram,
      notificationRepo: this.notificationRepo,
      logger: logger.child({ component: "worker" }),
    });
  }

  async ensureSeed(): Promise<void> {
    // Seed built-in skills and default models once.
    this.skillRepo.seedBuiltIns();
    // Bootstrap default providers (mock unless real keys exist).
    await this.providerRegistry.bootDefault();
    // Persist the default providers so the API/UI can list/manage them.
    this.seedDefaultProviders();
    // Load the mock provider + default models into the registry for routing.
    this.seedDefaultModels();
    logger.info("container seeded");
  }

  /* ------------------------------------------------------------------ *
   * Telegram bot wiring
   *
   * The platform can receive Telegram updates two ways: a webhook (needs a
   * public HTTPS URL Telegram can reach) or long polling (`getUpdates`, needs
   * only a token). `TelegramRuntime` picks between them, keeps the
   * registration in sync, owns the poller(s), and answers the
   * "why is my bot silent" question with real diagnostics instead of a
   * boolean.
   * ------------------------------------------------------------------ */

  /**
   * Build a bot bound to a specific Telegram service (the operator's global token
   * or a user's own bot). Passing the account makes the bot *scoped*: it answers
   * only its owner's paired chat and only sees that owner's projects.
   */
  telegramBotFor(service = this.telegram, account?: TelegramAccount): TelegramBot {
    const access = account
      ? {
          current: () => {
            // Read live: pairing happens while this bot is already running.
            const live = this.telegramAccountRepo.findById(account.id)?.data ?? account;
            return { ownerChatId: live.chatId, pairCode: live.pairCode };
          },
          link: (chatId: string) => {
            const live = this.telegramAccountRepo.findById(account.id)?.data;
            if (!live) return;
            this.telegramAccountRepo.upsert({
              ...live,
              chatId,
              accountId: live.accountId ?? chatId,
              pairCode: undefined,
              lastError: undefined,
              updatedAt: new Date().toISOString(),
            });
          },
        }
      : undefined;
    return new TelegramBot({
      telegram: service,
      userId: account?.userId,
      access,
      projectRepo: this.projectRepo,
      taskRepo: this.taskRepo,
      workflowRepo: this.workflowRepo,
      conversationRepo: this.conversationRepo,
      agentRepo: this.agentRepo,
      runRepo: this.runRepo,
      agentManager: this.agentManager,
      github: this.github,
      modelRepo: this.modelRepo,
      skillRepo: this.skillRepo,
      memoryRepo: this.memoryRepo,
      queue: this.queue,
      logger: logger.child({ component: "telegram-bot" }),
      runtimeStatus: () => this.telegramRuntime?.status(),
    });
  }

  readonly telegramRuntime: TelegramRuntime = new TelegramRuntime({
    telegram: this.telegram,
    createBot: (service, account) => this.telegramBotFor(service, account),
    telegramAccountRepo: {
      findMany: () => this.telegramAccountRepo.findMany(),
      upsert: (account) => this.telegramAccountRepo.upsert(account),
    },
    state: this.kv,
    logger,
    // TELEGRAM_MODE=auto (default): webhook when a public HTTPS URL is usable,
    // long polling otherwise. A token alone is enough to bring the bot up —
    // `ENABLE_TELEGRAM` used to gate *receiving*, which silently disabled every
    // bot whose owner only pasted a token. `off` is the explicit opt-out.
    mode: getEnv().TELEGRAM_MODE,
    pollTimeoutSec: getEnv().TELEGRAM_POLL_TIMEOUT,
    webhookSecret: getEnv().TELEGRAM_WEBHOOK_SECRET,
  });

  /** Bring the receive path up (webhook registration and/or long polling). */
  async startTelegram(baseOverride?: string): Promise<TelegramRuntimeStatus> {
    const status = await this.telegramRuntime.start(baseOverride);
    await this.telegramRuntime.syncAccountPollers().catch(() => undefined);
    if (status.transport === "polling") {
      logger.info("Telegram bot is receiving updates via long polling", { bot: status.botUsername });
    } else if (status.transport === "webhook") {
      logger.info("Telegram bot is receiving updates via webhook", { url: status.webhookUrl });
    } else if (status.note) {
      logger.warn(`Telegram receive path inactive: ${status.note}`, { fixes: status.fixes });
    }
    return status;
  }

  async stopTelegram(): Promise<void> {
    await this.telegramRuntime.stop();
  }

  telegramStatus(): TelegramRuntimeStatus {
    return this.telegramRuntime.status();
  }

  /**
   * Register the global bot's webhook with Telegram when a public HTTPS URL is
   * usable. Kept for back-compat (startup + status polling call it); it now
   * delegates to the runtime, which also starts long polling when a webhook
   * is not an option. Previously this returned early whenever
   * `ENABLE_TELEGRAM` was unset — which left a configured, valid bot token
   * with no receive path at all: the classic "bot never replies".
   */
  async setupTelegramWebhook(baseOverride?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const status = await this.telegramRuntime.start(baseOverride);
    if (status.transport === "webhook") return { ok: true, url: status.webhookUrl };
    if (status.transport === "polling") return { ok: false, url: status.webhookUrl, error: `webhook unavailable (${status.webhookError ?? "no public HTTPS URL"}); long polling is active instead` };
    return { ok: false, url: status.webhookUrl, error: status.webhookError ?? status.note ?? "Telegram is not receiving updates" };
  }

  /**
   * Heal the receive path once a public HTTPS base URL has been observed from a
   * real request (e.g. the Arena preview host). Safe to call from request
   * handlers: it no-ops when nothing changed.
   */
  async healTelegramWebhook(baseOverride?: string): Promise<void> {
    await this.telegramRuntime.start(baseOverride);
    await this.telegramRuntime.syncAccountPollers().catch(() => undefined);
  }

  /** Live diagnostics: token, webhook registration, polling state, fixes. */
  async telegramDiagnostics(force = true): Promise<TelegramRuntimeStatus> {
    return this.telegramRuntime.diagnostics(force);
  }

  private seedDefaultProviders(): void {
    if (this.providerRepo.count() > 0) return;
    const now = new Date().toISOString();
    const defaults: ModelProvider[] = [
      { id: "provider-openai", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", secretRef: "OPENAI_API_KEY", authType: "bearer", apiFormat: "openai", timeoutMs: 60000, maxTokensDefault: 4096, defaultTemperature: 0.3, rateLimitPerMinute: 200, active: !!process.env.OPENAI_API_KEY, createdAt: now, updatedAt: now },
      { id: "provider-anthropic", name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com", secretRef: "ANTHROPIC_API_KEY", authType: "api-key", apiFormat: "anthropic", timeoutMs: 60000, maxTokensDefault: 4096, defaultTemperature: 0.3, rateLimitPerMinute: 200, active: !!process.env.ANTHROPIC_API_KEY, createdAt: now, updatedAt: now },
      { id: "provider-gemini", name: "Google Gemini", type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", secretRef: "GEMINI_API_KEY", authType: "api-key", apiFormat: "gemini", timeoutMs: 60000, maxTokensDefault: 4096, defaultTemperature: 0.3, rateLimitPerMinute: 200, active: !!process.env.GEMINI_API_KEY, createdAt: now, updatedAt: now },
      { id: "provider-mock", name: "Mock AI", type: "mock", secretRef: undefined, authType: "none", apiFormat: "custom", timeoutMs: 60000, maxTokensDefault: 4096, defaultTemperature: 0.3, rateLimitPerMinute: 1000, active: true, createdAt: now, updatedAt: now },
    ];
    for (const p of defaults) this.providerRepo.upsert(p);
  }

  private seedDefaultModels(): void {
    const existing = this.modelRepo.count();
    if (existing > 0) return;
    const now = new Date().toISOString();
    const defaults = [
      { modelId: "mock-fast", displayName: "Mock Fast", providerId: "provider-mock", priority: 1, fallbackPriority: 10, caps: { vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true } },
      { modelId: "mock-strong", displayName: "Mock Strong", providerId: "provider-mock", priority: 2, fallbackPriority: 5, caps: { vision: true, tools: true, structuredOutput: true, code: true, reasoning: true, streaming: true } },
      { modelId: "mock-reasoning", displayName: "Mock Reasoning", providerId: "provider-mock", priority: 3, fallbackPriority: 1, caps: { vision: false, tools: true, structuredOutput: true, code: true, reasoning: true, streaming: true } },
    ];
    for (const d of defaults) {
      this.modelRepo.upsert({
        id: `model-${d.modelId}`,
        providerId: d.providerId,
        modelId: d.modelId,
        displayName: d.displayName,
        contextWindow: 128000,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        capabilities: d.caps,
        active: true,
        priority: d.priority,
        fallbackPriority: d.fallbackPriority,
        tags: ["mock"],
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}

let container: Container | null = null;

export function getContainer(): Container {
  if (!container) {
    container = new Container();
  }
  return container;
}
