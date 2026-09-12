import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { getQueue } from "../db/queue.js";
import { runWithCorrelation } from "../correlation.js";
import { freshDb } from "./test-helpers.js";

let fx: ReturnType<typeof freshDb>;
let c: Container;
let app: FastifyInstance;

beforeEach(async () => {
  fx = freshDb();
  c = new Container();
  await c.ensureSeed();
  app = (await buildServer(c)).app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fx.cleanup();
});

describe("queue observability metrics", () => {
  it("reports backlog, retry and dead-letter counts with the age of the oldest waiting job", async () => {
    const q = getQueue();
    q.enqueue("notify", { n: 1 });
    q.enqueue("notify", { n: 2 }, { maxAttempts: 1 });
    // A dead job: enqueue then manually park it as dead (as the worker does).
    const dead = q.enqueue("notify", { n: 3 }, { maxAttempts: 1 });
    c.db.run(`UPDATE jobs SET status = 'dead' WHERE id = :id`, { id: dead.id });
    // A retrying job: enqueue then flip to retrying.
    const retrying = q.enqueue("notify", { n: 4 });
    c.db.run(`UPDATE jobs SET status = 'retrying' WHERE id = :id`, { id: retrying.id });

    const m = q.metrics();
    expect(m.total).toBe(4);
    expect(m.pending).toBe(2);
    expect(m.retrying).toBe(1);
    expect(m.deadLetter).toBe(1);
    expect(m.oldestPendingAgeMs).toBeGreaterThanOrEqual(0);
    expect(m.oldestRetryingAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("returns null ages when nothing is waiting", () => {
    const m = getQueue().metrics();
    expect(m.oldestPendingAgeMs).toBeNull();
    expect(m.oldestRetryingAgeMs).toBeNull();
    expect(m.total).toBe(0);
  });
});

describe("correlation id propagation", () => {
  it("applies the ambient correlation id to jobs enqueued without an explicit id", () => {
    const q = getQueue();
    const job = runWithCorrelation("corr_ambient-unit", () => q.enqueue("notify", { x: 1 }));
    expect(job.correlationId).toBe("corr_ambient-unit");
  });

  it("echoes an inbound correlation id back on the response", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { "x-correlation-id": "corr_client-123" } });
    expect(res.headers["x-correlation-id"]).toBe("corr_client-123");
  });

  it("mints a correlation id when none is supplied", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-correlation-id"]).toMatch(/^corr_[0-9a-f]{20}$/);
  });
});
