import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Container } from "../app/container.js";
import { freshDb } from "./test-helpers.js";
import type { Model } from "../domain/entities.js";
import type { ChatRequest, ChatResponse, IModelProvider } from "../ai/types.js";
import { MockGitHubService } from "../github/mock-service.js";

/**
 * Step-1 corrective patch loop: when a model reply cannot be applied to an
 * existing file, prepareImplementation sends the nearest region with line
 * numbers back to the model (up to MAX_PATCH_CORRECTIONS = 2 rounds) instead
 * of failing the task on the first mismatch.
 */

let fx: ReturnType<typeof freshDb>;
let c: Container;
let gh: MockGitHubService;
const repo = { owner: "acme", name: "implementation" };
let requests: ChatRequest[];
let providerId = "";
let projectId = "";
const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 };

const SEED = [
  "export function greet(name: string): string {",
  "  return `hi ${name}`;",
  "}",
  "export const VERSION = 1;",
  "",
].join("\n");

const PLAN = JSON.stringify([
  {
    agentType: "backend-developer",
    title: "Bump version",
    description: "Bump the version constant",
    files: ["src/server/login.ts"],
  },
]);

const BAD = JSON.stringify({
  edits: [{ oldText: "export const VERSION = 999;", newText: "export const VERSION = 2;" }],
});
const GOOD = JSON.stringify({
  edits: [{ oldText: "export const VERSION = 1;", newText: "export const VERSION = 2;" }],
});

/** Register a real (non-mock) model whose chat handler is the given function. */
async function modelWith(handler: (req: ChatRequest) => string): Promise<Model> {
  const provider = c.providerRepo.create({
    name: "patch-retry",
    type: "openai",
    authType: "none",
    apiFormat: "openai",
    timeoutMs: 1000,
    maxTokensDefault: 8000,
    defaultTemperature: 0,
    rateLimitPerMinute: 100,
    active: true,
  });
  const model = c.modelRepo.create({
    providerId: provider.id,
    modelId: "patch-retry",
    displayName: "patch-retry",
    contextWindow: 128000,
    inputCostPer1k: 0.1,
    outputCostPer1k: 0.2,
    capabilities: {
      code: true,
      reasoning: true,
      structuredOutput: true,
      tools: false,
      streaming: false,
      vision: false,
    },
    active: true,
    priority: 1,
    fallbackPriority: 1,
    tags: [],
  });
  const runtime: IModelProvider = {
    id: provider.id,
    type: "openai",
    name: "patch-retry",
    chat: async (req): Promise<ChatResponse> => {
      requests.push(req);
      return {
        content: handler(req),
        finishReason: "stop",
        usage,
        costUsd: 0,
        modelId: req.modelId,
        providerId: provider.id,
      };
    },
    health: async () => true,
    listModels: async () => [],
    resolveApiKey: () => undefined,
  };
  c.providerRegistry.register(runtime);
  providerId = provider.id;
  return model;
}

beforeEach(async () => {
  fx = freshDb();
  c = new Container();
  await c.ensureSeed();
  const project = await c.agentManager.createProject({
    name: "Patch retry",
    description: "A TypeScript application",
    configRepo: "acme/implementation",
    capabilities: { languages: ["typescript"], frameworks: ["react"] },
  });
  gh = c.github as MockGitHubService;
  projectId = project.id;
  // The edit target must already exist on the base branch.
  gh.seedRepo(repo.owner, repo.name, { files: [{ path: "src/server/login.ts", content: SEED }] });
  requests = [];
  const agent = c.agentRepo.byType(project.id, "backend-developer")!;
  const model = await modelWith(() => PLAN);
  c.agentRepo.upsert(
    { ...agent, models: { primary: model.id, fallbacks: [], specialized: { coding: model.id } } },
    { projectId: project.id },
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  c.githubAutomation.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fx.cleanup();
});

const task = () =>
  c.agentManager.createTask({
    projectId,
    title: "Bump the version",
    description: "Bump the version constant in login.ts",
    agentType: "backend-developer",
    input: {},
  });

/** Route the model: planning → PLAN; codegen → the given replies in order. */
function codegenHandler(replies: Array<(userPrompt: string) => string | undefined>): void {
  const provider = c.providerRegistry.get(providerId)!;
  const original = provider.chat.bind(provider);
  let codegenCall = 0;
  provider.chat = async (req: ChatRequest): Promise<ChatResponse> => {
    const system = req.messages[0].content;
    if (system.includes("single-agent implementation")) return original(req);
    const user = String(req.messages[1]?.content ?? "");
    const override = replies[Math.min(codegenCall, replies.length - 1)](user);
    codegenCall += 1;
    if (override === undefined) return original(req);
    requests.push(req);
    return {
      content: override,
      finishReason: "stop",
      usage,
      costUsd: 0,
      modelId: req.modelId,
      providerId,
    };
  };
}

describe("corrective patch loop for existing files", () => {
  it("recovers on the second attempt with the nearest region in the corrective prompt", async () => {
    codegenHandler([(user) => (user.includes("CORRECTION NEEDED") ? GOOD : BAD)]);
    const t = task();
    const done = await c.agentManager.runTask(t.id);
    expect(done.status).toBe("succeeded");

    // plan + initial patch + one corrective patch
    expect(requests).toHaveLength(3);
    const corrective = String(requests[2].messages[1].content);
    expect(corrective).toContain("CORRECTION NEEDED");
    expect(corrective).toContain("could NOT be applied");
    expect(corrective).toContain("Closest region in the file:");
    expect(corrective).toMatch(/^4 \| export const VERSION = 1;/m);
    expect(corrective).toContain("src/server/login.ts");

    // the good patch landed on the working branch
    const prs = await gh.listPullRequests(repo);
    expect(prs).toHaveLength(1);
    const file = await gh.getFile(repo, "src/server/login.ts", prs[0].head);
    expect(file?.content).toContain("export const VERSION = 2;");
    expect(file?.content).toContain("export function greet");
  });

  it("gives up after two corrective rounds with the final patch error, without writing a branch", async () => {
    codegenHandler([() => BAD]);
    const t = task();
    await expect(c.agentManager.runTask(t.id)).rejects.toThrow(/exactly once/);

    // plan + initial patch + exactly two corrective rounds
    expect(requests).toHaveLength(4);
    for (const attempt of [requests[2], requests[3]]) {
      const prompt = String(attempt.messages[1].content);
      expect(prompt).toContain("CORRECTION NEEDED");
      expect(prompt).toContain("Closest region in the file:");
    }

    // nothing was committed: the failure happened before any plan step ran
    const branches = (await gh.listBranches(repo)).filter((b) => b.name.startsWith("agent-"));
    expect(branches).toHaveLength(0);
  });
});
