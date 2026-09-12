#!/usr/bin/env node
/**
 * Independent completeness probes, NOT the green regression suite.
 * Run: node --import tsx scripts/audit-pipeline.mjs
 * Exits 1 when a required behavior is missing, 2 for a broken probe.
 * All application state is temporary. Providers/GitHub are fixtures; outbound
 * fetch is prohibited. One realtime probe uses a short-lived loopback client.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of [
  "GITHUB_TOKEN",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
])
  delete process.env[key];
Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  REQUIRE_AUTH: "false",
  GITHUB_ENABLED: "false",
  TELEGRAM_MODE: "off",
  AUTH_SECRET: "isolated-pipeline-audit-fixture-not-a-real-secret-2026",
});
globalThis.fetch = async () => {
  throw new Error("Outbound fetch is disabled in the completeness audit");
};

const { Container } = await import("../src/app/container.ts");
const { Db, setDbForTest } = await import("../src/db/client.ts");
const { JobQueue } = await import("../src/db/queue.ts");
const { getEnvFresh } = await import("../src/config/env.ts");
const { buildServer } = await import("../src/http/app.ts");
const { AgentGenerator } = await import("../src/agents/generator.ts");
const { toCandidate } = await import("../src/ai/model-router.ts");
const { parseMemoryFile, renderMemoryFile, MEMORY_FILE } = await import("../src/github/project-files.ts");
const { signSession } = await import("../src/auth/github-oauth.ts");
const { ToolRegistry } = await import("../src/tools/registry.ts");
const { createLogger } = await import("../src/logger.ts");
const { live } = await import("../src/realtime/live.ts");
const { io: clientIO } = await import("socket.io-client");

const results = [];
async function probe(id, severity, title, expected, files, run) {
  try {
    const { ok, evidence } = await run();
    results.push({ id, severity, title, expected, status: ok ? "pass" : "gap", evidence, files });
  } catch (error) {
    results.push({ id, severity, title, expected, status: "probe-error", error: String(error), files });
  }
}

async function fixture(run, projectInput = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codevia-audit-"));
  Object.assign(process.env, {
    DATABASE_PATH: join(dir, "runtime.db"),
    MOCK_GITHUB_PATH: join(dir, "github.json"),
    REQUIRE_AUTH: "false",
  });
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  getEnvFresh();
  const db = new Db(process.env.DATABASE_PATH);
  setDbForTest(db);
  const c = new Container();
  await c.ensureSeed();
  if (c.github.kind !== "mock") throw new Error("The audit requires Mock GitHub");
  const { app, io } = await buildServer(c);
  await app.ready();
  try {
    const p = await c.agentManager.createProject({
      name: "Isolated Audit",
      description: "Audit fixture",
      configRepo: "audit/local",
      capabilities: { platforms: ["web"], languages: ["typescript"], frameworks: ["react", "fastify"] },
      ...projectInput,
    });
    return await run({ c, p, app, io, db });
  } finally {
    c.githubAutomation.stop();
    io.close();
    await app.close();
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function strictAuth() {
  Object.assign(process.env, {
    REQUIRE_AUTH: "true",
    GITHUB_CLIENT_ID: "audit-dummy-client",
    GITHUB_CLIENT_SECRET: "audit-dummy-client-secret",
  });
  getEnvFresh();
}
const refs = (c) => ({
  projectRepo: c.projectRepo,
  taskRepo: c.taskRepo,
  agentRepo: c.agentRepo,
  memoryRepo: c.memoryRepo,
});
const backendItem = {
  id: "api",
  agentType: "backend-developer",
  title: "Implement login endpoint",
  description: "Implement the specified session contract",
  files: ["src/services/session-service.ts"],
  dependsOn: [],
  acceptanceCriteria: ["Invalid login returns 401"],
  skills: ["nodejs", "security"],
};

function model(c, providerId, label, priority = 1) {
  return c.modelRepo.create({
    providerId,
    modelId: label,
    displayName: label,
    contextWindow: 128000,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: {
      code: true,
      reasoning: true,
      tools: false,
      structuredOutput: true,
      streaming: false,
      vision: false,
    },
    active: true,
    priority,
    fallbackPriority: priority,
    tags: [],
  });
}
async function canned(
  c,
  p,
  items = [backendItem],
  brief = "Requirements: implement login. Acceptance: reject invalid credentials.",
) {
  const provider = c.providerRepo.create({
    name: "Audit fixture",
    type: "openai",
    authType: "none",
    apiFormat: "openai",
    active: true,
    timeoutMs: 1000,
    maxTokensDefault: 8000,
    defaultTemperature: 0.2,
    rateLimitPerMinute: 100,
  });
  const requests = [];
  c.providerRegistry.register({
    id: provider.id,
    name: "Offline audit fixture",
    type: "openai",
    health: async () => true,
    listModels: async () => [],
    resolveApiKey: () => undefined,
    chat: async (req) => {
      requests.push(req);
      const system = req.messages[0].content;
      const content = system.includes("business analyst writing")
        ? brief
        : system.includes("engineering manager") || system.includes("single-agent implementation")
          ? JSON.stringify(items)
          : "// AUDIT_UNIQUE_SESSION_CONTRACT_42\nexport const acceptsInvalidLogin = true;\n";
      return {
        content,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        modelId: req.modelId,
        providerId: provider.id,
      };
    },
  });
  for (const type of ["research", "backend-developer", "frontend-developer", "qa-test"]) {
    const m = model(c, provider.id, `audit-${type}`);
    const agent = c.agentRepo.byType(p.id, type);
    c.agentRepo.upsert({ ...agent, models: { primary: m.id, fallbacks: [], specialized: {} } }, { projectId: p.id });
  }
  await c.agentManager.syncProjectState(p.id);
  return requests;
}
const autonomous = (c, p, input = {}) =>
  c.agentManager.createTask({
    projectId: p.id,
    title: "Implement login",
    description: "Reject invalid credentials",
    input: { executionMode: "autonomous", ...input },
  });

await probe(
  "A01",
  "critical",
  "Strict authentication cannot be bypassed by a caller-supplied identity header",
  "Unauthenticated API requests remain 401 even when an arbitrary x-user-id is supplied",
  ["src/http/auth.ts", "src/http/app.ts"],
  () =>
    fixture(async ({ app }) => {
      strictAuth();
      const anonymous = await app.inject({ method: "GET", url: "/admin/settings" });
      const spoofed = await app.inject({
        method: "GET",
        url: "/admin/settings",
        headers: { "x-user-id": "audit-untrusted-caller" },
      });
      return {
        ok: anonymous.statusCode === 401 && spoofed.statusCode === 401,
        evidence: { anonymousStatus: anonymous.statusCode, spoofedHeaderStatus: spoofed.statusCode },
      };
    }),
);

await probe(
  "A02",
  "critical",
  "Project ownership and viewer permissions are enforced beyond list filtering",
  "A signed-in viewer cannot read or modify a different owner's project",
  ["src/http/app.ts", "src/http/routes/projects.ts", "src/http/auth.ts"],
  () =>
    fixture(async ({ c, p, app }) => {
      const owner = c.userRepo.upsertGitHubUser({
        id: 1,
        login: "audit-owner",
        name: "Owner",
        email: "owner@invalid.test",
      }).user;
      const second = c.userRepo.upsertGitHubUser({
        id: 2,
        login: "audit-viewer",
        name: "Viewer",
        email: "viewer@invalid.test",
      }).user;
      c.userRepo.upsert({ ...second, role: "viewer" });
      c.projectRepo.upsert({ ...p, ownerId: owner.id }, { key: p.slug });
      strictAuth();
      const headers = { authorization: `Bearer ${signSession(second.id)}` };
      const list = await app.inject({ method: "GET", url: "/projects", headers });
      const read = await app.inject({ method: "GET", url: `/projects/${p.id}`, headers });
      const patch = await app.inject({
        method: "PATCH",
        url: `/projects/${p.id}`,
        headers,
        payload: { description: "AUDIT_UNAUTHORIZED_UPDATE" },
      });
      return {
        ok: [403, 404].includes(read.statusCode) && [403, 404].includes(patch.statusCode),
        evidence: {
          hiddenInList: !list.json().some((x) => x.id === p.id),
          directReadStatus: read.statusCode,
          viewerPatchStatus: patch.statusCode,
          descriptionChanged: c.projectRepo.findById(p.id).data.description === "AUDIT_UNAUTHORIZED_UPDATE",
        },
      };
    }),
);

await probe(
  "A03",
  "critical",
  "Realtime events respect authentication and project boundaries",
  "An anonymous socket cannot receive project-specific step data",
  ["src/http/app.ts", "src/realtime/live.ts"],
  () =>
    fixture(async ({ app, p }) => {
      strictAuth();
      await app.listen({ host: "0.0.0.0", port: 0 });
      const socket = clientIO(`http://127.0.0.1:${app.server.address().port}`, {
        transports: ["websocket"],
        reconnection: false,
        timeout: 1500,
        autoConnect: false,
      });
      let timer;
      try {
        const result = await new Promise((resolve) => {
          timer = setTimeout(() => resolve({ connected: socket.connected, received: false }), 1800);
          socket.on("connect_error", () => resolve({ connected: false, received: false }));
          socket.on("step.updated", (event) =>
            resolve({ connected: true, received: event.data?.detail === "AUDIT_PRIVATE_CODE_MARKER" }),
          );
          socket.on("connect", () =>
            live.emit({
              type: "step.updated",
              runId: "audit-private-run",
              data: { projectId: p.id, detail: "AUDIT_PRIVATE_CODE_MARKER" },
            }),
          );
          socket.connect();
        });
        return { ok: !result.received, evidence: result };
      } finally {
        clearTimeout(timer);
        socket.disconnect();
      }
    }),
);

await probe(
  "A04",
  "high",
  "Queued merges validate an approved, matching approval record",
  "An invented approval id never invokes the GitHub merge adapter",
  ["src/workers/worker.ts"],
  () =>
    fixture(async ({ c, p }) => {
      let calls = 0;
      c.github.mergePullRequest = async () => {
        calls++;
        return { merged: true, sha: "audit-fixture-sha" };
      };
      const job = c.queue.enqueue("github.op", {
        op: "merge_pr",
        projectId: p.id,
        number: 1,
        approvalId: "nonexistent-audit-approval",
        notify: false,
      });
      c.queue.claim(1);
      await c.worker.process(job.id);
      return {
        ok: calls === 0,
        evidence: {
          mergeAdapterCalls: calls,
          jobStatus: c.queue.getById(job.id).status,
          approvalExists: !!c.approvals.get("nonexistent-audit-approval"),
        },
      };
    }),
);

await probe(
  "A05",
  "high",
  "Re-onboarding preserves manual agent settings and restrictions",
  "Editing project capabilities must not reset custom prompts, models, tools, disabled status or limits",
  ["src/agents/generator.ts", "src/http/routes/projects.ts"],
  () =>
    fixture(async ({ c, p, app }) => {
      const agent = c.agentRepo.byType(p.id, "backend-developer");
      const custom = {
        ...agent,
        systemPrompt: "AUDIT_MANUAL_PROMPT",
        projectPrompt: "AUDIT_MANUAL_PROJECT_PROMPT",
        models: { primary: "model-mock-reasoning", fallbacks: [], specialized: {} },
        tools: ["read_file"],
        permissions: ["github.read"],
        maxIterations: 2,
        timeoutMs: 9000,
        tokenBudget: 4000,
        enabled: false,
      };
      c.agentRepo.upsert(custom, { projectId: p.id });
      const response = await app.inject({
        method: "PATCH",
        url: `/projects/${p.id}`,
        payload: { capabilities: { features: ["authentication"] } },
      });
      const current = c.agentRepo.findById(agent.id).data;
      const changed = [
        "systemPrompt",
        "projectPrompt",
        "models",
        "tools",
        "permissions",
        "maxIterations",
        "timeoutMs",
        "tokenBudget",
        "enabled",
      ].filter((key) => JSON.stringify(current[key]) !== JSON.stringify(custom[key]));
      return {
        ok: response.statusCode === 200 && !changed.length,
        evidence: {
          responseStatus: response.statusCode,
          overwrittenFields: changed,
          writePermissionReintroduced: current.permissions.includes("github.write"),
        },
      };
    }),
);

await probe(
  "A06",
  "high",
  "Manually created agents are actually indexed in their project",
  "POST /agents creates an agent visible in the project roster and routing lookup",
  ["src/agents/agent-repo.ts", "src/http/routes/agents.ts"],
  () =>
    fixture(async ({ c, p, app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/agents",
        payload: { projectId: p.id, type: "backend-developer", name: "Audit custom agent" },
      });
      const created = response.json();
      const listed = c.agentRepo.byProject(p.id).some((a) => a.id === created.id);
      return {
        ok: response.statusCode === 201 && listed,
        evidence: {
          createStatus: response.statusCode,
          retrievableById: !!c.agentRepo.findById(created.id),
          includedInProjectRoster: listed,
          selectedByType: c.agentRepo.byType(p.id, "backend-developer")?.id === created.id,
        },
      };
    }),
);

await probe(
  "A07",
  "high",
  "A project default model is not overridden by an automatically chosen specialization",
  "A capable selected default remains the first coding model until a human assigns a specialization, regardless of catalog insertion order",
  ["src/agents/generator.ts", "src/ai/model-router.ts", "src/http/routes/projects.ts"],
  () =>
    fixture(async ({ c }) => {
      const chosen = model(c, "provider-mock", "audit-selected", 20);
      // listActive is ordered by record creation time. Separate the timestamps so
      // this case covers choosing an existing model after adding another model,
      // rather than accidentally testing a tie between millisecond timestamps.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const other = model(c, "provider-mock", "audit-unselected", 0);
      const generator = new AgentGenerator(c.agentRepo, c.skillRepo, c.modelRepo);
      const available = [other, chosen].map(toCandidate);
      const selectedOlder = generator.modelsFor(chosen.id, "backend-developer");
      const selectedNewest = generator.modelsFor(other.id, "backend-developer");
      const routedOlder = c.modelRouter.route(available, selectedOlder, "coding");
      const routedNewest = c.modelRouter.route(available, selectedNewest, "coding");
      return {
        ok: routedOlder[0]?.id === chosen.id && routedNewest[0]?.id === other.id,
        evidence: {
          olderSelectedPrimary: selectedOlder.primary === chosen.id,
          olderSelectedSpecialized: selectedOlder.specialized.coding === chosen.id,
          firstCodingModelWhenOlderSelected: routedOlder[0]?.modelId,
          newerSelectionRespected: routedNewest[0]?.id === other.id,
          note: "Positive control: selecting the newest model works; selecting an older capable model reveals the automatic specialization override.",
        },
      };
    }),
);

await probe(
  "A08",
  "high",
  "GitHub restore preserves custom skill definitions, not just slugs",
  "A project can rehydrate its attached skill instructions and dependencies from CodeVia files",
  ["src/github/project-files.ts", "src/agents/manager.ts"],
  () =>
    fixture(async ({ c, p, app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/skills",
        payload: {
          slug: "audit-company-policy",
          name: "Company policy",
          instructions: "AUDIT_REQUIRED_COMPANY_POLICY",
          dependencies: ["security"],
          compatibleAgentTypes: ["backend-developer"],
        },
      });
      const skill = response.json();
      await app.inject({ method: "POST", url: `/projects/${p.id}/skills`, payload: { slug: skill.slug } });
      const latest = c.projectRepo.findById(p.id).data;
      c.skillRepo.deleteById(skill.id);
      await c.projectFiles.restore(latest, refs(c), { includeTasks: false });
      // Definitions rehydrate into the project's own skill namespace (they were
      // synced under CodeVia/skills/<slug>.md); the global catalog keeps only
      // marketplace templates that were never attached to a project.
      const restored = c.skillRepo.findBySlug(skill.slug, p.id);
      return {
        ok: restored?.instructions === "AUDIT_REQUIRED_COMPANY_POLICY" && restored.dependencies.includes("security"),
        evidence: {
          attachedSlugRestored: c.projectRepo.findById(p.id).data.settings.skills.includes(skill.slug),
          definitionRestored: restored?.instructions === "AUDIT_REQUIRED_COMPANY_POLICY",
          dependenciesRestored: restored?.dependencies.includes("security") ?? false,
        },
      };
    }),
);

await probe(
  "A09",
  "high",
  "Memory containing Markdown headings round-trips without data loss",
  "Research findings, risks and decisions survive a render/parse cycle",
  ["src/github/project-files.ts"],
  async () => {
    const content = "Summary\n\n## Risks\nAUDIT_REQUIRED_RISK\n\n### Details\nAUDIT_REQUIRED_DETAIL";
    const entry = {
      id: "audit-memory",
      projectId: "audit-project",
      scope: "project",
      type: "knowledge",
      key: "research/brief",
      content,
      version: 1,
      tags: [],
      refs: [],
      source: "audit",
      createdAt: "t",
      updatedAt: "t",
    };
    const restored = parseMemoryFile(renderMemoryFile([entry]));
    return {
      ok: restored[0]?.content === content,
      evidence: {
        originalCharacters: content.length,
        restoredCharacters: restored[0]?.content.length,
        riskPreserved: restored[0]?.content.includes("AUDIT_REQUIRED_RISK"),
      },
    };
  },
);

await probe(
  "A10",
  "high",
  "Restored memory IDs are project-unique",
  "Two projects can restore the same memory key without deleting each other's entry",
  ["src/github/project-files.ts", "src/db/repository.ts"],
  () =>
    fixture(async ({ c, p }) => {
      const other = await c.agentManager.createProject({
        name: "Other Audit",
        description: "Other fixture",
        configRepo: "audit/other",
      });
      for (const project of [p, other]) {
        const entry = {
          id: `audit-${project.id}`,
          projectId: project.id,
          scope: "project",
          type: "decision",
          key: "shared-key",
          content: project.id,
          tags: [],
          refs: [],
          source: "audit",
          version: 1,
          createdAt: "t",
          updatedAt: "t",
        };
        const [owner, name] = project.configRepo.split("/");
        await c.github.commit({ owner, name }, project.branch, "audit memory fixture", [
          { path: MEMORY_FILE, content: renderMemoryFile([entry]) },
        ]);
        await c.projectFiles.restore(project, refs(c), { includeTasks: false });
      }
      const counts = [p, other].map(
        (project) => c.memoryRepo.byProject(project.id).filter((e) => e.key === "shared-key").length,
      );
      return { ok: counts.every((count) => count === 1), evidence: { entriesPerProject: counts } };
    }),
);

await probe(
  "A11",
  "high",
  "Manual Pull cannot resurrect a cancelled live task",
  "The pull route must preserve runtime cancellation while refreshing configuration",
  ["src/http/routes/projects.ts", "src/github/project-files.ts"],
  () =>
    fixture(async ({ c, p, app }) => {
      const task = autonomous(c, p);
      await c.agentManager.syncTaskFile(p.id, task);
      const cancel = await app.inject({ method: "POST", url: `/tasks/${task.id}/cancel` });
      if (cancel.statusCode !== 200 || cancel.json().status !== "cancelled")
        throw new Error("Cancellation fixture did not reach cancelled state");
      const response = await app.inject({ method: "POST", url: `/projects/${p.id}/pull` });
      const status = c.taskRepo.findById(task.id).data.status;
      return {
        ok: status === "cancelled",
        evidence: {
          cancelStatus: cancel.statusCode,
          pullStatus: response.statusCode,
          statusBeforePull: "cancelled",
          statusAfterPull: status,
        },
      };
    }),
);

await probe(
  "A12",
  "high",
  "Abandoned running jobs have a recovery path",
  "A recreated worker/queue can resolve abandoned jobs instead of permanently blocking retry",
  ["src/db/queue.ts", "src/workers/worker.ts", "src/index.ts", "src/http/routes/tasks-runs.ts"],
  () =>
    fixture(async ({ c, p, app, db }) => {
      const task = autonomous(c, p);
      const job = c.queue.enqueue("agent.run", { taskId: task.id });
      c.queue.claim(1);
      c.taskRepo.upsert({ ...task, status: "running" }, { projectId: p.id });
      db.run("UPDATE jobs SET started_at = '2000-01-01T00:00:00Z' WHERE id = :id", { id: job.id });
      const recreated = new JobQueue(db);
      const claim = recreated.claim(1);
      const retry = await app.inject({ method: "POST", url: `/tasks/${task.id}/run` });
      return {
        ok: claim.length > 0 || retry.statusCode < 400,
        evidence: {
          jobAfterQueueRecreation: recreated.getById(job.id).status,
          reclaimedJobs: claim.length,
          manualRetryStatus: retry.statusCode,
          note: "Queue-instance recreation probe; startup source also contains no lease/recovery step.",
        },
      };
    }),
);

await probe(
  "A13",
  "high",
  "A blocking research result stops implementation until clarification",
  "A brief explicitly forbidding implementation causes a blocked/waiting result and no source writes",
  ["src/agents/planning.ts", "src/agents/orchestrator.ts"],
  () =>
    fixture(async ({ c, p }) => {
      await canned(
        c,
        p,
        [backendItem],
        "BLOCKER: the authentication contract is unknown. Ask the user for clarification. Do not implement any file until answered.",
      );
      const result = await c.agentManager.runTask(autonomous(c, p).id);
      const writes = c.runRepo
        .byProject(p.id)
        .flatMap((r) => r.steps)
        .filter((step) => step.tool === "write_file" && step.status === "succeeded").length;
      return {
        ok: writes === 0,
        evidence: {
          taskStatus: result.status,
          sourceWriteSteps: writes,
          researchExplicitlyBlocked: String(result.input.researchBrief).includes("BLOCKER"),
        },
      };
    }),
);

await probe(
  "A14",
  "high",
  "Dependency handoff includes producer code even when filenames differ",
  "A same-repository frontend consumer receives its backend dependency's contract, not just entity-name matches",
  ["src/agents/orchestrator.ts", "src/agents/context.ts"],
  () =>
    fixture(async ({ c, p }) => {
      const ui = {
        id: "ui",
        agentType: "frontend-developer",
        title: "Implement login form",
        description: "Consume the backend session contract",
        files: ["public/signin-view.tsx"],
        dependsOn: ["api"],
        acceptanceCriteria: ["Display failed login"],
        skills: ["react"],
      };
      const requests = await canned(c, p, [backendItem, ui]);
      const done = await c.agentManager.runTask(autonomous(c, p).id);
      const request = requests.find((req) => req.modelId === "audit-frontend-developer");
      const sawContract = request?.messages.some((m) => m.content.includes("AUDIT_UNIQUE_SESSION_CONTRACT_42"));
      return {
        ok: !!sawContract,
        evidence: {
          taskStatus: done.status,
          frontendSawBackendContent: !!sawContract,
          dependencyDeclared: true,
          backendPath: backendItem.files[0],
          frontendPath: ui.files[0],
        },
      };
    }),
);

await probe(
  "A15",
  "high",
  "Autonomous QA independently evaluates acceptance criteria",
  "A QA model review or an explicit criterion-to-test evidence check is performed, not just storing criteria",
  ["src/agents/orchestrator.ts", "src/agents/runner.ts", "src/tools/github-checks.ts"],
  () =>
    fixture(async ({ c, p }) => {
      const requests = await canned(c, p);
      const done = await c.agentManager.runTask(autonomous(c, p).id);
      const qa = c.runRepo.byProject(p.id).find((r) => r.agentType === "qa-test");
      const qaCalls = requests.filter((r) => r.modelId === "audit-qa-test").length;
      return {
        ok: qaCalls > 0,
        evidence: {
          qaCalls,
          qaTokens: qa?.totalTokens,
          qaTools: qa?.steps.map((s) => s.tool),
          taskStatus: done.status,
          verification: done.result?.verification,
          note: "Mock CI is intentionally simulated; source inspection confirms no separate acceptance-verdict evaluator.",
        },
      };
    }),
);

await probe(
  "A16",
  "high",
  "Research sees linked implementation repositories before planning",
  "The existing backend tree is included when the configuration and backend repositories differ",
  ["src/agents/orchestrator.ts", "src/agents/context.ts"],
  () =>
    fixture(
      async ({ c, p }) => {
        const target = "src/ExistingAuthEntry.ts";
        await c.github.commit({ owner: "audit", name: "backend" }, "main", "audit existing backend", [
          { path: target, content: "export const existingAuth = true;" },
        ]);
        const requests = await canned(c, p);
        await c.agentManager.runTask(autonomous(c, p).id);
        const planning = requests.find((r) => r.messages[0].content.includes("engineering manager"));
        const known = planning.messages.some((m) => m.content.includes(target));
        return {
          ok: known,
          evidence: {
            planningSawExistingBackendPath: known,
            linkedRepositories: p.repositories.map((r) => r.repo),
            existingFile: target,
          },
        };
      },
      {
        repositories: [
          { repo: "audit/config", branch: "main", role: "primary", isConfigRepo: true },
          { repo: "audit/backend", branch: "main", role: "backend" },
        ],
      },
    ),
);

await probe(
  "A17",
  "high",
  "An unimplemented workflow action cannot report success",
  "A telegram workflow node sends through an adapter or fails explicitly as unsupported",
  ["src/workflow/engine.ts", "src/workflow/graph.ts"],
  () =>
    fixture(async ({ c, p }) => {
      const workflow = c.workflowRepo.create({
        projectId: p.id,
        name: "Audit telegram node",
        slug: "audit-telegram",
        description: "Fixture only",
        enabled: true,
        nodes: [
          {
            id: "send",
            name: "Send Telegram",
            type: "telegram",
            config: { chatId: "audit-chat", text: "Audit message" },
            retries: 0,
          },
        ],
        edges: [],
      });
      // Mirror the real POST /workflows route, which commits the definition to
      // Git before it can be run. Without the commit, runTask's project refresh
      // restores from Git and prunes the DB-only workflow, so the node never runs.
      const project = c.projectRepo.findById(p.id)?.data;
      if (!project) throw new Error("fixture project missing");
      await c.projectFiles.syncWorkflow(project, workflow);
      const task = c.agentManager.createTask({ projectId: p.id, title: "Audit node", workflowId: workflow.id });
      const before = c.telegram.sent?.length ?? 0;
      const done = await c.agentManager.runTask(task.id);
      const sent = (c.telegram.sent?.length ?? 0) - before;
      return {
        ok: done.status !== "succeeded" || sent > 0,
        evidence: { status: done.status, messagesSent: sent, nodeOutput: done.result?.outputs?.send },
      };
    }),
);

await probe(
  "A18",
  "high",
  "A tool timeout stops future side effects",
  "A timeout cancels the underlying operation instead of merely racing its promise",
  ["src/tools/registry.ts"],
  () =>
    fixture(async ({ c, p }) => {
      const tools = new ToolRegistry();
      let lateEffect = false;
      tools.register({
        name: "audit-delayed-effect",
        description: "In-memory fixture, no file/network writes",
        dangerous: false,
        permissions: [],
        inputSchema: {},
        timeoutMs: 5,
        execute: async (ctx) => {
          // Cooperative cancellation contract: observe ctx.signal and stop the
          // underlying (delayed) work when the registry aborts on timeout.
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 35);
            ctx.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
          lateEffect = true;
          return { ok: true, output: "fixture effect" };
        },
      });
      const agent = { ...c.agentRepo.byType(p.id, "research"), tools: ["audit-delayed-effect"] };
      const result = await tools.execute(
        "audit-delayed-effect",
        { project: p, agent, github: c.github, logger: createLogger(), correlationId: "audit" },
        {},
      );
      await new Promise((r) => setTimeout(r, 50));
      return {
        ok: !lateEffect,
        evidence: {
          resultOk: result.ok,
          reportedTimeout: result.output.includes("timed out"),
          effectAfterTimeout: lateEffect,
        },
      };
    }),
);

const report = {
  generatedAt: new Date().toISOString(),
  scope: "Request/settings/skills/dispatch/QA/persistence/auth completeness probes; not an exhaustive penetration test",
  externalServicesUsed: false,
  total: results.length,
  passes: results.filter((r) => r.status === "pass").length,
  gaps: results.filter((r) => r.status === "gap").length,
  probeErrors: results.filter((r) => r.status === "probe-error").length,
  results,
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.probeErrors ? 2 : report.gaps ? 1 : 0;
