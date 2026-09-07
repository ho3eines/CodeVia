import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentType, AssignedSkill, Project, Task } from "../domain/entities.js";
import type { ChatRequest, IModelProvider } from "../ai/types.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { getEnvFresh } from "../config/env.js";
import { parseBreakdown, orderBreakdown, type BreakdownItem } from "../agents/implementation.js";
import { parseTaskFile, renderTaskFile, SKILLS_FILE } from "../github/project-files.js";
import { freshDb } from "./test-helpers.js";

const API_GUIDANCE = "Validate the session API's inputs; reject expired credentials and preserve its JSON contract.";
const UI_GUIDANCE = "Implement the accessible login form with loading/error states and the backend's exact response type.";
const apiItem: BreakdownItem = { id: "api", agentType: "backend-developer", title: "Implement login API", description: "Return an authenticated session", files: ["src/server/login.ts"], dependsOn: [], acceptanceCriteria: ["Invalid credentials return 401 without leaking details"], skills: ["nodejs", "typescript", "security"], skillInstructions: { security: API_GUIDANCE } };
const uiItem: BreakdownItem = { id: "ui", agentType: "frontend-developer", title: "Implement login form", description: "Consume the session API", files: ["src/ui/LoginPage.tsx"], dependsOn: ["api"], acceptanceCriteria: ["Keyboard users can submit and see validation errors"], skills: ["react", "typescript", "ui-design"], skillInstructions: { react: UI_GUIDANCE } };

let fx: ReturnType<typeof freshDb>;
let c: Container;
let app: FastifyInstance;
let p: Project;
let requests: ChatRequest[];
let plan: BreakdownItem[];
let beforeCode: (() => void) | undefined;

beforeEach(async () => {
  getEnvFresh();
  fx = freshDb();
  c = new Container();
  await c.ensureSeed();
  app = (await buildServer(c)).app;
  await app.ready();
  p = await c.agentManager.createProject({ name: "Request Pipeline", description: "Store", configRepo: "acme/request-pipeline", capabilities: { platforms: ["web"], languages: ["typescript"], frameworks: ["react", "fastify"], databases: ["postgresql"], features: ["authentication"], deploymentTargets: ["docker"], integrations: ["telegram"] } });
  requests = [];
  plan = structuredClone([uiItem, apiItem]); // deliberately reversed
  beforeCode = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  c.githubAutomation.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fx.cleanup();
});

async function cannedModels(): Promise<void> {
  const provider = c.providerRepo.create({ name: "Pipeline fixture (no network)", type: "openai", authType: "none", apiFormat: "openai", timeoutMs: 1000, maxTokensDefault: 8000, defaultTemperature: 0.2, rateLimitPerMinute: 100, active: true });
  const runtime: IModelProvider = {
    id: provider.id, type: "openai", name: "Fixture",
    listModels: async () => [], health: async () => true, resolveApiKey: () => undefined,
    chat: async (req) => {
      requests.push(req);
      const system = req.messages[0].content;
      let content: string;
      if (system.includes("business analyst writing")) content = "## Objective\nImplement session login.\n## Acceptance criteria\nReturn 401 for invalid credentials; show accessible validation in the form.\n## Assumptions\nReuse the existing session contract.";
      else if (system.includes("engineering manager") || system.includes("single-agent implementation")) content = JSON.stringify(plan);
      else {
        beforeCode?.();
        content = req.messages[1].content.includes('complete content of "src/ui/LoginPage.tsx"') ? "export const formContract = 'SESSION_CONTRACT';\n" : "// SESSION_CONTRACT\nexport const session = true;\n";
      }
      return { content, finishReason: "stop", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, modelId: req.modelId, providerId: provider.id };
    },
  };
  c.providerRegistry.register(runtime);
  for (const type of ["research", "backend-developer", "frontend-developer"] as AgentType[]) {
    const model = c.modelRepo.create({ providerId: provider.id, modelId: `${type}-model`, displayName: type, contextWindow: 128000, inputCostPer1k: 0, outputCostPer1k: 0, capabilities: { code: true, reasoning: true, structuredOutput: true, tools: false, streaming: false, vision: false }, active: true, priority: 1, fallbackPriority: 1, tags: [] });
    const agent = c.agentRepo.byType(p.id, type)!;
    c.agentRepo.upsert({ ...agent, models: { primary: model.id, fallbacks: [], specialized: {} }, systemPrompt: `${agent.systemPrompt}\nCUSTOM_${type}_PROMPT` }, { projectId: p.id });
  }
  await c.agentManager.syncProjectState(p.id);
}

async function ask(extra: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: `/projects/${p.id}/ask`, payload: { prompt: "صفحه ورود و API نشست را کامل کن", ...extra } });
}

it("defaults API requests to research → planned owners/skills → execution, preserving project settings", async () => {
  await app.inject({ method: "PATCH", url: `/projects/${p.id}`, payload: { description: `${"Business context. ".repeat(30)}IMPORTANT_DESCRIPTION_TAIL`, settings: { environment: "staging" } } });
  await app.inject({ method: "PUT", url: `/projects/${p.id}/rules`, payload: { rules: ["PERSIAN_PROJECT_RULE: preserve RTL behavior; do not change the database."] } });
  await cannedModels();
  const definitions = c.agentRepo.byProject(p.id);
  const baseSecurity = c.skillRepo.findBySlug("security")!;
  const baseReact = c.skillRepo.findBySlug("react")!;
  const response = await ask();
  expect(response.statusCode).toBe(200);
  const { task, executionMode, workflowId, jobId } = response.json();
  expect(executionMode).toBe("autonomous");
  expect(workflowId).toBeUndefined();
  expect(jobId).toBeTruthy();
  expect(task.input.executionMode).toBe("autonomous");
  let observedDispatch = false;
  beforeCode = () => {
    const children = c.taskRepo.findMany({ parentId: task.id }).map((r) => r.data);
    expect(children.filter((t) => t.input.planItemId)).toHaveLength(2);
    expect(children.filter((t) => t.input.planItemId).every((t) => t.assignedAgentId)).toBe(true);
    if (!observedDispatch) {
      expect(children.find((t) => t.input.planItemId === "api")?.status).toBe("running");
      expect(children.find((t) => t.input.planItemId === "ui")?.status).toBe("created");
      observedDispatch = true;
    }
  };
  const done = await c.agentManager.runTask(task.id);
  expect(done.status).toBe("succeeded");
  expect(done.result?.verification).toBe("simulated"); // canned AI is not real CI
  expect(done.result?.researchBrief).toContain("## Acceptance criteria");
  const children = c.taskRepo.findMany({ parentId: task.id }).map((r) => r.data);
  const backend = children.find((t) => t.input.planItemId === "api")!;
  const frontend = children.find((t) => t.input.planItemId === "ui")!;
  expect(frontend.input.dependsOn).toEqual([backend.id]);
  expect(backend.input.acceptanceCriteria).toEqual(apiItem.acceptanceCriteria);
  expect(frontend.input.acceptanceCriteria).toEqual(uiItem.acceptanceCriteria);
  expect(backend.assignedAgentId).toBe(c.agentRepo.byType(p.id, "backend-developer")!.id);
  expect(frontend.input.skills).toEqual(uiItem.skills);
  expect(children.every((t) => t.status === "succeeded" && t.assignedAgentId)).toBe(true);

  const research = requests[0];
  const planner = requests[1];
  for (const request of [research, planner]) {
    const text = JSON.stringify(request.messages);
    for (const marker of ["IMPORTANT_DESCRIPTION_TAIL", "PERSIAN_PROJECT_RULE", "staging", "postgresql", "telegram", "صفحه ورود", "CUSTOM_research_PROMPT"]) expect(text).toContain(marker);
    expect(request.modelId).toBe("research-model");
  }
  for (const marker of ["acceptanceCriteria", "dependsOn", "skillInstructions", "Owner/skill catalog", "backend-developer", "frontend-developer"]) expect(planner.messages[1].content).toContain(marker);
  const backendCall = requests.find((r) => r.modelId === "backend-developer-model")!;
  const frontendCall = requests.find((r) => r.modelId === "frontend-developer-model")!;
  expect(backendCall.messages[1].content).toContain(API_GUIDANCE);
  expect(backendCall.messages[1].content).not.toContain(UI_GUIDANCE);
  expect(frontendCall.messages[1].content).toContain(UI_GUIDANCE);
  expect(frontendCall.messages[1].content).not.toContain(API_GUIDANCE);
  expect(frontendCall.messages[1].content).toContain("SESSION_CONTRACT");
  expect(frontendCall.messages[1].content).toContain("[Skill: React]");
  expect(frontendCall.messages[1].content).not.toContain("[Skill: Blazor]");
  expect(backendCall.messages[1].content).not.toContain("[Skill: .NET Development]");

  const run = c.runRepo.byTask(frontend.id).find((r) => r.summary?.includes("Implementation"))!;
  expect(run.skills?.find((s) => s.slug === "react")).toMatchObject({ version: baseReact.version, instructions: baseReact.instructions, guidance: expect.stringContaining(UI_GUIDANCE) });
  const console = await app.inject({ method: "GET", url: `/runs/${run.id}/console` });
  expect(console.json().skills).toEqual(run.skills);
  expect(c.skillRepo.findBySlug("security")).toEqual(baseSecurity);
  expect(c.skillRepo.findBySlug("react")).toEqual(baseReact);
  // Pre-sync can update timestamps, but execution must not edit definitions or permissions.
  for (const original of definitions) {
    const current = c.agentRepo.findById(original.id)!.data;
    expect(current.skills).toEqual(original.skills);
    expect(current.tools).toEqual(original.tools);
    expect(current.permissions).toEqual(original.permissions);
  }

  const file = await c.github.getFile({ owner: "acme", name: "request-pipeline" }, `CodeVia/tasks/${frontend.id}.md`, "main");
  const restored = parseTaskFile(file!.content)!;
  expect(restored.assignedAgentId).toBe(frontend.assignedAgentId);
  expect(restored.input?.skills).toEqual(frontend.input.skills);
  expect(restored.input?.dependsOn).toEqual([backend.id]);
  expect(restored.researchBrief).toBe(done.input.researchBrief);
  expect(restored.description).toBe(frontend.description); // including nested Markdown headings
});

it("uses a newly attached custom skill without re-onboarding and never grants its tools", async () => {
  const created = await app.inject({ method: "POST", url: "/skills", payload: { slug: "company-contract", name: "Company Contract", instructions: "COMPANY_CONTRACT_BASE", compatibleAgentTypes: ["backend-developer"], dependencies: ["restapi"], tools: ["shell", "deploy"] } });
  expect(created.statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/projects/${p.id}/skills`, payload: { slug: "company-contract" } })).statusCode).toBe(200);
  const backend = c.agentRepo.byType(p.id, "backend-developer")!;
  plan = [{ ...structuredClone(apiItem), skills: ["company-contract"], skillInstructions: { "company-contract": "Use the approved session error envelope." } }];
  await cannedModels();
  const { task } = (await ask()).json();
  await c.agentManager.runTask(task.id);
  const code = requests.find((r) => r.modelId === "backend-developer-model")!;
  expect(code.messages[1].content).toContain("COMPANY_CONTRACT_BASE");
  expect(code.messages[1].content).toContain("Use the approved session error envelope");
  expect(code.messages[1].content).toContain("[Skill: REST API]");
  expect(c.agentRepo.byType(p.id, "backend-developer")!.tools).toEqual(backend.tools);
  expect(c.agentRepo.byType(p.id, "backend-developer")!.permissions).toEqual(backend.permissions);
});

it.each(["unknown-skill", "blazor", "security"])("rejects invalid frontend skill %s before any implementation starts", async (slug) => {
  plan[0].skills = [slug];
  plan[0].skillInstructions = {};
  await cannedModels();
  const { task } = (await ask()).json();
  await expect(c.agentManager.runTask(task.id)).rejects.toThrow(/unavailable|incompatible/);
  expect((await c.github.listBranches({ owner: "acme", name: "request-pipeline" })).some((b) => b.name.startsWith("agent-"))).toBe(false);
  expect(requests.every((r) => r.modelId === "research-model")).toBe(true);
});

it("rejects a disabled planned skill before writing source files", async () => {
  const react = c.skillRepo.findBySlug("react", p.id)!;
  c.skillRepo.upsert({ ...react, enabled: false }, { projectId: p.id, key: react.slug });
  await cannedModels();
  const { task } = (await ask()).json();
  await expect(c.agentManager.runTask(task.id)).rejects.toThrow(/unavailable|incompatible/);
  expect(requests.every((r) => r.modelId === "research-model")).toBe(true);
});

it("does not replace an explicitly requested disabled owner with another agent", async () => {
  const backend = c.agentRepo.byType(p.id, "backend-developer")!;
  c.agentRepo.upsert({ ...backend, enabled: false }, { projectId: p.id });
  await c.agentManager.syncProjectState(p.id);
  const { task } = (await ask({ agentType: "backend-developer" })).json();
  await expect(c.agentManager.runTask(task.id)).rejects.toThrow(/requested implementer.*unavailable/);
  expect(c.taskRepo.findMany({ parentId: task.id })).toHaveLength(0);
});

it("applies a single-agent plan's task-specific skills to code generation too", async () => {
  plan = [structuredClone(apiItem)];
  await cannedModels();
  const { task } = (await ask({ executionMode: "agent", agentType: "backend-developer" })).json();
  const done = await c.agentManager.runTask(task.id);
  expect(done.status).toBe("succeeded");
  expect(requests).toHaveLength(2);
  expect(requests[1].messages[1].content).toContain(API_GUIDANCE);
  expect((done.result?.skills as AssignedSkill[]).find((s) => s.slug === "security")?.guidance).toContain(API_GUIDANCE);
});

it("cancels undispatched dependants after an upstream implementation failure", async () => {
  await cannedModels();
  beforeCode = () => { throw new Error("canned coding provider unavailable"); };
  const { task } = (await ask()).json();
  await expect(c.agentManager.runTask(task.id)).rejects.toThrow(/unavailable/);
  const children = c.taskRepo.findMany({ parentId: task.id }).map((r) => r.data);
  expect(children.find((t) => t.input.planItemId === "api")?.status).toBe("failed");
  expect(children.find((t) => t.input.planItemId === "ui")?.status).toBe("cancelled");
  expect(children.some((t) => ["running", "created"].includes(t.status))).toBe(false);
});

it("keeps explicit single-agent/workflow modes and rejects silent read-only hint fallbacks", async () => {
  const explicit = await ask({ executionMode: "agent", agentType: "research" });
  expect(explicit.json().task.agentType).toBe("research");
  expect(explicit.json().task.input.executionMode).toBe("agent");
  expect((await ask({ agentType: "research" })).statusCode).toBe(400);
  expect((await ask({ agentType: "invented-agent" })).statusCode).toBe(400);
  expect((await ask({ prompt: "  " })).statusCode).toBe(400);
  const workflowId = c.workflowRepo.byProject(p.id)[0].id;
  const workflow = await ask({ workflowId });
  expect(workflow.json().executionMode).toBe("workflow");
  expect(workflow.json().task.workflowId).toBe(workflowId);
});

it("restores an intentionally empty project skill list rather than reviving detached skills", async () => {
  const ref = { owner: "acme", name: "request-pipeline" };
  await c.github.commit(ref, "main", "detach all project skills", [{ path: SKILLS_FILE, content: '---\nskills: []\n---\n\nNo project attachments.\n' }]);
  await c.projectFiles.restore(p, { projectRepo: c.projectRepo, agentRepo: c.agentRepo, taskRepo: c.taskRepo, memoryRepo: c.memoryRepo }, { includeTasks: false });
  expect(c.projectRepo.findById(p.id)!.data.settings.skills).toEqual([]);
});

describe("structured plan validation", () => {
  it("supports more than four bounded tasks and honors dependencies over role ordering", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ ...apiItem, id: `t${i}`, dependsOn: i ? [`t${i - 1}`] : [], files: [`src/${i}.ts`] }));
    expect(parseBreakdown(JSON.stringify(items), ["backend-developer"])).toHaveLength(6);
    const inverse = [{ ...apiItem, dependsOn: ["ui"] }, { ...uiItem, dependsOn: [] }];
    expect(orderBreakdown(inverse).map((i) => i.id)).toEqual(["ui", "api"]);
  });
  it.each([
    [{ ...apiItem, dependsOn: ["unknown"] }],
    [{ ...apiItem, dependsOn: ["api"] }],
    [apiItem, apiItem],
    [{ ...apiItem, dependsOn: ["ui"] }, uiItem],
    [{ ...apiItem, acceptanceCriteria: [42] }],
  ])("rejects an invalid dependency/acceptance contract", (...items) => {
    expect(() => parseBreakdown(JSON.stringify(items), ["backend-developer", "frontend-developer"])).toThrow();
  });
  it("round-trips task-local skills and nested markdown losslessly", () => {
    const assigned: AssignedSkill = { slug: "security", name: "Security", version: "1", instructions: "BASE", guidance: API_GUIDANCE, source: "task" };
    const task: Task = { id: "t", projectId: "p", parentTaskId: "parent", assignedAgentId: "a", title: "API", description: "Request\n## Details\nKeep this section.", status: "succeeded", correlationId: "c", input: { researchBrief: "## Findings\nFacts\n## Risks\nRisks", skills: ["security"], skillInstructions: { security: API_GUIDANCE }, skillAssignments: [assigned], acceptanceCriteria: ["Returns 401"], dependsOn: ["other"] }, createdAt: "", updatedAt: "" };
    const parsed = parseTaskFile(renderTaskFile(task))!;
    expect(parsed.description).toBe(task.description);
    expect(parsed.researchBrief).toBe(task.input.researchBrief);
    expect(parsed.assignedAgentId).toBe("a");
    expect(parsed.input?.skillAssignments).toEqual([assigned]);
    expect(parsed.input?.skillInstructions).toEqual(task.input.skillInstructions);
  });
});
