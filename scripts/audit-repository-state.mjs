#!/usr/bin/env node
/**
 * Independent repository-first completeness probes, not regression tests.
 * Run: node --import tsx scripts/audit-repository-state.mjs
 * Exit: 0 all contracts hold; 1 reproduced gaps; 2 broken probe.
 * Only temporary SQLite + Mock GitHub/model fixtures. Outbound fetch forbidden.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

for (const key of ["GITHUB_TOKEN", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "TELEGRAM_BOT_TOKEN"]) delete process.env[key];
Object.assign(process.env, { NODE_ENV: "test", LOG_LEVEL: "fatal", REQUIRE_AUTH: "false", GITHUB_ENABLED: "false", TELEGRAM_MODE: "off", AUTH_SECRET: "local-repository-audit-fixture-not-a-real-credential" });
globalThis.fetch = async () => { throw new Error("Outbound fetch is forbidden in this audit"); };
const { Container } = await import("../src/app/container.ts");
const { Db, setDbForTest } = await import("../src/db/client.ts");
const { getEnvFresh } = await import("../src/config/env.ts");
const { buildServer } = await import("../src/http/app.ts");
const { ProjectStateGenerator } = await import("../src/agents/state-generator.ts");
const { buildContextPack, renderPromptContext } = await import("../src/agents/context.ts");
const { parseMatter, matter, renderAgentFile, renderTaskFile, CONTEXT_FILE, PROJECT_FILE } = await import("../src/github/project-files.ts");
const { renderSkillFile, renderRunFile, renderRulesFile } = await import("../src/github/state-codec.ts");
const { CodeViaMemoryStore } = await import("../src/memory/codevia-store.ts");

const results = [];
const repo = (p) => { const [owner, name] = p.configRepo.split("/"); return { owner, name }; };
const nextTick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "codevia-repository-audit-"));
  Object.assign(process.env, { DATABASE_PATH: join(dir, "runtime.db"), MOCK_GITHUB_PATH: join(dir, "github.json") });
  getEnvFresh();
  const db = new Db(process.env.DATABASE_PATH); setDbForTest(db);
  const c = new Container(); await c.ensureSeed();
  assert.equal(c.github.kind, "mock");
  const { app, io } = await buildServer(c); await app.ready();
  try {
    const p = await c.agentManager.createProject({ name: "Repository audit", description: "Controlled TypeScript application", configRepo: "audit/source", capabilities: { languages: ["typescript"], frameworks: ["react"] } });
    return await run({ c, p, app });
  } finally {
    c.githubAutomation.stop(); io.close(); await app.close(); await nextTick(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
}
async function probe(id, severity, title, expected, files, run) {
  try {
    const result = await fixture(run);
    results.push({ id, severity, title, expected, files, status: result.ok ? "pass" : "gap", evidence: result.evidence });
  } catch (error) { results.push({ id, severity, title, expected, files, status: "probe-error", error: String(error), stack: error?.stack }); }
}
async function copy(c, p, name, transform = (files) => files) {
  const state = await c.projectFiles.pull(p);
  c.github.seedRepo("audit", name, { files: transform([...state.contents].map(([path, content]) => ({ path, content }))) });
  return c.agentManager.createProject({ name, description: "Reuse repository material", configRepo: `audit/${name}` });
}
async function research(c, p) {
  const t = c.agentManager.createTask({ projectId: p.id, title: "Inspect implementation", description: "Explain existing conventions", agentType: "research" });
  return c.agentManager.runTask(t.id);
}

await probe("P01", "control", "Existing definitions are reused without generation", "A second onboarding does not call the state author or commit files", ["src/agents/project-state.ts"], async ({ c, p }) => {
  let writes = 0, generates = 0;
  const commit = c.github.commit, generate = ProjectStateGenerator.prototype.generate;
  c.github.commit = async function (...args) { writes++; return commit.apply(this, args); };
  ProjectStateGenerator.prototype.generate = async function (...args) { generates++; return generate.apply(this, args); };
  try {
    await c.agentManager.onboardProject(p.id);
    return { ok: !writes && !generates, evidence: { commits: writes, stateAuthorCalls: generates } };
  } finally { c.github.commit = commit; ProjectStateGenerator.prototype.generate = generate; }
});

await probe("P02", "control", "Git-added skill definitions load automatically", "The project catalog reads the full Git definition without requiring a DB seed", ["src/http/project-state-hook.ts", "src/skills/registry.ts"], async ({ c, p, app }) => {
  const skill = { id: "audit-custom", slug: "audit-custom", name: "Git knowledge", description: "Fixture", instructions: "UNIQUE_GIT_SKILL_INSTRUCTIONS", category: "project", enabled: true, builtIn: false, version: "2.0", dependencies: [], tools: [], compatibleAgentTypes: ["*"], metadata: {}, createdAt: p.createdAt, updatedAt: p.updatedAt };
  await c.github.commit(repo(p), p.branch, "Edit skill", [{ path: "CodeVia/skills/audit-custom.md", content: renderSkillFile(skill) }]);
  const response = await app.inject({ method: "GET", url: `/skills?projectId=${p.id}` });
  assert.equal(response.statusCode, 200);
  const found = response.json().find((s) => s.slug === skill.slug);
  return { ok: found?.instructions === skill.instructions, evidence: { status: response.statusCode, projectScoped: found?.projectId === p.id, fullInstructionsRead: found?.instructions === skill.instructions } };
});

await probe("P03", "control", "Long structured memory survives a cleared index", "Headings, Unicode and references survive a repository round-trip", ["src/memory/codevia-store.ts", "src/github/project-state.ts"], async ({ c, p }) => {
  const content = "# حافظه\n\n## Nested\n\n" + "Long evidence. ".repeat(500);
  const store = new CodeViaMemoryStore(c.projectFiles, p);
  await store.update({ type: "decision", key: "roundtrip", scope: "project", tags: ["test"], refs: ["reference"], content });
  c.memoryRepo.deleteByProject(p.id); await c.agentManager.readProject(p.id);
  const restored = c.memoryRepo.byProject(p.id).find((m) => m.key === "roundtrip");
  return { ok: restored?.content === content && restored.refs[0] === "reference", evidence: { inputLength: content.length, restoredLength: restored?.content.length, exactMatch: restored?.content === content } };
});

await probe("R01", "high", "Stored project context must reach the model", "The default research and implementation context should include the canonical architecture document", ["src/ai/context-engine.ts", "src/agents/context.ts"], async ({ c, p }) => {
  const marker = "REPOSITORY_ONLY_ARCHITECTURE_CONSTRAINT_9281";
  const rulesMarker = "POSITIVE_CONTROL_RULE_REACHES_MODEL_7162";
  await c.github.commit(repo(p), p.branch, "Edit architecture", [{ path: CONTEXT_FILE, content: `# Architecture\n\n${marker}\nAll session behavior must follow the existing contract.` }, { path: "CodeVia/rules.md", content: renderRulesFile([rulesMarker]) }]);
  const config = c.providerRepo.findMany().map((r) => r.data).find((v) => v.type === "mock");
  const provider = c.providerRegistry.resolve(config), chat = provider.chat, requests = [];
  provider.chat = async function (req) { requests.push(req); return chat.call(this, req); };
  try {
    const done = await research(c, p); assert.equal(done.status, "succeeded"); assert.ok(requests.length > 0);
    const pack = await buildContextPack({ github: c.github, project: p, memoryRepo: c.memoryRepo, target: "src/session.ts", strict: true });
    const rulesReachedModel = requests.some((r) => r.messages.some((m) => m.content.includes(rulesMarker)));
    assert.equal(rulesReachedModel, true, "Model-capture positive control failed");
    const reachedModel = requests.some((r) => r.messages.some((m) => m.content.includes(marker)));
    const reachedImplementationContext = renderPromptContext(pack, "src/session.ts").includes(marker);
    return { ok: reachedModel && reachedImplementationContext, evidence: { storedInGit: (await c.github.getFile(repo(p), CONTEXT_FILE, p.branch)).content.includes(marker), modelCalls: requests.length, rulesReachedModel, reachedModel, reachedImplementationContext } };
  } finally { provider.chat = chat; }
});

await probe("R02", "high", "Completed history must not remain DB-authoritative", "A Git edit to a completed task description/run summary should appear in the API without erasing the DB", ["src/github/project-state.ts"], async ({ c, p, app }) => {
  const task = await research(c, p), run = c.runRepo.byTask(task.id)[0];
  const title = "REPOSITORY_EDITED_TASK_TITLE", description = "REPOSITORY_EDITED_TASK_DESCRIPTION", summary = "REPOSITORY_EDITED_RUN_SUMMARY";
  await c.github.commit(repo(p), p.branch, "Correct completed history", [
    { path: c.projectFiles.pathFor(p, "task", task.id), content: renderTaskFile({ ...task, title, description }) },
    { path: `CodeVia/runs/${run.id}.md`, content: renderRunFile({ ...run, summary }) },
  ]);
  const rt = await app.inject({ method: "GET", url: `/tasks/${task.id}` }), rr = await app.inject({ method: "GET", url: `/runs/${run.id}` });
  assert.equal(rt.statusCode, 200); assert.equal(rr.statusCode, 200);
  return { ok: rt.json().title === title && rt.json().description === description && rr.json().summary === summary, evidence: { terminalStatus: task.status, taskApiSeesGitEdit: rt.json().title === title, taskDescriptionSeesGitEdit: rt.json().description === description, runApiSeesGitEdit: rr.json().summary === summary, oldTaskTitleStillUsed: rt.json().title === task.title } };
});

await probe("R03", "high", "Workflow tombstones must survive repository copies", "A deliberately deleted default workflow must not be regenerated under a new project ID", ["src/agents/project-state.ts", "src/github/project-state.ts"], async ({ c, p, app }) => {
  const removed = c.workflowRepo.byProject(p.id).find((w) => w.slug === "bug-diagnosis-loop");
  assert.equal((await app.inject({ method: "DELETE", url: `/workflows/${removed.id}` })).statusCode, 200);
  const path = c.projectFiles.pathFor(p, "workflow", removed.id);
  assert.equal(parseMatter((await c.github.getFile(repo(p), path, p.branch)).content).data.deleted, true);
  await c.agentManager.onboardProject(p.id);
  assert.equal(c.workflowRepo.byProject(p.id).some((w) => w.slug === removed.slug), false);
  const cloned = await copy(c, p, "workflow-tombstone-copy");
  const regenerated = c.workflowRepo.byProject(cloned.id).find((w) => w.slug === removed.slug);
  return { ok: !regenerated, evidence: { tombstonePreserved: parseMatter((await c.github.getFile(repo(cloned), path, cloned.branch)).content).data.deleted === true, deletedSlug: removed.slug, regenerated: !!regenerated, oldId: removed.id, newId: regenerated?.id } };
});

await probe("R04", "high", "Deletion should refer to an agent identity, not just a default filename", "Deleting a default-role agent after moving its file in Git must remain deleted", ["src/agents/project-state.ts", "src/http/routes/agents.ts"], async ({ c, p, app }) => {
  const old = c.agentRepo.byType(p.id, "research");
  const movedPath = "CodeVia/agents/custom-research-location.md";
  const cloned = await copy(c, p, "moved-agent", (files) => files.map((f) => f.path === old.configPath ? { ...f, path: movedPath } : f));
  const agent = c.agentRepo.byType(cloned.id, "research"); assert.equal(agent.configPath, movedPath);
  assert.equal((await app.inject({ method: "DELETE", url: `/agents/${agent.id}` })).statusCode, 200);
  await c.agentManager.onboardProject(cloned.id);
  const replacement = c.agentRepo.byType(cloned.id, "research");
  return { ok: !replacement, evidence: { movedPath, deletedId: agent.id, regenerated: !!replacement, replacementPath: replacement?.configPath, replacementId: replacement?.id } };
});

await probe("R05", "high", "Migration must not drop a DB-only legacy agent definition", "An old saved agent should be migrated or explicitly rejected before it is deleted, not silently replaced", ["src/agents/project-state.ts", "src/github/project-state.ts"], async ({ c, p }) => {
  const legacy = { ...p, id: "legacy-agent-project", slug: "legacy-agent-project", configRepo: "audit/legacy-agent", repositories: [{ repo: "audit/legacy-agent", branch: "main", role: "primary", isConfigRepo: true }], repositoryState: undefined, repositoryRevision: undefined };
  c.github.seedRepo("audit", "legacy-agent", { files: [{ path: "README.md", content: "Legacy project" }] });
  c.projectRepo.upsert(legacy, { key: legacy.slug });
  const agent = { ...c.agentRepo.byType(p.id, "research"), id: "legacy-custom-research", projectId: legacy.id, systemPrompt: "GENUINE_LEGACY_CUSTOM_PROMPT", tokenBudget: 321, enabled: false, tools: [], permissions: [], repositoryRevision: undefined };
  c.agentRepo.upsert(agent, { projectId: legacy.id });
  await c.agentManager.onboardProject(legacy.id);
  const afterFirst = c.agentRepo.byType(legacy.id, "research");
  await c.agentManager.onboardProject(legacy.id);
  const afterSecond = c.agentRepo.byType(legacy.id, "research");
  return { ok: afterSecond?.id === agent.id && afterSecond.systemPrompt === agent.systemPrompt, evidence: { existedInLegacyDb: true, presentAfterFirstOnboard: !!afterFirst, originalId: agent.id, laterId: afterSecond?.id, customPromptReused: afterSecond?.systemPrompt === agent.systemPrompt, expectedDisabled: true, laterEnabled: afterSecond?.enabled, expectedPermissions: [], laterPermissions: afterSecond?.permissions, expectedTokenBudget: 321, laterTokenBudget: afterSecond?.tokenBudget, archivedPromptVersions: c.promptVersionRepo.forAgent(agent.id).length } };
});

await probe("R06", "high", "Legacy workflows require migration too", "Custom/disabled legacy workflows should not disappear when the CodeVia schema is initialized", ["src/agents/project-state.ts", "src/github/project-state.ts"], async ({ c, p }) => {
  const legacy = { ...p, id: "legacy-workflow-project", slug: "legacy-workflow-project", configRepo: "audit/legacy-workflow", repositories: [{ repo: "audit/legacy-workflow", branch: "main", role: "primary", isConfigRepo: true }], repositoryState: undefined, repositoryRevision: undefined };
  c.projectRepo.upsert(legacy, { key: legacy.slug });
  const w = c.workflowRepo.create({ projectId: legacy.id, slug: "custom-disabled-flow", name: "Genuine legacy workflow", description: "Do not replace", enabled: false, nodes: [{ id: "review", type: "approval", name: "Review", config: { message: "Legacy guard" }, retries: 0 }], edges: [] });
  const files = [{ path: PROJECT_FILE, content: matter({ id: legacy.id, slug: legacy.slug, capabilities: legacy.capabilities, promptSettings: { rules: legacy.settings.rules } }, "# Legacy manifest") }, { path: ".ai-engineering/workflows/custom-disabled-flow.json", content: JSON.stringify(w) }];
  for (const source of c.agentRepo.byProject(p.id)) {
    const agent = { ...source, id: `legacy-${source.type}`, projectId: legacy.id, repositoryRevision: undefined };
    files.push({ path: agent.configPath, content: renderAgentFile(agent) });
  }
  c.github.seedRepo("audit", "legacy-workflow", { files });
  await c.agentManager.onboardProject(legacy.id);
  const found = c.workflowRepo.byProject(legacy.id).find((item) => item.slug === w.slug);
  return { ok: !!found && !found.enabled, evidence: { workflowExistedInDb: true, legacyFileStillExists: !!(await c.github.getFile(repo(legacy), ".ai-engineering/workflows/custom-disabled-flow.json", legacy.branch)), foundAfterMigration: !!found, resultingSlugs: c.workflowRepo.byProject(legacy.id).map((item) => item.slug) } };
});

await probe("R07", "medium", "Failed cancellation persistence needs retry/unsynced visibility", "Cancellation may stop locally during an outage, but must not permanently pretend Git is in sync", ["src/agents/manager.ts", "src/http/routes/tasks-runs.ts"], async ({ c, p, app }) => {
  const task = c.agentManager.createTask({ projectId: p.id, title: "Cancelled fixture", description: "No execution" });
  await c.agentManager.syncTaskFile(p.id, task);
  const original = c.github.commit;
  c.github.commit = async () => { throw new Error("Simulated temporary Git write outage"); };
  let response;
  try { response = await app.inject({ method: "POST", url: `/tasks/${task.id}/cancel` }); }
  finally { c.github.commit = original; }
  const retry = await app.inject({ method: "POST", url: `/tasks/${task.id}/cancel` });
  const statusInGit = parseMatter((await c.github.getFile(repo(p), `CodeVia/tasks/${task.id}.md`, p.branch)).content).data.status;
  return { ok: statusInGit === "cancelled" || response.statusCode >= 400 || response.json().repositorySynced === false, evidence: { cancellationStatus: response.statusCode, localStatus: c.taskRepo.findById(task.id).data.status, retryStatus: retry.statusCode, retryAlreadyFinal: retry.json().alreadyFinal, statusInGitAfterRetry: statusInGit, explicitUnsyncedFlag: response.json().repositorySynced === false } };
});

await probe("R08", "high", "Malformed numeric agent settings must fail closed", "Invalid schema-2 budgets and limits should be rejected, not converted to larger defaults", ["src/github/project-codec.ts", "src/github/project-state.ts"], async ({ c, p }) => {
  const a = c.agentRepo.byType(p.id, "research"), encoded = parseMatter(renderAgentFile(a));
  Object.assign(encoded.data, { tokenBudget: "BROKEN", timeoutMs: null, maxIterations: "BROKEN", version: "BROKEN" });
  await c.github.commit(repo(p), p.branch, "Malformed numeric fields", [{ path: a.configPath, content: matter(encoded.data, encoded.body.replace(/^\n/, "")) }]);
  let rejected = false, error;
  try { await c.agentManager.readProject(p.id); } catch (e) { rejected = true; error = String(e); }
  const read = c.agentRepo.findById(a.id).data;
  return { ok: rejected, evidence: { rejected, error, readTokenBudget: read.tokenBudget, readTimeoutMs: read.timeoutMs, readMaxIterations: read.maxIterations, readVersion: read.version } };
});

const report = { generatedAt: new Date().toISOString(), scope: "Repository-first request: persistence, actual consumption, reuse, migration, malformed state and deletion semantics", externalServicesUsed: false, productSourceModifiedByAudit: false, passes: results.filter((r) => r.status === "pass").length, gaps: results.filter((r) => r.status === "gap").length, probeErrors: results.filter((r) => r.status === "probe-error").length, results };
mkdirSync("data/audit", { recursive: true });
writeFileSync("data/audit/repository-state-audit.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.probeErrors ? 2 : report.gaps ? 1 : 0;
