import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Container } from "../app/container.js";
import { TelegramBot } from "../integrations/telegram-bot.js";
import { MockTelegramService, validateTelegramWebhookUrl, setTelegramWebhook, getPublicBaseUrl, getTelegramWebhookUrl } from "../integrations/telegram.js";
import { logger } from "../logger.js";
import { freshDb } from "./test-helpers.js";

let container: Container;
let telegram: MockTelegramService;
let bot: TelegramBot;
let cleanup: () => void;

async function boot(): Promise<void> {
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  telegram = new MockTelegramService();
  bot = new TelegramBot({
    telegram,
    projectRepo: container.projectRepo,
    taskRepo: container.taskRepo,
    workflowRepo: container.workflowRepo,
    conversationRepo: container.conversationRepo,
    agentRepo: container.agentRepo,
    runRepo: container.runRepo,
    agentManager: container.agentManager,
    github: container.github,
    modelRepo: container.modelRepo,
    skillRepo: container.skillRepo,
    memoryRepo: container.memoryRepo,
    queue: container.queue,
    logger,
  });
}

beforeEach(async () => {
  await boot();
});

afterEach(() => {
  cleanup?.();
});

function lastSent(): { chatId: string; text: string; inlineKeyboard?: Array<Array<{ text: string; callback_data?: string }>> } {
  return telegram.sent[telegram.sent.length - 1] as unknown as { chatId: string; text: string; inlineKeyboard?: Array<Array<{ text: string; callback_data?: string }>> };
}

describe("Telegram bot (project-aware, keyboard-driven)", () => {
  it("replies to /start with a main menu keyboard", async () => {
    await bot.handle({ update_id: 1, message: { chat: { id: 777 }, from: { id: 123 }, text: "/start" } });
    const sent = lastSent();
    expect(sent.chatId).toBe("777");
    expect(sent.text).toContain("CodeVia");
    const flat = (sent.inlineKeyboard ?? []).flat();
    expect(flat.map((b) => b.text)).toContain("📚 Projects");
    expect(flat.map((b) => b.text)).toContain("🤖 Agents");
    expect(flat.map((b) => b.text)).toContain("🧠 Models");
  });

  it("opens a project menu when an inline project button is pressed (callback_query)", async () => {
    const project = await container.agentManager.createProject({
      name: "Storefront",
      configRepo: "acme/storefront",
      description: "Demo storefront",
    });
    // BUG before: callback queries returned no chatId, so the bot never replied.
    await bot.handle({
      update_id: 2,
      callback_query: {
        id: "cb1",
        data: `project:${project.id}`,
        from: { id: 123 },
        message: { chat: { id: 777 }, message_id: 10 },
      },
    });
    const sent = lastSent();
    expect(sent.chatId).toBe("777");
    expect(sent.text).toContain("Storefront");
    const flat = (sent.inlineKeyboard ?? []).flat();
    expect(flat.map((b) => b.text)).toContain("⬆️ Run Task");
    expect(flat.map((b) => b.text)).toContain("📊 Status");
    expect(flat.map((b) => b.text)).toContain("📦 GitHub");
  });

  it("creates + queues a task from a natural-language request on the active project", async () => {
    const project = await container.agentManager.createProject({
      name: "Storefront",
      configRepo: "acme/storefront",
      description: "Demo storefront",
    });
    // Select the project (activates state for this chat).
    await bot.handle({
      update_id: 3,
      callback_query: {
        id: "cb2",
        data: `project:${project.id}`,
        from: { id: 123 },
        message: { chat: { id: 777 }, message_id: 10 },
      },
    });
    const before = container.taskRepo.byProject(project.id).length;

    await bot.handle({ update_id: 4, message: { chat: { id: 777 }, from: { id: 123 }, text: "Add pagination to the API" } });

    const tasks = container.taskRepo.byProject(project.id);
    expect(tasks.length).toBe(before + 1);
    expect(tasks[0].title).toBe("Add pagination to the API");
    // A job must have been enqueued so the worker actually runs the task.
    const jobs = container.db.all<{ id: string; type: string; status: string }>("SELECT id, type, status FROM jobs WHERE type = 'agent.run'");
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.some((j) => j.status === "pending")).toBe(true);
    const sent = lastSent();
    expect(sent.text).toContain("Task created & queued");
    expect(sent.text).toContain("Add pagination to the API");
  });

  it("shows status when the project status action is pressed", async () => {
    const project = await container.agentManager.createProject({
      name: "Storefront",
      configRepo: "acme/storefront",
      description: "Demo storefront",
    });
    await bot.handle({
      update_id: 5,
      callback_query: {
        id: "cb3",
        data: `action:status:${project.id}`,
        from: { id: 123 },
        message: { chat: { id: 777 }, message_id: 10 },
      },
    });
    const sent = lastSent();
    expect(sent.text).toContain("Status");
    expect(sent.text).toContain("Storefront");
  });

  it("rejects HTTP/localhost webhook URLs (Telegram requires HTTPS)", () => {
    expect(validateTelegramWebhookUrl("http://localhost:8080/integrations/telegram/webhook").ok).toBe(false);
    expect(validateTelegramWebhookUrl("http://example.com/integrations/telegram/webhook").ok).toBe(false);
    expect(validateTelegramWebhookUrl("https://localhost:8080/integrations/telegram/webhook").ok).toBe(false);
    expect(validateTelegramWebhookUrl("https://myapp.up.railway.app/integrations/telegram/webhook").ok).toBe(true);
  });

  it("does not attempt setWebhook with an invalid URL (fails fast with a friendly error)", async () => {
    const res = await setTelegramWebhook("token:abc", "http://localhost:8080/integrations/telegram/webhook");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/HTTPS/i);
  });

  it("derives an HTTPS webhook URL from the real forwarded host/proto", () => {
    // Behind a proxy / the Arena preview host, the request carries the public
    // host + proto — we must use it instead of the http://localhost default.
    expect(getPublicBaseUrl("8080-codevia.e2b.app", "https")).toBe("https://8080-codevia.e2b.app");
    expect(getTelegramWebhookUrl("8080-codevia.e2b.app", "https")).toBe("https://8080-codevia.e2b.app/integrations/telegram/webhook");
    // A real deployment with PUBLIC_WEB_BASE_URL set wins over the request host.
    expect(validateTelegramWebhookUrl(getTelegramWebhookUrl("8080-codevia.e2b.app", "https")).ok).toBe(true);
  });
});

describe("Telegram bot — real-world command handling", () => {
  it("answers /start@BotName in groups (Telegram appends the bot username)", async () => {
    await bot.handle({
      update_id: 20,
      message: { chat: { id: -100, type: "supergroup" }, from: { id: 123, username: "dev" }, text: "/start@CodeViaBot" },
    });
    const sent = lastSent();
    expect(sent.chatId).toBe("-100");
    expect(sent.text).toContain("CodeVia");
  });

  it("auto-selects the only project, so a plain message runs without menu taps", async () => {
    await container.agentManager.createProject({ name: "Storefront", configRepo: "acme/storefront", description: "Demo storefront" });
    const before = container.taskRepo.findMany().length;
    await bot.handle({
      update_id: 21,
      message: { chat: { id: 888 }, from: { id: 123 }, text: "چرا لاگین بعد از آخرین کامیت خراب شده؟" },
    });
    expect(container.taskRepo.findMany().length).toBe(before + 1);
    const sent = lastSent();
    expect(sent.text).toContain("Task created & queued");
  });

  it("tells the user their ids (/id) — the AccountId the web UI asks for", async () => {
    await bot.handle({
      update_id: 22,
      message: { chat: { id: 555010, type: "private" }, from: { id: 555010, username: "hooman" }, text: "/id" },
    });
    const sent = lastSent();
    expect(sent.text).toContain("555010");
    expect(sent.text).toContain("@hooman");
  });

  it("reports how it receives messages on /ping", async () => {
    const withStatus = new TelegramBot({
      ...botDeps(),
      runtimeStatus: () =>
        ({ transport: "polling", mode: "auto", enabled: true, fixes: [], webhookUrl: "https://x/integrations/telegram/webhook" }) as never,
    });
    await withStatus.handle({ update_id: 23, message: { chat: { id: 777 }, from: { id: 1 }, text: "/ping" } });
    const sent = lastSent();
    expect(sent.text).toContain("polling");
    expect(sent.text).toMatch(/self-check/i);
  });

  it("answers with the error instead of going silent when a handler throws", async () => {
    const broken = new TelegramBot({ ...botDeps(), projectRepo: { findMany() { throw new Error("db is locked"); }, findById() { throw new Error("db is locked"); } } as never });
    await broken.handle({ update_id: 24, message: { chat: { id: 777 }, from: { id: 1 }, text: "/projects" } });
    const sent = lastSent();
    expect(sent.text).toContain("db is locked");
    expect(sent.text).toContain("Something went wrong");
  });

  it("cancels queued tasks on /stop", async () => {
    const project = await container.agentManager.createProject({ name: "Storefront", configRepo: "acme/storefront", description: "Demo storefront" });
    const task = container.agentManager.createTask({ projectId: project.id, title: "queued thing" });
    container.taskRepo.upsert({ ...task, status: "queued" }, { projectId: project.id });
    await bot.handle({ update_id: 25, message: { chat: { id: 777 }, from: { id: 1 }, text: "/stop" } });
    expect(container.taskRepo.findById(task.id)?.data.status).toBe("cancelled");
  });

  function botDeps() {
    return {
      telegram,
      projectRepo: container.projectRepo,
      taskRepo: container.taskRepo,
      workflowRepo: container.workflowRepo,
      conversationRepo: container.conversationRepo,
      agentRepo: container.agentRepo,
      runRepo: container.runRepo,
      agentManager: container.agentManager,
      github: container.github,
      modelRepo: container.modelRepo,
      skillRepo: container.skillRepo,
      memoryRepo: container.memoryRepo,
      queue: container.queue,
      logger,
    };
  }
});
