import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Container } from "../app/container.js";
import { TelegramBot, type TelegramBotAccess } from "../integrations/telegram-bot.js";
import { MockTelegramService } from "../integrations/telegram.js";
import { logger } from "../logger.js";
import { freshDb } from "./test-helpers.js";

/**
 * "Every user has their own bot": the token comes from Settings (never an env
 * var), so the bot must (a) answer only the chat its owner linked with a pairing
 * code, and (b) show only that owner's projects. Both are covered here against
 * the in-memory Bot API double.
 */

let container: Container;
let telegram: MockTelegramService;
let cleanup: () => void;

/** A pairing state we can mutate, exactly like the account row does in production. */
function makeAccess(initial: { ownerChatId?: string; pairCode?: string } = {}): TelegramBotAccess & { state: { ownerChatId?: string; pairCode?: string } } {
  const state = { ...initial };
  return {
    state,
    current: () => ({ ...state }),
    link: (chatId: string) => {
      state.ownerChatId = chatId;
      state.pairCode = undefined;
    },
  };
}

async function boot(): Promise<void> {
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  telegram = new MockTelegramService();
}

function botFor(opts: { userId?: string; access?: TelegramBotAccess } = {}): TelegramBot {
  return new TelegramBot({
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
    userId: opts.userId,
    access: opts.access,
  });
}

function msg(chatId: string, text: string, updateId = 1): unknown {
  return { update_id: updateId, message: { chat: { id: chatId, type: "private" }, from: { id: chatId }, text } };
}

type Sent = { chatId: string; text: string; inlineKeyboard?: Array<Array<{ text: string; callback_data?: string }>> };

function lastSent(): Sent {
  return telegram.sent[telegram.sent.length - 1] as unknown as Sent;
}

/** Project names the bot offered — they live on the keyboard buttons, not in the text. */
function buttons(sent: Sent): string {
  return (sent.inlineKeyboard ?? []).flat().map((b) => b.text).join(" | ");
}

async function makeProject(name: string, ownerId?: string): Promise<void> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  await container.agentManager.createProject({
    ownerId,
    name,
    slug,
    description: "",
    configRepo: `acme/${slug}`,
    branch: "main",
  } as never);
}

beforeEach(async () => {
  await boot();
});

afterEach(() => {
  cleanup?.();
});

describe("Per-user Telegram bot (token from Settings)", () => {
  it("refuses an unlinked chat and tells it the pairing code", async () => {
    const access = makeAccess({ pairCode: "AB12CD" });
    const bot = botFor({ userId: "user-a", access });
    await bot.handle(msg("555001", "/start"));
    const sent = lastSent();
    expect(sent.chatId).toBe("555001");
    expect(sent.text).toMatch(/not linked to a chat yet/i);
    expect(sent.text).toContain("/pair AB12CD");
    // …and it did not leak a project menu to a stranger.
    expect(sent.text).not.toMatch(/Projects/);
  });

  it("links the chat that presents the code, then serves it", async () => {
    const access = makeAccess({ pairCode: "AB12CD" });
    const bot = botFor({ userId: "user-a", access });
    await bot.handle(msg("555001", "/pair AB12CD"));
    expect(lastSent().text).toMatch(/Linked/i);
    expect(access.state.ownerChatId).toBe("555001");
    expect(access.state.pairCode).toBeUndefined();

    await bot.handle(msg("555001", "/start"));
    expect(lastSent().text).toContain("CodeVia");
  });

  it("rejects a wrong code and other chats once linked", async () => {
    const access = makeAccess({ pairCode: "AB12CD" });
    const bot = botFor({ userId: "user-a", access });
    await bot.handle(msg("555001", "/pair WRONG9"));
    expect(access.state.ownerChatId).toBeUndefined();
    expect(lastSent().text).toMatch(/not linked to a chat yet/i);

    await bot.handle(msg("555001", "/pair AB12CD"));
    // A second chat cannot ride along on the same bot.
    await bot.handle(msg("999999", "/start"));
    expect(lastSent().text).toMatch(/private CodeVia bot/i);
    expect(telegram.sent.filter((m) => (m as { chatId: string }).chatId === "999999")).toHaveLength(1);
  });

  it("shows a per-user bot only its own projects", async () => {
    await makeProject("Alpha App", "user-a");
    await makeProject("Beta API", "user-b");
    await makeProject("Legacy Shared");

    const mine = botFor({ userId: "user-a", access: makeAccess({ ownerChatId: "555001" }) });
    await mine.handle(msg("555001", "/projects"));
    const offered = buttons(lastSent());
    expect(offered).toMatch(/Alpha App/);
    expect(offered).toMatch(/Legacy Shared/);
    expect(offered).not.toMatch(/Beta API/);
  });

  it("keeps the operator's global bot unscoped", async () => {
    await makeProject("Alpha App", "user-a");
    await makeProject("Beta API", "user-b");
    const global = botFor();
    await global.handle(msg("555001", "/projects"));
    const offered = buttons(lastSent());
    expect(offered).toMatch(/Alpha App/);
    expect(offered).toMatch(/Beta API/);
  });

  it("refuses inline-button callbacks from an unlinked chat", async () => {
    const access = makeAccess({ ownerChatId: "555001", pairCode: undefined });
    const bot = botFor({ userId: "user-a", access });
    await bot.handle({
      update_id: 7,
      callback_query: {
        id: "q1",
        data: "project:list",
        from: { id: "666666" },
        message: { chat: { id: "666666" }, message_id: 3 },
      },
    });
    expect(lastSent().text).toMatch(/private CodeVia bot/i);
  });
});
