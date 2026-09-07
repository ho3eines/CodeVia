import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { TelegramBot } from "../integrations/telegram-bot.js";
import { MockTelegramService } from "../integrations/telegram.js";
import { eventBus, generateCorrelationId } from "../events/bus.js";
import { diffLines, diffSummary } from "../prompts/versions.js";
import { discoverProjectRules, rulesToStrings } from "../agents/rules-discovery.js";
import { logger } from "../logger.js";
import { freshDb } from "./test-helpers.js";

let cleanup: (() => void) | undefined;
let container: Container;
let app: FastifyInstance | undefined;

async function boot(): Promise<FastifyInstance> {
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
  return app;
}

afterEach(async () => {
  container?.githubAutomation.stop();
  if (app) {
    await app.close();
    app = undefined;
  }
  cleanup?.();
});

/* ------------------------------------------------------------------ *
 * Human-in-the-loop approvals
 * ------------------------------------------------------------------ */
describe("approvals — human in the loop", () => {
  beforeEach(async () => {
    await boot();
  });

  it("auto-approve policy grants immediately but keeps an audit trail", async () => {
    container.approvals.setPolicy({ autoApprove: true });
    const ok = await container.approvalChannel("Merge PR #1", { projectId: "p1" });
    expect(ok).toBe(true);
    const list = container.approvals.list();
    expect(list.length).toBe(1);
    expect(list[0].status).toBe("approved");
    expect(list[0].decisionSource).toBe("auto");
    expect(container.auditRepo.findMany().some((a) => a.data.action === "approval.auto_granted")).toBe(true);
  });

  it("blocks until a human approves from the web API and marks the task", async () => {
    container.approvals.setPolicy({ autoApprove: false, timeoutMs: 10_000 });
    const project = await container.agentManager.createProject({ name: "Gate", description: "x", configRepo: "acme/gate" });
    const task = container.agentManager.createTask({ projectId: project.id, title: "Deploy", description: "" });
    container.taskRepo.upsert({ ...task, status: "running" }, { projectId: project.id });

    const pending = container.approvalChannel("Production deploy", { projectId: project.id, taskId: task.id });
    // Let the request persist.
    await new Promise((r) => setTimeout(r, 10));
    const [req] = container.approvals.list({ status: "pending" });
    expect(req).toBeDefined();
    expect(container.taskRepo.findById(task.id)?.data.status).toBe("waiting_for_approval");

    const res = await app!.inject({ method: "POST", url: `/approvals/${req.id}/approve`, payload: { note: "ship it" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");
    expect(await pending).toBe(true);
    expect(container.taskRepo.findById(task.id)?.data.status).toBe("running");

    // Double decision is a conflict.
    const again = await app!.inject({ method: "POST", url: `/approvals/${req.id}/reject` });
    expect(again.statusCode).toBe(409);
  });

  it("rejecting from Telegram inline buttons skips the gated step", async () => {
    container.approvals.setPolicy({ autoApprove: false, timeoutMs: 10_000 });
    const telegram = new MockTelegramService();
    const bot = new TelegramBot({
      telegram,
      projectRepo: container.projectRepo,
      taskRepo: container.taskRepo,
      agentRepo: container.agentRepo,
      runRepo: container.runRepo,
      agentManager: container.agentManager,
      github: container.github,
      approvals: container.approvals,
      queue: container.queue,
      logger,
    });
    const pending = container.approvalChannel("Delete branch main", {});
    await new Promise((r) => setTimeout(r, 10));
    const [req] = container.approvals.list({ status: "pending" });

    // /approvals lists it with buttons
    await bot.handle({ update_id: 1, message: { chat: { id: 5 }, from: { id: 5 }, text: "/approvals" } });
    const listed = telegram.sent[telegram.sent.length - 1] as { text: string; inlineKeyboard?: Array<Array<{ callback_data?: string }>> };
    expect(listed.text).toContain(req.id);
    expect(JSON.stringify(listed.inlineKeyboard)).toContain(`reject:${req.id}`);

    await bot.handle({ update_id: 2, callback_query: { id: "cb", data: `reject:${req.id}`, message: { message_id: 9, chat: { id: 5 } }, from: { id: 5 } } });
    expect(await pending).toBe(false);
    expect(container.approvals.get(req.id)?.status).toBe("rejected");
    expect(container.approvals.get(req.id)?.decisionSource).toBe("telegram");
  });

  it("expires when nobody answers within the policy timeout", async () => {
    container.approvals.setPolicy({ autoApprove: false, timeoutMs: 1000 });
    const ok = await container.approvalChannel("Costly op", {});
    expect(ok).toBe(false);
    expect(container.approvals.list()[0].status).toBe("expired");
  });

  it("pushes pending approvals to the project's Telegram chat with Approve/Reject buttons", async () => {
    container.approvals.setPolicy({ autoApprove: false, timeoutMs: 2000 });
    const project = await container.agentManager.createProject({ name: "TG", description: "x", configRepo: "acme/tg" });
    container.projectRepo.upsert({ ...container.projectRepo.findById(project.id)!.data, telegramChatId: "4242" }, { key: project.slug });
    const mock = container.telegram as MockTelegramService;
    const before = mock.sent.length;
    const p = container.approvalChannel("Merge PR #7", { projectId: project.id });
    await new Promise((r) => setTimeout(r, 20));
    const msg = mock.sent.slice(before).find((m) => m.chatId === "4242");
    expect(msg).toBeDefined();
    expect(JSON.stringify(msg!.inlineKeyboard)).toMatch(/approve:apr-/);
    const [req] = container.approvals.list({ status: "pending" });
    container.approvals.decide(req.id, "approve", { source: "system" });
    expect(await p).toBe(true);
  });

  it("the settings endpoint reads and writes the policy", async () => {
    const set = await app!.inject({ method: "POST", url: "/settings/approval", payload: { autoApprove: false, timeoutMs: 120000 } });
    expect(set.json()).toMatchObject({ autoApprove: false, timeoutMs: 120000 });
    const get = await app!.inject({ method: "GET", url: "/settings/approval" });
    expect(get.json().autoApprove).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * GitHub event automation
 * ------------------------------------------------------------------ */
describe("GitHub event automation", () => {
  beforeEach(async () => {
    await boot();
  });

  it("routes push → QA, PR opened → code reviewer, issue → research, and ignores duplicate deliveries", async () => {
    const project = await container.agentManager.createProject({ name: "Auto", description: "node app", configRepo: "acme/auto" });
    const publish = (name: "github.push" | "github.pull_request" | "github.issue", body: Record<string, unknown>, deliveryId: string) =>
      eventBus.publish(name, { event: name.split(".")[1], body: { repository: { full_name: "acme/auto" }, ...body }, deliveryId }, { correlationId: generateCorrelationId() });

    await publish("github.push", { ref: "refs/heads/main", commits: [{ id: "abc1234", message: "fix login" }] }, "d1");
    await publish("github.pull_request", { action: "opened", pull_request: { number: 12, title: "Add caching" } }, "d2");
    await publish("github.issue", { action: "opened", issue: { number: 3, title: "Crash on start" } }, "d3");
    // Redelivery of d1 must not create another task.
    await publish("github.push", { ref: "refs/heads/main" }, "d1");
    // Unknown repo → nothing.
    await publish("github.push", { repository: { full_name: "other/repo" } }, "d9");

    const tasks = container.taskRepo.byProject(project.id);
    const types = tasks.map((t) => t.agentType).sort();
    expect(types).toEqual(["code-reviewer", "qa-test", "research"]);
    expect(tasks.find((t) => t.agentType === "qa-test")!.title).toContain("main");
    expect(tasks.find((t) => t.agentType === "code-reviewer")!.title).toContain("#12");
    expect(container.queue.stats().pending).toBeGreaterThanOrEqual(3);
    expect(container.auditRepo.findMany().filter((a) => a.data.action === "github.event.routed").length).toBe(3);
  });

  it("the webhook route forwards the delivery id into the event", async () => {
    const project = await container.agentManager.createProject({ name: "Hook", description: "x", configRepo: "acme/hook" });
    const res = await app!.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "push", "x-github-delivery": "uuid-1", "content-type": "application/json" },
      payload: { repository: { full_name: "acme/hook" }, ref: "refs/heads/dev" },
    });
    expect(res.statusCode).toBe(202);
    const tasks = container.taskRepo.byProject(project.id);
    expect(tasks.length).toBe(1);
    expect(tasks[0].input.deliveryId).toBe("uuid-1");
  });
});

/* ------------------------------------------------------------------ *
 * Prompt versioning
 * ------------------------------------------------------------------ */
describe("prompt versioning", () => {
  beforeEach(async () => {
    await boot();
  });

  it("creates a version per edit, diffs against current, restores without rewriting history", async () => {
    const project = await container.agentManager.createProject({ name: "PV", description: "x", configRepo: "acme/pv" });
    const agent = container.agentRepo.byProject(project.id)[0];
    const v0 = agent.systemPrompt;

    let res = await app!.inject({ method: "PATCH", url: `/agents/${agent.id}`, payload: { systemPrompt: v0 + "\nAlways write tests." } });
    expect(res.statusCode).toBe(200);
    res = await app!.inject({ method: "PATCH", url: `/agents/${agent.id}`, payload: { systemPrompt: v0 + "\nAlways write tests.\nNever commit secrets." } });

    const versions = (await app!.inject({ method: "GET", url: `/agents/${agent.id}/prompt-versions` })).json();
    expect(versions.map((v: { version: number }) => v.version)).toEqual([1, 2, 3]);
    expect(versions[2].current).toBe(true);

    const diff = (await app!.inject({ method: "GET", url: `/agents/${agent.id}/prompt-versions/diff?from=1&to=current` })).json();
    expect(diff.summary.added).toBe(2);
    expect(diff.lines.some((l: { type: string; text: string }) => l.type === "added" && l.text === "Never commit secrets.")).toBe(true);

    const restored = (await app!.inject({ method: "POST", url: `/agents/${agent.id}/prompt-versions/1/restore` })).json();
    expect(restored.agent.systemPrompt).toBe(v0);
    expect(restored.version.version).toBe(4);
    expect(restored.version.derivedFrom).toBe(1);
    expect(container.promptVersionRepo.forAgent(agent.id).length).toBe(4);
  });

  it("diffLines produces a minimal LCS line diff", () => {
    const d = diffLines("a\nb\nc", "a\nc\nd");
    expect(diffSummary(d)).toEqual({ added: 1, removed: 1, unchanged: 2 });
  });
});

/* ------------------------------------------------------------------ *
 * Rules discovery + budget + dry run
 * ------------------------------------------------------------------ */
describe("rules discovery, budget control, dry run", () => {
  beforeEach(async () => {
    await boot();
  });

  it("derives project rules from CONTRIBUTING/.editorconfig/package.json/CI and injects them on onboarding", async () => {
    const mock = container.github as unknown as { seedRepo(o: string, n: string, opts: { files: Array<{ path: string; content: string }> }): void };
    mock.seedRepo("acme", "rules", {
      files: [
        { path: "CONTRIBUTING.md", content: "# Contributing\n- Use conventional commits for every change.\n- Open a PR against develop, never main.\n" },
        { path: ".editorconfig", content: "root = true\n[*]\nindent_style = space\nindent_size = 2\nend_of_line = lf\n" },
        { path: "package.json", content: JSON.stringify({ type: "module", engines: { node: ">=20" }, scripts: { test: "vitest run", lint: "eslint ." } }) },
        { path: ".github/workflows/ci.yml", content: "name: ci\n" },
        { path: "CODEOWNERS", content: "* @acme/core\nsrc/api @acme/backend\n" },
      ],
    });
    const project = await container.agentManager.createProject({ name: "Rules", description: "node service", configRepo: "acme/rules" });
    const rules = (await app!.inject({ method: "GET", url: `/projects/${project.id}/rules` })).json() as Array<{ category: string; discovered: boolean; text: string }>;
    const discovered = rules.filter((r) => r.discovered);
    const all = discovered.map((r) => r.text).join("\n");
    expect(all).toContain("conventional commits");
    expect(all).toContain("space indentation");
    expect(all).toContain("npm test");
    expect(all).toContain("CODEOWNERS");
    expect(all).toContain("CI is defined");
    expect(new Set(discovered.map((r) => r.category))).toContain("testing");

    // Manual rules survive re-onboarding, discovered ones are regenerated (not duplicated).
    await app!.inject({ method: "PUT", url: `/projects/${project.id}/rules`, payload: { rules: ["Use Persian for user-facing strings."] } });
    await app!.inject({ method: "POST", url: `/projects/${project.id}/onboard`, payload: {} });
    const after = (await app!.inject({ method: "GET", url: `/projects/${project.id}/rules` })).json() as Array<{ discovered: boolean; text: string }>;
    expect(after.filter((r) => !r.discovered).map((r) => r.text)).toEqual(["Use Persian for user-facing strings."]);
    expect(after.filter((r) => r.discovered).length).toBe(discovered.length);

    // The agent context carries the rules.
    const agent = container.agentRepo.byProject(project.id)[0];
    const ctx = await container.contextEngine.build({ project: container.projectRepo.findById(project.id)!.data, agent, skills: container.skillsRegistry, github: container.github });
    expect(ctx.context).toContain("Use Persian for user-facing strings.");
    expect(ctx.context).toContain("conventional commits");
  });

  it("rulesToStrings groups by category", async () => {
    const out = rulesToStrings([
      { category: "git", text: "a", source: "x" },
      { category: "git", text: "b", source: "x" },
      { category: "testing", text: "c", source: "y" },
    ]);
    expect(out.length).toBe(2);
    expect(out[0]).toContain("## Git rules");
    void discoverProjectRules;
  });

  it("stops a run that exceeds the project duration budget", async () => {
    const project = await container.agentManager.createProject({ name: "Budget", description: "x", configRepo: "acme/budget" });
    const stored = container.projectRepo.findById(project.id)!.data;
    container.projectRepo.upsert({ ...stored, settings: { ...stored.settings, budget: { ...stored.settings.budget, maxDurationMs: 1 } } }, { key: stored.slug });
    const task = container.agentManager.createTask({ projectId: project.id, title: "Slow thing", description: "", agentType: "backend-developer" });
    await new Promise((r) => setTimeout(r, 5));
    await expect(container.agentManager.runTask(task.id)).rejects.toThrow(/Budget exceeded/);
    const run = container.runRepo.byProject(project.id)[0];
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/duration/);
  });

  it("dry run previews the plan, writes and approvals without creating a task or run", async () => {
    const project = await container.agentManager.createProject({ name: "Dry", description: "x", configRepo: "acme/dry" });
    const res = await app!.inject({ method: "POST", url: `/projects/${project.id}/dry-run`, payload: { title: "Fix login bug", description: "login broken after last commit", agentType: "backend-developer" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.simulation).toBe(true);
    expect(body.agent.type).toBe("backend-developer");
    expect(body.plan.length).toBeGreaterThan(3);
    expect(body.writes.some((w: { tool: string }) => w.tool === "write_file")).toBe(true);
    expect(body.approvalsNeeded).toBeGreaterThan(0);
    expect(container.taskRepo.byProject(project.id).length).toBe(0);
    expect(container.runRepo.byProject(project.id).length).toBe(0);
  });
});
