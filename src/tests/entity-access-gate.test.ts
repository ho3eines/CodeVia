import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { signSession } from "../auth/github-oauth.js";
import { freshDb } from "./test-helpers.js";
import type { Run, Task } from "../domain/entities.js";

/* ------------------------------------------------------------------ *
 * S01 — direct per-entity ownership gates.
 *
 * By-id routes (/tasks/:id, /runs/:id, /conversations/:id, /approvals/:id)
 * used to rely ONLY on the global project-state preHandler, which gates
 * indirectly by resolving the entity's projectId. An entity without a
 * resolvable project slipped through that hook entirely. Every by-id handler
 * now checks `canAccessEntity` itself; these tests pin the rule down:
 *
 *   - foreign entity            → 404 (indistinguishable from "not found")
 *   - entity without a project  → 404 for signed-in accounts, visible in demo
 *   - the owner                 → full access on the same routes
 * ------------------------------------------------------------------ */

const ENV_KEYS = ["REQUIRE_AUTH", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "AUTH_SECRET"] as const;

let savedEnv: Record<string, string | undefined>;
let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;

function stubEmptyCatalog(): void {
  vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch);
}

async function boot(): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
  return app;
}

interface TestUser {
  id: string;
  bearer: Record<string, string>;
}

function makeUser(idNumber: number, login: string): TestUser {
  const { user } = container.userRepo.upsertGitHubUser({ id: idNumber, login, name: login, email: `${login}@x.test` });
  return { id: user.id, bearer: { authorization: `Bearer ${signSession(user.id)}` } };
}

async function createProject(srv: FastifyInstance, user: TestUser, name: string): Promise<string> {
  const res = await srv.inject({
    method: "POST",
    url: "/projects",
    headers: user.bearer,
    payload: { name, configRepo: `acme/${name.toLowerCase()}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function createTask(srv: FastifyInstance, user: TestUser, projectId: string, title: string): Promise<Task> {
  const res = await srv.inject({
    method: "POST",
    url: "/tasks",
    headers: user.bearer,
    payload: { projectId, title, description: "private" },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Task;
}

function insertRun(projectId: string, taskId: string, id: string): Run {
  const now = new Date().toISOString();
  const run: Run = {
    id,
    taskId,
    projectId,
    agentId: "agent-research",
    agentType: "research",
    status: "succeeded",
    steps: [],
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    costUsd: 0.001,
    durationMs: 100,
    correlationId: "corr_entitygatetest01",
    createdAt: now,
    updatedAt: now,
  };
  container.runRepo.upsert(run, { projectId });
  return run;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_SECRET = "entity-access-gate-tests-secret-0123456789";
  getEnvFresh();
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  vi.unstubAllGlobals();
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
  cleanup = undefined;
});

describe("S01 — task and run by-id routes gate directly", () => {
  it("answers 404 to a foreign account on every task and run by-id route", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(1, "gate-alice");
    const bob = makeUser(2, "gate-bob");
    const project = await createProject(srv, alice, "GateAlice");
    const task = await createTask(srv, alice, project, "Alice private task");
    const run = insertRun(project, task.id, "run-gate-001");

    for (const attempt of [
      { method: "GET", url: `/tasks/${task.id}` },
      { method: "PATCH", url: `/tasks/${task.id}`, payload: { title: "hijacked" } },
      { method: "POST", url: `/tasks/${task.id}/run`, payload: {} },
      { method: "POST", url: `/tasks/${task.id}/cancel`, payload: {} },
      { method: "DELETE", url: `/tasks/${task.id}` },
      { method: "GET", url: `/runs/${run.id}` },
      { method: "GET", url: `/runs/${run.id}/console` },
    ] as const) {
      const res = await srv.inject({ ...attempt, headers: bob.bearer });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }

    // Nothing was mutated by the attempts above.
    expect(container.taskRepo.findById(task.id)?.data.title).toBe("Alice private task");
    expect(container.taskRepo.findById(task.id)?.data.status).not.toBe("cancelled");

    // The owner keeps full access on the same routes.
    expect((await srv.inject({ method: "GET", url: `/tasks/${task.id}`, headers: alice.bearer })).statusCode).toBe(200);
    expect(
      (await srv.inject({ method: "GET", url: `/runs/${run.id}/console`, headers: alice.bearer })).statusCode,
    ).toBe(200);
    expect(
      (
        await srv.inject({
          method: "PATCH",
          url: `/tasks/${task.id}`,
          headers: alice.bearer,
          payload: { title: "Renamed" },
        })
      ).json().title,
    ).toBe("Renamed");
  });

  it("hides entities without a project from signed-in accounts but keeps demo access", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(3, "gate-detached-alice");
    const bob = makeUser(4, "gate-detached-bob");

    // A task restored from an old/foreign database snapshot can lack a project.
    const now = new Date().toISOString();
    const detached: Task = {
      id: "task-detached-001",
      projectId: "",
      title: "Detached task",
      description: "",
      status: "created",
      correlationId: "corr_detached01",
      input: {},
      createdAt: now,
      updatedAt: now,
    };
    container.taskRepo.upsert(detached);

    expect((await srv.inject({ method: "GET", url: `/tasks/${detached.id}`, headers: bob.bearer })).statusCode).toBe(
      404,
    );
    expect((await srv.inject({ method: "GET", url: `/tasks/${detached.id}`, headers: alice.bearer })).statusCode).toBe(
      404,
    );
    // Demo / single-user installs must not lose the row.
    const demoRes = await srv.inject({ method: "GET", url: `/tasks/${detached.id}` });
    expect(demoRes.statusCode).toBe(200);
    expect(demoRes.json().id).toBe(detached.id);
  });
});

describe("S01 — conversation by-id routes gate directly", () => {
  it("blocks read, summarize, message and delete of another account's conversation", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(5, "conv-alice");
    const bob = makeUser(6, "conv-bob");
    const project = await createProject(srv, alice, "ConvAlice");
    const conv = (
      await srv.inject({
        method: "POST",
        url: "/conversations",
        headers: alice.bearer,
        payload: { projectId: project, title: "Alice chat" },
      })
    ).json() as { id: string };

    for (const attempt of [
      { method: "GET", url: `/conversations/${conv.id}` },
      { method: "POST", url: `/conversations/${conv.id}/messages`, payload: { content: "hi" } },
      { method: "POST", url: `/conversations/${conv.id}/summarize`, payload: {} },
      { method: "DELETE", url: `/conversations/${conv.id}` },
    ] as const) {
      const res = await srv.inject({ ...attempt, headers: bob.bearer });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }
    expect(container.conversationRepo.findById(conv.id)).toBeDefined();

    // The owner still reads and deletes her own conversation.
    expect(
      (await srv.inject({ method: "GET", url: `/conversations/${conv.id}`, headers: alice.bearer })).statusCode,
    ).toBe(200);
    expect(
      (await srv.inject({ method: "DELETE", url: `/conversations/${conv.id}`, headers: alice.bearer })).statusCode,
    ).toBe(200);
    expect(container.conversationRepo.findById(conv.id)).toBeUndefined();
  });

  it("keeps standalone (project-less) chats user-scoped", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(7, "solo-alice");
    const bob = makeUser(8, "solo-bob");
    const conv = (
      await srv.inject({
        method: "POST",
        url: "/conversations",
        headers: alice.bearer,
        payload: { title: "Alice standalone chat" },
      })
    ).json() as { id: string };

    expect(
      (await srv.inject({ method: "GET", url: `/conversations/${conv.id}`, headers: bob.bearer })).statusCode,
    ).toBe(404);
    expect(
      (await srv.inject({ method: "DELETE", url: `/conversations/${conv.id}`, headers: bob.bearer })).statusCode,
    ).toBe(404);
    expect(
      (await srv.inject({ method: "GET", url: `/conversations/${conv.id}`, headers: alice.bearer })).statusCode,
    ).toBe(200);
    // Demo keeps seeing everything (single-user install contract).
    expect((await srv.inject({ method: "GET", url: `/conversations/${conv.id}` })).statusCode).toBe(200);
  });
});

describe("S01 — approvals of a foreign project are hidden", () => {
  it("answers 404 for read/decide on another account's approval and lets the owner decide", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const alice = makeUser(9, "appr-alice");
    const bob = makeUser(10, "appr-bob");
    const project = await createProject(srv, alice, "ApprAlice");
    const task = await createTask(srv, alice, project, "Approval task");

    container.approvals.setPolicy({ autoApprove: false, timeoutMs: 60_000 });
    const waiting = container.approvals.request("Write files", { projectId: project, taskId: task.id });
    const approval = container.approvals.list({ projectId: project })[0];
    expect(approval).toBeDefined();

    expect(
      (await srv.inject({ method: "GET", url: `/approvals/${approval.id}`, headers: bob.bearer })).statusCode,
    ).toBe(404);
    expect(
      (await srv.inject({ method: "POST", url: `/approvals/${approval.id}/approve`, headers: bob.bearer, payload: {} }))
        .statusCode,
    ).toBe(404);
    expect(container.approvals.get(approval.id)?.status).toBe("pending");

    // The owning account reads and decides its own approval.
    expect(
      (await srv.inject({ method: "GET", url: `/approvals/${approval.id}`, headers: alice.bearer })).statusCode,
    ).toBe(200);
    const decided = await srv.inject({
      method: "POST",
      url: `/approvals/${approval.id}/approve`,
      headers: alice.bearer,
      payload: {},
    });
    expect(decided.statusCode).toBe(200);
    expect(await waiting).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Extended coverage: agents, workflows, memory and skills.
 * The global project-state hook gated these only indirectly; every by-id
 * handler now checks ownership itself, and project-local skills are gated
 * while marketplace templates (no project) stay intentionally public.
 * ------------------------------------------------------------------ */
describe("S01 — agents, workflows, memory and skills gate directly", () => {
  async function aliceWorld(srv: FastifyInstance) {
    const alice = makeUser(11, "ext-alice");
    const bob = makeUser(12, "ext-bob");
    const project = await createProject(srv, alice, "ExtAlice");
    return { alice, bob, project };
  }

  it("blocks read, edit, enable, history and delete of another account's agents", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const { alice, bob, project } = await aliceWorld(srv);
    const agent = container.agentRepo.byProject(project)[0];
    expect(agent).toBeDefined();

    for (const attempt of [
      { method: "GET", url: `/agents/${agent.id}` },
      { method: "PATCH", url: `/agents/${agent.id}`, payload: { name: "hijacked" } },
      { method: "POST", url: `/agents/${agent.id}/enable`, payload: {} },
      { method: "POST", url: `/agents/${agent.id}/disable`, payload: {} },
      { method: "GET", url: `/agents/${agent.id}/history` },
      { method: "GET", url: `/agents/${agent.id}/prompt-versions` },
      { method: "DELETE", url: `/agents/${agent.id}` },
    ] as const) {
      const res = await srv.inject({ ...attempt, headers: bob.bearer });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }
    expect(container.agentRepo.findById(agent.id)?.data.name).not.toBe("hijacked");
    expect(container.agentRepo.findById(agent.id)).toBeDefined();

    // The owner still manages the same agent.
    expect((await srv.inject({ method: "GET", url: `/agents/${agent.id}`, headers: alice.bearer })).statusCode).toBe(
      200,
    );
  });

  it("blocks reading, running, editing and deleting another account's workflows", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const { alice, bob, project } = await aliceWorld(srv);
    const workflow = container.workflowRepo.byProject(project)[0];
    expect(workflow).toBeDefined();

    for (const attempt of [
      { method: "GET", url: `/workflows/${workflow.id}` },
      { method: "PATCH", url: `/workflows/${workflow.id}`, payload: { name: "hijacked" } },
      { method: "POST", url: `/workflows/${workflow.id}/run`, payload: {} },
      { method: "DELETE", url: `/workflows/${workflow.id}` },
    ] as const) {
      const res = await srv.inject({ ...attempt, headers: bob.bearer });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }
    expect(container.workflowRepo.findById(workflow.id)).toBeDefined();
    expect(
      (await srv.inject({ method: "GET", url: `/workflows/${workflow.id}`, headers: alice.bearer })).statusCode,
    ).toBe(200);
  });

  it("blocks foreign project memory but keeps platform memory shared", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const { alice, bob, project } = await aliceWorld(srv);
    // Create through the API so the entry is persisted into the (mock) repo
    // and survives the repository restore that the state hook performs.
    const memRes = await srv.inject({
      method: "POST",
      url: "/memory",
      headers: alice.bearer,
      payload: { projectId: project, type: "knowledge", key: "alice-secret-note", content: "private" },
    });
    expect(memRes.statusCode).toBe(200);
    const projectMemory = memRes.json() as { id: string };
    const platformMemory = {
      ...(
        await srv.inject({
          method: "POST",
          url: "/memory",
          payload: { type: "knowledge", key: "platform", content: "shared" },
        })
      ).json(),
    } as { id: string };

    for (const attempt of [
      { method: "GET", url: `/memory/${projectMemory.id}` },
      { method: "PATCH", url: `/memory/${projectMemory.id}`, payload: { content: "hijacked" } },
      { method: "DELETE", url: `/memory/${projectMemory.id}` },
    ] as const) {
      const res = await srv.inject({ ...attempt, headers: bob.bearer });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }
    expect(container.memoryRepo.findById(projectMemory.id)?.data.content).toBe("private");

    // Platform (ownerless) memory is shared by design — same as the list.
    expect(
      (await srv.inject({ method: "GET", url: `/memory/${platformMemory.id}`, headers: bob.bearer })).statusCode,
    ).toBe(200);
    // The owner reaches her own project memory.
    expect(
      (await srv.inject({ method: "GET", url: `/memory/${projectMemory.id}`, headers: alice.bearer })).statusCode,
    ).toBe(200);
  });

  it("blocks project-local skills but keeps marketplace templates public", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const { alice, bob, project } = await aliceWorld(srv);
    // Create through the API so the definition is written to the (mock) repo
    // and survives the repository restore that the state hook performs.
    const skillRes = await srv.inject({
      method: "POST",
      url: "/skills",
      headers: alice.bearer,
      payload: { projectId: project, slug: "alice-local-skill", name: "Alice local skill", instructions: "private" },
    });
    expect(skillRes.statusCode).toBe(200);
    const localSkill = skillRes.json() as { id: string };
    const template = container.skillRepo.globalCatalog().find((s) => !s.projectId);
    expect(template).toBeDefined();

    for (const attempt of [
      { method: "GET", url: `/skills/${localSkill.id}` },
      { method: "PATCH", url: `/skills/${localSkill.id}`, payload: { name: "hijacked" } },
      { method: "POST", url: `/skills/${localSkill.id}/disable`, payload: {} },
      { method: "DELETE", url: `/skills/${localSkill.id}` },
    ] as const) {
      const res = await srv.inject({ ...attempt, headers: bob.bearer });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }
    expect(container.skillRepo.findById(localSkill.id)?.data.name).not.toBe("hijacked");

    // Marketplace templates stay public for every account.
    expect((await srv.inject({ method: "GET", url: `/skills/${template!.id}`, headers: bob.bearer })).statusCode).toBe(
      200,
    );
    // The owner still manages her project skill.
    expect(
      (await srv.inject({ method: "GET", url: `/skills/${localSkill.id}`, headers: alice.bearer })).statusCode,
    ).toBe(200);
  });

  it("refuses creating tasks, agents, memory or skills into a foreign project", async () => {
    stubEmptyCatalog();
    const srv = await boot();
    const { alice, bob, project } = await aliceWorld(srv);

    const taskRes = await srv.inject({
      method: "POST",
      url: "/tasks",
      headers: bob.bearer,
      payload: { projectId: project, title: "Bob's intrusion" },
    });
    expect(taskRes.statusCode).toBe(404);

    const agentRes = await srv.inject({
      method: "POST",
      url: "/agents",
      headers: bob.bearer,
      payload: { projectId: project, type: "research" },
    });
    expect(agentRes.statusCode).toBe(404);

    const memoryRes = await srv.inject({
      method: "POST",
      url: "/memory",
      headers: bob.bearer,
      payload: { projectId: project, type: "knowledge", key: "intrusion", content: "x" },
    });
    expect(memoryRes.statusCode).toBe(404);

    const skillRes = await srv.inject({
      method: "POST",
      url: "/skills",
      headers: bob.bearer,
      payload: { projectId: project, slug: "intrusion-skill", instructions: "manual" },
    });
    expect(skillRes.statusCode).toBe(404);

    // Nothing was written into Alice's project.
    expect(container.taskRepo.findMany({ projectId: project }).some((t) => t.data.title === "Bob's intrusion")).toBe(
      false,
    );
    expect(container.memoryRepo.byProject(project).some((m) => m.key === "intrusion")).toBe(false);
    expect(container.skillRepo.findBySlug("intrusion-skill", project)).toBeUndefined();
    // Alice can still create in her own project.
    expect(
      (
        await srv.inject({
          method: "POST",
          url: "/tasks",
          headers: alice.bearer,
          payload: { projectId: project, title: "Alice own task" },
        })
      ).statusCode,
    ).toBe(200);
  });
});
