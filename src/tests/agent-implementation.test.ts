import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Container } from "../app/container.js";
import { freshDb } from "./test-helpers.js";
import type { AgentType, Model, Project } from "../domain/entities.js";
import type { ChatRequest, ChatResponse, IModelProvider } from "../ai/types.js";
import { MockGitHubService } from "../github/mock-service.js";
import type { GithubCheck } from "../github/types.js";
import { applyFileEdits, cleanRepoPath, parseBreakdown } from "../agents/implementation.js";
import { extendContent } from "../agents/context.js";

let fx: ReturnType<typeof freshDb>;
let c: Container;
let p: Project;
let gh: MockGitHubService;
const repo = { owner: "acme", name: "implementation" };
let requests: ChatRequest[];
let items: Array<{ agentType: AgentType; title: string; description: string; files: string[] }>;
let generate: (req: ChatRequest) => Promise<string> | string;
let usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 };

async function realModel(name = "preferred", overrides: Partial<Model> = {}): Promise<Model> {
  const provider = c.providerRepo.create({ name, type: "openai", authType: "none", apiFormat: "openai", timeoutMs: 1000, maxTokensDefault: 8000, defaultTemperature: 0, rateLimitPerMinute: 100, active: true });
  const model = c.modelRepo.create({ providerId: provider.id, modelId: name, displayName: name, contextWindow: 128000, inputCostPer1k: 0.1, outputCostPer1k: 0.2, capabilities: { code: true, reasoning: true, structuredOutput: true, tools: false, streaming: false, vision: false }, active: true, priority: 1, fallbackPriority: 1, tags: [], ...overrides });
  const runtime: IModelProvider = {
    id: provider.id, type: "openai", name,
    chat: async (req): Promise<ChatResponse> => {
      requests.push(req);
      const system = req.messages[0].content;
      const content = system.includes("business analyst writing") ? "Requirements: implement login using the established API contract; add CI coverage."
        : system.includes("engineering manager") || system.includes("single-agent implementation") ? JSON.stringify(items)
        : await generate(req);
      return { content, finishReason: "stop", usage, costUsd: 0, modelId: req.modelId, providerId: provider.id };
    },
    health: async () => true, listModels: async () => [], resolveApiKey: () => undefined,
  };
  c.providerRegistry.register(runtime);
  return model;
}

function code(req: ChatRequest): string {
  const text = req.messages[1].content;
  if (text.includes("--- START CURRENT FILE ---")) return JSON.stringify({ edits: [{ oldText: "export const answer = 1;", newText: "export const answer = 2;" }] });
  const path = text.match(/complete content of "([^"]+)"/)?.[1] ?? "file";
  return path.includes("Page") ? "export const client = 'LOGIN_API_CONTRACT';\n" : "// LOGIN_API_CONTRACT\nexport const answer = 1;\n";
}

beforeEach(async () => {
  fx = freshDb();
  c = new Container();
  await c.ensureSeed();
  p = await c.agentManager.createProject({ name: "Implementation", description: "A TypeScript application", configRepo: "acme/implementation", capabilities: { languages: ["typescript"], frameworks: ["react"] } });
  gh = c.github as MockGitHubService;
  requests = [];
  items = [{ agentType: "backend-developer", title: "Implement login API", description: "Return the session", files: ["src/server/login.ts"] }];
  generate = code;
  usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 };
});
afterEach(async () => {
  vi.restoreAllMocks();
  c.githubAutomation.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fx.cleanup();
});

const task = (autonomous = true) => c.agentManager.createTask({ projectId: p.id, title: "Add login page and API", description: "Implement the session API and its client", agentType: autonomous ? undefined : "backend-developer", input: autonomous ? { executionMode: "autonomous" } : {} });

describe("grounded implementation pipeline", () => {
  it("honours the agent model, prompt, project prompt, skills, temperature and cost attribution", async () => {
    await realModel("unrelated-first");
    const preferred = await realModel("backend-model", { temperature: 1, omitTemperature: true, maxTokens: 900 });
    const agent = c.agentRepo.byType(p.id, "backend-developer")!;
    c.agentRepo.upsert({ ...agent, systemPrompt: "AGENT_RULE_KEEP_EXISTING", projectPrompt: "PROJECT_PROMPT_SENTINEL", models: { primary: preferred.id, fallbacks: [], specialized: { coding: preferred.id } } }, { projectId: p.id });
    c.projectRepo.upsert({ ...p, settings: { ...p.settings, rules: ["PROJECT_RULE_USE_SESSION_SERVICE"] } }, { key: p.slug });
    const t = task(false);
    const done = await c.agentManager.runTask(t.id);
    expect(done.status).toBe("succeeded");
    expect(requests).toHaveLength(2); // planning and actual codegen; no discarded extra model call
    expect(requests.every((r) => r.modelId === "backend-model" && r.temperature === 1 && r.omitTemperature && r.maxTokens === 900)).toBe(true);
    const prompt = JSON.stringify(requests[1].messages);
    for (const marker of ["AGENT_RULE_KEEP_EXISTING", "PROJECT_PROMPT_SENTINEL", "PROJECT_RULE_USE_SESSION_SERVICE", "[Skill:"]) expect(prompt).toContain(marker);
    const runs = c.runRepo.byTask(t.id);
    expect(runs[0].modelId).toBe(preferred.id);
    expect(runs[0].totalTokens).toBe(40);
    expect(c.costRepo.totals({ projectId: p.id }).calls).toBe(2);
    expect(runs[0].costUsd).toBeCloseTo(0.006);
    expect((await gh.listFiles(repo, "main")).some((f) => f.path === "src/backend-developer.md")).toBe(false);
  });

  it("falls back through the configured real models instead of a mock response", async () => {
    const primary = await realModel("primary-broken");
    const backup = await realModel("backup-working");
    c.providerRegistry.get(primary.providerId)!.chat = async () => { throw new Error("primary offline"); };
    const agent = c.agentRepo.byType(p.id, "backend-developer")!;
    c.agentRepo.upsert({ ...agent, models: { primary: primary.id, fallbacks: [backup.id], specialized: { coding: primary.id } } }, { projectId: p.id });
    const t = task(false);
    expect((await c.agentManager.runTask(t.id)).status).toBe("succeeded");
    expect(requests.every((r) => r.modelId === "backup-working")).toBe(true);
    expect(c.runRepo.byTask(t.id)[0].modelId).toBe(backup.id);
  });

  it("rejects truncated model output before creating any branch or file", async () => {
    const model = await realModel();
    c.providerRegistry.get(model.providerId)!.chat = async (req) => ({ content: "export const unfinished = ", finishReason: "length", usage, modelId: req.modelId, providerId: model.providerId });
    const t = task(false);
    await expect(c.agentManager.runTask(t.id)).rejects.toThrow(/truncated/);
    expect((await gh.listBranches(repo)).filter((b) => b.name.startsWith("agent-"))).toHaveLength(0);
    expect(c.runRepo.byTask(t.id)[0].totalTokens).toBe(20);
  });

  it("generates all five planned files before one atomic commit", async () => {
    items[0].files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
    await realModel();
    const commits = vi.spyOn(gh, "commit");
    const t = task();
    const done = await c.agentManager.runTask(t.id);
    expect(done.status).toBe("succeeded");
    const [pr] = await gh.listPullRequests(repo);
    const writes = commits.mock.calls.filter((call) => call[1] === pr.head);
    expect(writes).toHaveLength(1);
    expect(writes[0][3].map((f) => f.path)).toEqual(items[0].files);
    for (const path of items[0].files) expect(await gh.getFile(repo, path, pr.head)).toBeDefined();
    expect(done.result?.verification).toBe("simulated");
  });

  it("orders backend before frontend, shares its actual code, and verifies the integrated branch", async () => {
    items.unshift({ agentType: "frontend-developer", title: "Implement login page", description: "Consume the login API", files: ["src/ui/LoginPage.tsx"] });
    await realModel();
    const done = await c.agentManager.runTask(task().id);
    expect(done.status).toBe("succeeded");
    const prs = await gh.listPullRequests(repo);
    expect(prs).toHaveLength(1);
    const frontendPrompt = requests.find((r) => r.messages[1].content.includes('complete content of "src/ui/LoginPage.tsx"'))!.messages[1].content;
    expect(frontendPrompt).toContain("LOGIN_API_CONTRACT");
    expect(await gh.getFile(repo, "src/server/login.ts", prs[0].head)).toBeDefined();
    expect(await gh.getFile(repo, "src/ui/LoginPage.tsx", prs[0].head)).toBeDefined();
    const qa = c.runRepo.byProject(p.id).find((r) => r.agentType === "qa-test")!;
    expect(qa.steps.find((s) => s.tool === "run_tests")?.data?.ref).toBe(prs[0].head);
    expect(qa.summary).toContain("no build or tests were executed");
  });

  it("uses role-specific linked repositories and hands the backend contract to the frontend", async () => {
    p = await c.agentManager.createProject({ name: "Multi", description: "TypeScript app", repositories: [{ repo: "acme/config", branch: "main", role: "primary", isConfigRepo: true }, { repo: "acme/api", branch: "develop", role: "backend" }, { repo: "acme/web", branch: "main", role: "frontend" }], capabilities: { platforms: ["web"], languages: ["typescript"] } });
    items.push({ agentType: "frontend-developer", title: "Implement login page", description: "Use the backend contract", files: ["src/ui/LoginPage.tsx"] });
    await realModel();
    const done = await c.agentManager.runTask(task().id);
    expect(done.status).toBe("succeeded");
    const [apiPr] = await gh.listPullRequests({ owner: "acme", name: "api" });
    const [webPr] = await gh.listPullRequests({ owner: "acme", name: "web" });
    expect(apiPr.base).toBe("develop");
    expect(await gh.getFile({ owner: "acme", name: "api" }, "src/server/login.ts", apiPr.head)).toBeDefined();
    expect(await gh.getFile({ owner: "acme", name: "web" }, "src/ui/LoginPage.tsx", webPr.head)).toBeDefined();
    expect(await gh.getFile({ owner: "acme", name: "config" }, "src/server/login.ts", "main")).toBeUndefined();
    const frontend = requests.find((r) => r.messages[1].content.includes('complete content of "src/ui/LoginPage.tsx"'))!.messages[1].content;
    expect(frontend).toContain("acme/api@");
    expect(frontend).toContain("LOGIN_API_CONTRACT");
  });

  it("applies a real QA failure as a patch on the same branch/PR and keeps frontend work", async () => {
    items.push({ agentType: "frontend-developer", title: "Implement login page", description: "Use login API", files: ["src/ui/LoginPage.tsx"] });
    await realModel();
    Object.defineProperty(gh, "kind", { value: "real", configurable: true });
    const checks = vi.fn<() => Promise<GithubCheck[]>>()
      .mockResolvedValueOnce([{ name: "unit", status: "failure", detail: "src/server/login.ts: expected answer 2, got 1" }])
      .mockResolvedValue([{ name: "unit", status: "success" }]);
    Object.assign(gh, { getChecks: checks });
    const done = await c.agentManager.runTask(task().id);
    expect(done.result?.fixLoops).toBe(1);
    expect(done.result?.verification).toBe("passed");
    expect(checks).toHaveBeenCalledTimes(2);
    const prs = await gh.listPullRequests(repo);
    expect(prs).toHaveLength(1);
    expect((await gh.getFile(repo, "src/server/login.ts", prs[0].head))!.content).toContain("answer = 2");
    expect((await gh.getFile(repo, "src/ui/LoginPage.tsx", prs[0].head))!.content).toContain("client");
    expect(await gh.getFile(repo, "src/server/login.ts", "main")).toBeUndefined();
  });

  it("does not run a fix loop when CI is missing or pending", async () => {
    await realModel();
    Object.defineProperty(gh, "kind", { value: "real", configurable: true });
    Object.assign(gh, { getChecks: async () => [] });
    c.projectRepo.upsert({ ...p, settings: { ...p.settings, metadata: { ciWaitMs: 0 } } }, { key: p.slug });
    const t = task();
    await expect(c.agentManager.runTask(t.id)).rejects.toThrow(/Not verified/);
    expect(c.taskRepo.findById(t.id)?.data.status).toBe("failed");
    expect(c.taskRepo.byProject(p.id).some((t) => t.title.startsWith("Fix (attempt"))).toBe(false);
  });

  it("aborts on provider failure instead of committing scaffolds or partial batches", async () => {
    await realModel();
    items[0].files = ["src/first.ts", "src/second.ts"];
    let calls = 0;
    generate = () => { if (++calls === 2) throw new Error("provider offline"); return "export const first = 1;"; };
    const t = task();
    await expect(c.agentManager.runTask(t.id)).rejects.toThrow(/provider offline/);
    expect(await gh.getFile(repo, "src/first.ts", "main")).toBeUndefined();
    expect((await gh.listBranches(repo)).filter((b) => b.name.startsWith("agent-"))).toHaveLength(0);
    expect(c.taskRepo.findMany({ parentId: t.id }).some((r) => r.data.status === "running")).toBe(false);
  });

  it("propagates parent cancellation during codegen before any source write", async () => {
    await realModel();
    let release!: (s: string) => void;
    let started!: () => void;
    const reached = new Promise<void>((r) => { started = r; });
    generate = () => { started(); return new Promise<string>((r) => { release = r; }); };
    const t = task();
    const pending = c.agentManager.runTask(t.id);
    await reached;
    c.taskRepo.upsert({ ...c.taskRepo.findById(t.id)!.data, status: "cancelled" }, { projectId: p.id });
    release("export const answer = 1;");
    expect((await pending).status).toBe("cancelled");
    expect((await gh.listPullRequests(repo))).toHaveLength(0);
    expect(c.taskRepo.findMany({ parentId: t.id }).some((r) => r.data.status === "running")).toBe(false);
  });

  it("retains completed steps and stops a write if cancellation happens during approval", async () => {
    const t = task(false);
    c.approvalChannel = async () => {
      c.taskRepo.upsert({ ...c.taskRepo.findById(t.id)!.data, status: "cancelled" }, { projectId: p.id });
      return true;
    };
    expect((await c.agentManager.runTask(t.id)).status).toBe("cancelled");
    const run = c.runRepo.byTask(t.id)[0];
    expect(run.steps.find((s) => s.tool === "create_branch")?.status).toBe("succeeded");
    expect(run.steps.find((s) => s.tool === "write_file")?.status).toBe("failed");
    expect(await gh.getFile(repo, "src/routes/login.routes.ts", (await gh.listBranches(repo)).find((b) => b.name.startsWith("agent-"))!.name)).toBeUndefined();
  });

  it("charges codegen against the task budget and preserves usage on failure", async () => {
    await realModel();
    usage = { inputTokens: 15000, outputTokens: 10000, totalTokens: 25000 };
    const t = task(false);
    const running = c.agentManager.runTask(t.id);
    await expect(running).rejects.toThrow(/Budget exceeded/);
    await expect(running).rejects.toMatchObject({ retryable: false });
    expect(c.costRepo.totals({ projectId: p.id }).tokens).toBe(25000);
    expect(c.runRepo.byTask(t.id)[0].totalTokens).toBe(25000);
    expect(await gh.listPullRequests(repo)).toHaveLength(0);
  });

  it("never reports a failed writer run as a successful task", async () => {
    c.approvalChannel = async () => false;
    const t = task(false);
    await expect(c.agentManager.runTask(t.id)).rejects.toThrow(/Approval rejected/);
    expect(c.taskRepo.findById(t.id)?.data.status).toBe("failed");
  });

  it("does not use unrelated providers when the assigned real model is disabled", async () => {
    const selected = await realModel("disabled-model");
    await realModel("unrelated-model");
    c.modelRepo.upsert({ ...selected, active: false });
    const agent = c.agentRepo.byType(p.id, "backend-developer")!;
    c.agentRepo.upsert({ ...agent, models: { primary: selected.id, fallbacks: [], specialized: {} } }, { projectId: p.id });
    await expect(c.agentManager.runTask(task(false).id)).rejects.toThrow(/missing or disabled/);
    expect(requests).toHaveLength(0);
  });

  it("does not run code fixes for a GitHub CI network failure", async () => {
    await realModel();
    Object.defineProperty(gh, "kind", { value: "real", configurable: true });
    Object.assign(gh, { getChecks: async () => { throw new Error("CI service unavailable"); } });
    const t = task();
    await expect(c.agentManager.runTask(t.id)).rejects.toThrow(/CI service unavailable/);
    expect(c.taskRepo.findMany({ parentId: t.id }).some((r) => r.data.title.startsWith("Fix (attempt"))).toBe(false);
    expect(c.taskRepo.findById(t.id)?.data.result?.verification).toBe("unverified");
  });

  it("refuses the no-model simulation fallback against a real repository", async () => {
    Object.defineProperty(gh, "kind", { value: "real", configurable: true });
    await expect(c.agentManager.runTask(task().id)).rejects.toThrow(/real model configured/);
    expect(await gh.listPullRequests(repo)).toHaveLength(0);
  });
});

describe("safe source edits", () => {
  it("preserves the complete tail of files larger than the old 24K limit", () => {
    const existing = "export const answer = 1;\n" + "// unchanged\n".repeat(4000) + "export const preservedTail = true;\n";
    const patched = applyFileEdits(existing, JSON.stringify({ edits: [{ oldText: "answer = 1", newText: "answer = 2" }] }));
    expect(patched).toBe(existing.replace("answer = 1", "answer = 2"));
    const simulated = extendContent({ existing, path: "a.ts", agentName: "Backend", agentType: "backend-developer", taskTitle: "Follow-up", subtaskId: "t2", todos: ["Extend behavior"] });
    expect(simulated).toContain(existing);
  });
  it("rejects ambiguous edits and whole-file rewrites", () => {
    expect(() => applyFileEdits("x x", '{"edits":[{"oldText":"x","newText":"y"}]}')).toThrow(/exactly once/);
    expect(() => applyFileEdits("x", "export const changed = 1;")).toThrow(/JSON/);
  });
  it.each(["../auth.ts", "/src/a.ts", "src/../a.ts", "src\\a.ts", ".git/config", "CodeVia/agents/backend.md"])("rejects unsafe/managed path %s", (path) => {
    expect(() => cleanRepoPath(path)).toThrow();
  });
  it("rejects unsupported owners and never silently drops a sixth file", () => {
    expect(() => parseBreakdown(JSON.stringify([{ ...items[0], agentType: "security" }]), ["backend-developer"])).toThrow();
    expect(() => parseBreakdown(JSON.stringify([{ ...items[0], files: ["a", "b", "c", "d", "e", "f"] }]), ["backend-developer"])).toThrow(/1–5/);
  });
});
