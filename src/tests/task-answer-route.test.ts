import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";
import type { Task } from "../domain/entities.js";

/* ------------------------------------------------------------------ *
 * POST /tasks/:id/answer — resume a task parked by a research blocker.
 *
 * A blocked task used to be a dead end: the run route answered 409 with
 * "approve, reject, or cancel it", but no approval record exists for
 * blockers and nothing cleared approvalRequired. The only working path
 * (found live) was cancel + re-run. This route records the user's answer
 * (input.researchAnswer), clears the parked state and re-queues the task
 * in one call; the orchestrator consumes the answer instead of re-parking.
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

async function createProjectAndTask(): Promise<{ projectId: string; taskId: string }> {
  const res = await app!.inject({
    method: "POST",
    url: "/projects",
    payload: { name: `AnswerFlow${Date.now() % 100000}`, configRepo: `acme/answer-${Date.now() % 100000}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  const projectId = res.json().id as string;
  const taskRes = await app!.inject({
    method: "POST",
    url: "/tasks",
    payload: { projectId, title: "Add invoice export", description: "Export invoices" },
  });
  expect(taskRes.statusCode, taskRes.body).toBe(200);
  return { projectId, taskId: taskRes.json().id as string };
}

/** Park a task exactly the way the orchestrator does (A13 blocker path). */
function parkTask(taskId: string): void {
  const rec = container.taskRepo.findById(taskId)!;
  const now = new Date().toISOString();
  const parked: Task = {
    ...rec.data,
    status: "waiting_for_approval",
    approvalRequired: true,
    input: { ...rec.data.input, researchQuestion: "which currency should invoices use?" },
    result: { ...rec.data.result, blockedQuestion: "which currency should invoices use?" },
    updatedAt: now,
  };
  container.taskRepo.upsert(parked, { projectId: parked.projectId, parentId: parked.parentTaskId });
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AUTH_SECRET = "task-answer-route-tests-secret-0123456789";
  getEnvFresh();
  cleanup = freshDb().cleanup;
  stubEmptyCatalog();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (app) {
    await app.close();
    app = undefined;
  }
  for (const key of ENV_KEYS) {
    const v = savedEnv[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  getEnvFresh();
  cleanup?.();
  cleanup = undefined;
});

describe("POST /tasks/:id/answer", () => {
  it("records the answer, clears the parked state and re-queues the task", async () => {
    const srv = await boot();
    const { taskId } = await createProjectAndTask();
    parkTask(taskId);

    const res = await srv.inject({
      method: "POST",
      url: `/tasks/${taskId}/answer`,
      payload: { answer: "Use EUR for all invoice totals." },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.taskId).toBe(taskId);
    expect(body.answer).toBe("Use EUR for all invoice totals.");
    expect(typeof body.jobId).toBe("string");

    const task = container.taskRepo.findById(taskId)!.data;
    expect(task.status).toBe("queued");
    expect(task.approvalRequired).toBe(false);
    expect((task.input as Record<string, unknown>).researchAnswer).toBe("Use EUR for all invoice totals.");
  });

  it("answers 404 for a missing task, 409 for a non-waiting task and 400 for an empty answer", async () => {
    const srv = await boot();
    const { taskId } = await createProjectAndTask();

    expect((await srv.inject({ method: "POST", url: "/tasks/task-missing/answer", payload: { answer: "x" } })).statusCode).toBe(404);

    const notWaiting = await srv.inject({ method: "POST", url: `/tasks/${taskId}/answer`, payload: { answer: "x" } });
    expect(notWaiting.statusCode).toBe(409);
    expect(String(notWaiting.json().error)).toMatch(/waiting_for_approval/);

    parkTask(taskId);
    const empty = await srv.inject({ method: "POST", url: `/tasks/${taskId}/answer`, payload: { answer: "   " } });
    expect(empty.statusCode).toBe(400);
  });

  it("run route points a waiting task at the answer endpoint instead of a dead end", async () => {
    const srv = await boot();
    const { taskId } = await createProjectAndTask();
    parkTask(taskId);
    const res = await srv.inject({ method: "POST", url: `/tasks/${taskId}/run`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(String(res.json().error)).toMatch(/\/tasks\/:id\/answer/);
  });
});
