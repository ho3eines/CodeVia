import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { defaultPlanFor } from "../agents/plan.js";
import { AGENT_SCAFFOLD, scaffoldFor, AGENT_TYPES } from "../agents/generator.js";
import { readFileTool } from "../tools/core-tools.js";
import type { Agent, Project, Task } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Project detail page contract: every button on the page must have a
 * working backend behind it, and every deterministic agent plan must be
 * executable by the agent it is built for (tools + permissions + inputs).
 * ------------------------------------------------------------------ */

function agent(type: Agent["type"]): Agent {
  const now = new Date().toISOString();
  const scaffold = scaffoldFor(type);
  return {
    id: `a-${type}`, projectId: "p1", type, name: type, slug: type, role: "", description: "",
    systemPrompt: "", skills: [...scaffold.skills], tools: [...scaffold.tools], permissions: [...scaffold.permissions],
    models: { primary: "m", fallbacks: [], specialized: {} },
    maxIterations: 5, timeoutMs: 1000, tokenBudget: 100, memorySources: [],
    enabled: true, version: 1, createdAt: now, updatedAt: now,
  };
}

function task(): Task {
  const now = new Date().toISOString();
  return {
    id: "t1", projectId: "p1", title: "Fix login", description: "login broken", status: "created",
    correlationId: "c", input: {}, createdAt: now, updatedAt: now,
  };
}

describe("defaultPlanFor executability (all 18 agent types)", () => {
  const types = Object.keys(AGENT_SCAFFOLD) as Agent["type"][];
  expect(types.length).toBe(18);

  it("only uses tools the agent owns and is allowed to call", () => {
    const container = new Container();
    for (const type of types) {
      const a = agent(type);
      for (const step of defaultPlanFor(a, task())) {
        if (!step.tool) continue;
        expect(a.tools, `${type} owns ${step.tool}`).toContain(step.tool);
        const def = container.toolRegistry.get(step.tool);
        expect(def, `${step.tool} is registered`).toBeDefined();
        expect(container.toolRegistry.isAllowed(def!, a), `${type} may call ${step.tool}`).toBe(true);
      }
    }
  });

  it("never shells out to run_tests/run_build (no isolated workspace yet)", () => {
    for (const type of types) {
      const tools = defaultPlanFor(agent(type), task()).map((s) => s.tool).filter(Boolean);
      expect(tools, type).not.toContain("run_tests");
      expect(tools, type).not.toContain("run_build");
    }
  });

  it("gives every save_memory step a complete input (key + content)", () => {
    for (const type of types) {
      for (const step of defaultPlanFor(agent(type), task())) {
        if (step.tool !== "save_memory") continue;
        expect(String(step.input?.key ?? ""), `${type} memory key`).not.toBe("");
        expect(String(step.input?.content ?? ""), `${type} memory content`).not.toBe("");
      }
    }
  });

  it("lets writers finish with an approval-gated PR and keeps readers PR-free", () => {
    for (const type of types) {
      const plan = defaultPlanFor(agent(type), task());
      const pr = plan.find((s) => s.tool === "create_pull_request");
      const a = agent(type);
      const mayWrite = a.permissions.includes("github.write") || a.permissions.includes("repository.write");
      if (mayWrite && a.tools.includes("create_pull_request")) {
        expect(pr, `${type} ends with PR`).toBeDefined();
        expect(pr!.requiresApproval, `${type} PR is gated`).toBe(true);
      } else {
        expect(pr, `${type} has no PR step`).toBeUndefined();
        expect(plan.map((s) => s.tool)).not.toContain("write_file");
      }
    }
  });
});

describe("read_file safe default", () => {
  const project = { configRepo: "acme/demo", branch: "main" } as Project;
  const baseCtx = { project, agent: agent("research"), correlationId: "c", logger: { info() {}, warn() {} } } as unknown as Parameters<typeof readFileTool.execute>[0];

  it("reads the project brief when no path is given", async () => {
    const res = await readFileTool.execute(
      { ...baseCtx, github: { getFile: async (_r: unknown, p: string) => (p === "Agent.md" ? { content: "# brief", sha: "1" } : undefined) } as never },
      {},
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("brief");
  });

  it("succeeds (not fails) on an empty repository", async () => {
    const res = await readFileTool.execute(
      { ...baseCtx, github: { getFile: async () => undefined, listFiles: async () => [] } as never },
      {},
    );
    expect(res.ok).toBe(true);
  });

  it("still fails for an explicit path that does not exist", async () => {
    const res = await readFileTool.execute(
      { ...baseCtx, github: { getFile: async () => undefined } as never },
      { path: "nope.ts" },
    );
    expect(res.ok).toBe(false);
  });
});

describe("agent run → memory DB index", () => {
  let fx: ReturnType<typeof freshDb>;
  let container: Container;
  beforeEach(async () => {
    fx = freshDb();
    container = new Container();
    await container.ensureSeed();
  });
  afterEach(() => fx.cleanup());

  it("mirrors a qa-test run's saved findings into the memory index", async () => {
    const project = await container.agentManager.createProject({
      name: "Memory App", description: "app", configRepo: "acme/memory",
    });
    const t = container.agentManager.createTask({
      projectId: project.id, title: "Run the auth test suite",
      description: "run tests", agentType: "qa-test",
    });
    const result = await container.agentManager.runTask(t.id);
    expect(result.status).toBe("succeeded");
    const entries = container.memoryRepo.byProject(project.id);
    expect(entries.some((e) => e.source === "agent:qa-test" && e.key.includes(t.id))).toBe(true);
  });
});

describe("project detail API", () => {
  let cleanup: (() => void) | undefined;
  let app: FastifyInstance | undefined;
  let container: Container;
  const ENV_KEYS = ["REQUIRE_AUTH", "OPENAI_API_KEY"] as const;
  let savedEnv: Record<string, string | undefined>;

  async function boot(): Promise<FastifyInstance> {
    container = new Container();
    await container.ensureSeed();
    app = (await buildServer(container)).app;
    await app.ready();
    return app;
  }

  async function makeProject(srv: FastifyInstance): Promise<string> {
    const res = await srv.inject({
      method: "POST", url: "/projects",
      payload: { name: "Detail App", description: "detail", configRepo: "acme/detail" },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    getEnvFresh();
    cleanup = freshDb().cleanup;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    getEnvFresh();
    cleanup?.();
  });

  it("serves the overview aggregate + commits + branches", async () => {
    const srv = await boot();
    const id = await makeProject(srv);
    const ob = await srv.inject({ method: "POST", url: `/projects/${id}/onboard`, payload: {} });
    expect(ob.statusCode).toBe(200);

    const ov = await srv.inject({ method: "GET", url: `/projects/${id}/overview` });
    expect(ov.statusCode).toBe(200);
    const body = ov.json() as Record<string, unknown>;
    for (const key of ["project", "status", "counts", "testStatus", "openIssues", "openPRs", "recentCommits", "recentRuns", "activity", "cost", "budget"]) {
      expect(body, `overview.${key}`).toHaveProperty(key);
    }
    expect((body.counts as Record<string, number>).agents).toBeGreaterThanOrEqual(10);

    const branches = await srv.inject({ method: "GET", url: `/projects/${id}/branches` });
    expect(branches.statusCode).toBe(200);
    expect((branches.json() as Array<{ name: string }>).some((b) => b.name === "main")).toBe(true);

    const commits = await srv.inject({ method: "GET", url: `/projects/${id}/commits?limit=5` });
    expect(commits.statusCode).toBe(200);
    expect(Array.isArray(commits.json())).toBe(true);
  });

  it("creates issues and pull requests", async () => {
    const srv = await boot();
    const id = await makeProject(srv);
    await srv.inject({ method: "POST", url: `/projects/${id}/onboard`, payload: {} });

    const issue = await srv.inject({
      method: "POST", url: `/projects/${id}/issues`,
      payload: { title: "Login broken", body: "repro" },
    });
    expect(issue.statusCode).toBe(201);
    expect((issue.json() as { number: number }).number).toBe(1);

    const pr = await srv.inject({
      method: "POST", url: `/projects/${id}/pull-requests`,
      payload: { title: "Fix login", head: "fix/login", base: "main" },
    });
    expect(pr.statusCode).toBe(201);
    expect((pr.json() as { number: number }).number).toBe(1);

    const missing = await srv.inject({
      method: "POST", url: `/projects/${id}/issues`, payload: { title: "" },
    });
    expect(missing.statusCode).toBe(400);
  });

  it("attaches and detaches skills", async () => {
    const srv = await boot();
    const id = await makeProject(srv);
    const attach = await srv.inject({
      method: "POST", url: `/projects/${id}/skills`, payload: { slug: "testing" },
    });
    expect(attach.statusCode).toBe(200);
    expect(attach.json()).toContain("testing");

    const detach = await srv.inject({ method: "DELETE", url: `/projects/${id}/skills/testing` });
    expect(detach.statusCode).toBe(200);
    expect(detach.json()).not.toContain("testing");

    const unknown = await srv.inject({
      method: "POST", url: `/projects/${id}/skills`, payload: { slug: "nope" },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("creates tasks with priority and edits + deletes them", async () => {
    const srv = await boot();
    const id = await makeProject(srv);
    const created = await srv.inject({
      method: "POST", url: "/tasks",
      payload: { projectId: id, title: "T", description: "d", priority: "high" },
    });
    expect(created.statusCode).toBe(200);
    const tid = (created.json() as { id: string; priority: string }).id;
    expect((created.json() as { priority: string }).priority).toBe("high");

    const patched = await srv.inject({
      method: "PATCH", url: `/tasks/${tid}`, payload: { title: "T2", priority: "critical" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { title: string }).title).toBe("T2");

    expect((await srv.inject({ method: "PATCH", url: "/tasks/missing", payload: { title: "x" } })).statusCode).toBe(404);

    const del = await srv.inject({ method: "DELETE", url: `/tasks/${tid}` });
    expect(del.statusCode).toBe(200);
    expect((await srv.inject({ method: "DELETE", url: `/tasks/${tid}` })).statusCode).toBe(404);
  });

  it("edits memory entries with version bumps", async () => {
    const srv = await boot();
    const id = await makeProject(srv);
    const created = await srv.inject({
      method: "POST", url: "/memory",
      payload: { projectId: id, scope: "project", type: "decision", key: "k", content: "v1" },
    });
    expect(created.statusCode).toBe(200);
    const mid = (created.json() as { id: string }).id;

    const patched = await srv.inject({
      method: "PATCH", url: `/memory/${mid}`, payload: { content: "v2" },
    });
    expect(patched.statusCode).toBe(200);
    const body = patched.json() as { content: string; version: number };
    expect(body.content).toBe("v2");
    expect(body.version).toBe(2);
  });

  it("creates agents from scaffold defaults and validates input", async () => {
    const srv = await boot();
    const id = await makeProject(srv);
    const created = await srv.inject({
      method: "POST", url: "/agents", payload: { projectId: id, type: "security" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { tools: string[]; permissions: string[]; name: string };
    expect(body.name).toContain("Security");
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.permissions).toContain("github.read");

    expect((await srv.inject({ method: "POST", url: "/agents", payload: { projectId: "nope", type: "security" } })).statusCode).toBe(404);
    expect((await srv.inject({ method: "POST", url: "/agents", payload: { projectId: id, type: "nope" } })).statusCode).toBe(400);

    const types = await srv.inject({ method: "GET", url: "/agents/types" });
    expect(types.statusCode).toBe(200);
    expect((types.json() as unknown[]).length).toBe(AGENT_TYPES.length);

    const tools = await srv.inject({ method: "GET", url: "/tools" });
    expect(tools.statusCode).toBe(200);
    expect((tools.json() as Array<{ name: string }>).map((t) => t.name)).toContain("save_memory");
  });

  it("patches project defaults with validation", async () => {
    const srv = await boot();
    const id = await makeProject(srv);
    const agents = (await srv.inject({ method: "GET", url: `/projects/${id}/agents` }).then((r) => r.json())) as Array<{ id: string }>;
    expect(agents.length).toBeGreaterThan(0);

    const ok = await srv.inject({
      method: "PATCH", url: `/projects/${id}`,
      payload: { defaultAgentId: agents[0].id, memoryRepo: "acme/memory" },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { defaultAgentId: string }).defaultAgentId).toBe(agents[0].id);

    const badAgent = await srv.inject({
      method: "PATCH", url: `/projects/${id}`, payload: { defaultAgentId: "nope" },
    });
    expect(badAgent.statusCode).toBe(400);

    const badRepo = await srv.inject({
      method: "PATCH", url: `/projects/${id}`, payload: { memoryRepo: "not-a-repo" },
    });
    expect(badRepo.statusCode).toBe(400);
  });
});
