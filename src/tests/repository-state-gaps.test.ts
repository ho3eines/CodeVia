import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { buildContextPack, renderPromptContext } from "../agents/context.js";
import { CONTEXT_FILE, PROJECT_FILE, matter, parseMatter, renderAgentFile, renderTaskFile } from "../github/project-files.js";
import { renderRulesFile, renderRunFile } from "../github/state-codec.js";
import { freshDb } from "./test-helpers.js";
import type { Project } from "../domain/entities.js";

/* ------------------------------------------------------------------ *
 * Regression tests for docs/REPOSITORY_STATE_AUDIT.md R01–R08:
 *   R01 stored context reaches the model          R02 Git edits to finished history flow
 *   R03 workflow tombstones survive copies        R04 agent deletion is identity-based
 *   R05 legacy DB-only agents migrate             R06 legacy DB workflows migrate
 *   R07 cancel sync retries + reports unsynced    R08 malformed schema-2 numbers fail closed
 * ------------------------------------------------------------------ */

let cleanup: (() => void) | undefined;
let container: Container;
let app: FastifyInstance | undefined;
let project: Project;

const repo = (p: Project) => {
  const [owner, name] = p.configRepo.split("/");
  return { owner, name };
};
const nextTick = () => new Promise((resolve) => setImmediate(resolve));
/** Mock-only fixture helper: seed a repository into the in-memory mock GitHub. */
const seedRepo = (name: string, files: Array<{ path: string; content: string }>): void =>
  (container.github as unknown as { seedRepo: (owner: string, name: string, state: { files: Array<{ path: string; content: string }> }) => void }).seedRepo("audit", name, { files });

async function boot(): Promise<void> {
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
  project = await container.agentManager.createProject({
    name: "Repository audit",
    description: "Controlled TypeScript application",
    configRepo: "audit/source",
    capabilities: { languages: ["typescript"], frameworks: ["react"] },
  });
}

afterEach(async () => {
  container?.githubAutomation.stop();
  if (app) {
    await app.close();
    app = undefined;
  }
  await nextTick();
  cleanup?.();
});

async function copy(name: string, transform: (files: Array<{ path: string; content: string }>) => Array<{ path: string; content: string }> = (files) => files): Promise<Project> {
  const state = await container.projectFiles.pull(project);
  seedRepo(name, transform([...state.contents].map(([path, content]) => ({ path, content }))));
  return container.agentManager.createProject({ name, description: "Reuse repository material", configRepo: `audit/${name}` });
}

async function research(): Promise<ReturnType<Container["agentManager"]["runTask"]>> {
  const task = container.agentManager.createTask({ projectId: project.id, title: "Inspect implementation", description: "Explain existing conventions", agentType: "research" });
  return container.agentManager.runTask(task.id);
}

beforeEach(boot);

describe("R01 — stored project context reaches the model", () => {
  it("injects CodeVia/context.md into research requests and the implementation context pack", async () => {
    const marker = "REPOSITORY_ONLY_ARCHITECTURE_CONSTRAINT_9281";
    const rulesMarker = "POSITIVE_CONTROL_RULE_REACHES_MODEL_7162";
    await container.github.commit(repo(project), project.branch, "Edit architecture", [
      { path: CONTEXT_FILE, content: `# Architecture\n\n${marker}\nAll session behavior must follow the existing contract.` },
      { path: "CodeVia/rules.md", content: renderRulesFile([rulesMarker]) },
    ]);
    const config = container.providerRepo.findMany().map((r) => r.data).find((v) => v.type === "mock");
    expect(config).toBeDefined();
    const provider = container.providerRegistry.resolve(config!);
    const original = provider.chat.bind(provider);
    const requests: Array<{ messages: Array<{ content: string }> }> = [];
    (provider as { chat: unknown }).chat = async (req: { messages: Array<{ content: string }> }) => {
      requests.push(req);
      return original(req as never);
    };
    try {
      const done = await research();
      expect(done.status).toBe("succeeded");
      expect(requests.length).toBeGreaterThan(0);
      // Positive control: rules (already wired) must reach the model.
      expect(requests.some((r) => r.messages.some((m) => m.content.includes(rulesMarker)))).toBe(true);
      // The gap: the canonical context document must reach the model too.
      expect(requests.some((r) => r.messages.some((m) => m.content.includes(marker)))).toBe(true);
      const pack = await buildContextPack({ github: container.github, project, memoryRepo: container.memoryRepo, target: "src/session.ts", strict: true });
      expect(renderPromptContext(pack, "src/session.ts")).toContain(marker);
    } finally {
      (provider as { chat: unknown }).chat = original;
    }
  });
});

describe("R02 — completed history is not DB-authoritative", () => {
  it("surfaces Git edits to a finished task and run without resurrecting anything", async () => {
    const task = await research();
    const run = container.runRepo.byTask(task.id)[0];
    expect(task.status).toBe("succeeded");
    const title = "REPOSITORY_EDITED_TASK_TITLE";
    const description = "REPOSITORY_EDITED_TASK_DESCRIPTION";
    const summary = "REPOSITORY_EDITED_RUN_SUMMARY";
    await container.github.commit(repo(project), project.branch, "Correct completed history", [
      { path: container.projectFiles.pathFor(project, "task", task.id), content: renderTaskFile({ ...task, title, description }) },
      { path: `CodeVia/runs/${run.id}.md`, content: renderRunFile({ ...run, summary }) },
    ]);
    const rt = await app!.inject({ method: "GET", url: `/tasks/${task.id}` });
    const rr = await app!.inject({ method: "GET", url: `/runs/${run.id}` });
    expect(rt.statusCode).toBe(200);
    expect(rr.statusCode).toBe(200);
    expect(rt.json().title).toBe(title);
    expect(rt.json().description).toBe(description);
    expect(rr.json().summary).toBe(summary);
    // The finished status stays exactly as it was — content only, no resurrection.
    expect(rt.json().status).toBe("succeeded");
  });
});

describe("R03 — workflow tombstones survive repository copies", () => {
  it("does not regenerate a deleted default workflow under a new project id", async () => {
    const removed = container.workflowRepo.byProject(project.id).find((w) => w.slug === "bug-diagnosis-loop")!;
    expect((await app!.inject({ method: "DELETE", url: `/workflows/${removed.id}` })).statusCode).toBe(200);
    const path = container.projectFiles.pathFor(project, "workflow", removed.id);
    expect(parseMatter((await container.github.getFile(repo(project), path, project.branch))!.content).data.deleted).toBe(true);
    await container.agentManager.onboardProject(project.id);
    expect(container.workflowRepo.byProject(project.id).some((w) => w.slug === removed.slug)).toBe(false);
    const cloned = await copy("workflow-tombstone-copy");
    const regenerated = container.workflowRepo.byProject(cloned.id).find((w) => w.slug === removed.slug);
    expect(regenerated).toBeUndefined();
    // The tombstone itself survives the copy.
    expect(parseMatter((await container.github.getFile(repo(cloned), path, cloned.branch))!.content).data.deleted).toBe(true);
  });
});

describe("R04 — agent deletion refers to an identity, not a filename", () => {
  it("keeps a default-role agent deleted after its file was moved in Git", async () => {
    const old = container.agentRepo.byType(project.id, "research")!;
    const movedPath = "CodeVia/agents/custom-research-location.md";
    const cloned = await copy("moved-agent", (files) => files.map((f) => (f.path === old.configPath ? { ...f, path: movedPath } : f)));
    const agent = container.agentRepo.byType(cloned.id, "research")!;
    expect(agent.configPath).toBe(movedPath);
    expect((await app!.inject({ method: "DELETE", url: `/agents/${agent.id}` })).statusCode).toBe(200);
    await container.agentManager.onboardProject(cloned.id);
    expect(container.agentRepo.byType(cloned.id, "research")).toBeUndefined();
  });
});

describe("R05 — migration preserves a DB-only legacy agent", () => {
  it("migrates the definition to Git instead of silently replacing it", async () => {
    const legacy: Project = {
      ...project,
      id: "legacy-agent-project",
      slug: "legacy-agent-project",
      configRepo: "audit/legacy-agent",
      repositories: [{ repo: "audit/legacy-agent", branch: "main", role: "primary", isConfigRepo: true }],
      repositoryState: undefined,
      repositoryRevision: undefined,
    };
    seedRepo("legacy-agent", [{ path: "README.md", content: "Legacy project" }]);
    container.projectRepo.upsert(legacy, { key: legacy.slug });
    const source = container.agentRepo.byType(project.id, "research")!;
    const agent = { ...source, id: "legacy-custom-research", projectId: legacy.id, systemPrompt: "GENUINE_LEGACY_CUSTOM_PROMPT", tokenBudget: 321, enabled: false, tools: [], permissions: [], repositoryRevision: undefined };
    container.agentRepo.upsert(agent, { projectId: legacy.id });
    await container.agentManager.onboardProject(legacy.id);
    const afterFirst = container.agentRepo.byType(legacy.id, "research");
    expect(afterFirst?.id).toBe(agent.id);
    await container.agentManager.onboardProject(legacy.id);
    const afterSecond = container.agentRepo.byType(legacy.id, "research");
    expect(afterSecond?.id).toBe(agent.id);
    expect(afterSecond?.systemPrompt).toBe("GENUINE_LEGACY_CUSTOM_PROMPT");
    expect(afterSecond?.enabled).toBe(false);
    expect(afterSecond?.tokenBudget).toBe(321);
    expect(afterSecond?.permissions).toEqual([]);
  });
});

describe("R06 — legacy DB workflows migrate too", () => {
  it("keeps a custom disabled workflow when the CodeVia schema is initialized", async () => {
    const legacy: Project = {
      ...project,
      id: "legacy-workflow-project",
      slug: "legacy-workflow-project",
      configRepo: "audit/legacy-workflow",
      repositories: [{ repo: "audit/legacy-workflow", branch: "main", role: "primary", isConfigRepo: true }],
      repositoryState: undefined,
      repositoryRevision: undefined,
    };
    container.projectRepo.upsert(legacy, { key: legacy.slug });
    const w = container.workflowRepo.create({
      projectId: legacy.id,
      slug: "custom-disabled-flow",
      name: "Genuine legacy workflow",
      description: "Do not replace",
      enabled: false,
      nodes: [{ id: "review", type: "approval", name: "Review", config: { message: "Legacy guard" }, retries: 0 }],
      edges: [],
    });
    const files = [
      { path: PROJECT_FILE, content: matter({ id: legacy.id, slug: legacy.slug, capabilities: legacy.capabilities, promptSettings: { rules: legacy.settings.rules } }, "# Legacy manifest") },
      { path: ".ai-engineering/workflows/custom-disabled-flow.json", content: JSON.stringify(w) },
    ];
    for (const source of container.agentRepo.byProject(project.id)) {
      const agent = { ...source, id: `legacy-${source.type}`, projectId: legacy.id, repositoryRevision: undefined };
      files.push({ path: agent.configPath!, content: renderAgentFile(agent) });
    }
    seedRepo("legacy-workflow", files);
    await container.agentManager.onboardProject(legacy.id);
    const found = container.workflowRepo.byProject(legacy.id).find((item) => item.slug === w.slug);
    expect(found).toBeDefined();
    expect(found!.enabled).toBe(false);
  });
});

describe("R07 — failed cancellation persistence retries and reports unsynced state", () => {
  it("flags repositorySynced=false during an outage and completes the sync on retry", async () => {
    const task = container.agentManager.createTask({ projectId: project.id, title: "Cancelled fixture", description: "No execution" });
    await container.agentManager.syncTaskFile(project.id, task);
    const original = container.github.commit.bind(container.github);
    container.github.commit = async () => {
      throw new Error("Simulated temporary Git write outage");
    };
    let response;
    try {
      response = await app!.inject({ method: "POST", url: `/tasks/${task.id}/cancel` });
    } finally {
      container.github.commit = original as unknown as typeof container.github.commit;
    }
    expect(response.statusCode).toBe(200);
    expect(response.json().repositorySynced).toBe(false);
    expect(container.taskRepo.findById(task.id)!.data.status).toBe("cancelled");
    // Once Git is back, touching the task again completes the pending write.
    const retry = await app!.inject({ method: "POST", url: `/tasks/${task.id}/cancel` });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().alreadyFinal).toBe(true);
    expect(retry.json().repositorySynced).toBe(true);
    const statusInGit = parseMatter((await container.github.getFile(repo(project), `CodeVia/tasks/${task.id}.md`, project.branch))!.content).data.status;
    expect(statusInGit).toBe("cancelled");
  });
});

describe("R08 — malformed schema-2 numeric settings fail closed", () => {
  it("rejects the read instead of widening broken limits to defaults", async () => {
    const agent = container.agentRepo.byType(project.id, "research")!;
    const original = container.agentRepo.findById(agent.id)!.data;
    const encoded = parseMatter(renderAgentFile(agent));
    Object.assign(encoded.data, { tokenBudget: "BROKEN", timeoutMs: null, maxIterations: "BROKEN", version: "BROKEN" });
    await container.github.commit(repo(project), project.branch, "Malformed numeric fields", [
      { path: agent.configPath!, content: matter(encoded.data, encoded.body.replace(/^\n/, "")) },
    ]);
    let rejected = false;
    try {
      await container.agentManager.readProject(project.id);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    // The cache was not replaced with silently-defaulted values.
    const read = container.agentRepo.findById(agent.id)!.data;
    expect(read.tokenBudget).toBe(original.tokenBudget);
    expect(read.timeoutMs).toBe(original.timeoutMs);
    expect(read.maxIterations).toBe(original.maxIterations);
  });
});
