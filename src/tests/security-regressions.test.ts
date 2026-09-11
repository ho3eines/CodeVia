import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { io as Client, type Socket as ClientSocket } from "socket.io-client";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { signSession } from "../auth/github-oauth.js";
import { storeUserGitHubToken } from "../auth/github-tokens.js";
import { live } from "../realtime/live.js";
import { freshDb } from "./test-helpers.js";
import type { FastifyInstance } from "fastify";

/* ------------------------------------------------------------------ *
 * Regression tests for PIPELINE_AUDIT.md A01 / A02 / A03:
 *   A01 — a caller-supplied identity header (x-user-id) must never be
 *          proof of identity; strict auth fails closed.
 *   A02 — project resources are ownership-checked (foreign projects
 *          read as 404; shared/unowned projects stay accessible).
 *   A03 — realtime requires an authenticated handshake and delivers
 *          events only to sockets subscribed to accessible projects.
 * ------------------------------------------------------------------ */

const ENV_KEYS = ["REQUIRE_AUTH", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "AUTH_SECRET"] as const;

let savedEnv: Record<string, string | undefined>;
let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let ioHandle: { close: (cb?: () => void) => void } | undefined;
let container: Container;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  getEnvFresh();
}

async function boot(): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  const built = await buildServer(container);
  app = built.app;
  ioHandle = built.io;
  await app.ready();
  return app;
}

interface TestUser {
  id: string;
  token: string;
  bearer: Record<string, string>;
}

function makeUser(idNumber: number, login: string): TestUser {
  const { user } = container.userRepo.upsertGitHubUser({ id: idNumber, login, name: login, email: `${login}@x.test` });
  const token = signSession(user.id);
  return { id: user.id, token, bearer: { authorization: `Bearer ${token}` } };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_SECRET = "security-regression-tests-secret-0123456789";
  getEnvFresh();
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  if (ioHandle) {
    await new Promise<void>((resolve) => ioHandle!.close(() => resolve()));
    ioHandle = undefined;
  }
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  getEnvFresh();
  cleanup?.();
});

/* ------------------------------------------------------------------ *
 * A01 — identity headers cannot bypass authentication
 * ------------------------------------------------------------------ */
describe("A01 — caller-supplied identity headers are not proof of identity", () => {
  beforeEach(() => {
    setEnv("REQUIRE_AUTH", "true");
    setEnv("GITHUB_CLIENT_ID", "Ov23liTESTCLIENTID");
    setEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
  });

  it("strict mode stays 401 even with an arbitrary x-user-id header (regression: header granted owner)", async () => {
    const srv = await boot();
    const headers = { "x-user-id": "audit-untrusted-caller" };
    for (const attempt of [
      { method: "GET", url: "/admin/settings" },
      { method: "GET", url: "/projects" },
      { method: "POST", url: "/projects", payload: { name: "Hijacked", configRepo: "evil/repo" } },
      { method: "PATCH", url: "/projects/p-anyone", payload: { description: "hijacked" } },
    ] as const) {
      const res = await srv.inject({ ...attempt, headers });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(401);
      expect(res.json().message).toMatch(/Authentication required/);
    }
  });

  it("x-user-id no longer contributes to identity in demo mode either", async () => {
    // Pure demo mode: auth off and NO OAuth configured (an unauthenticated
    // mock-connection project creation would otherwise be rejected by the
    // "OAuth configured but nobody logged in yet" guard).
    setEnv("REQUIRE_AUTH", "false");
    setEnv("GITHUB_CLIENT_ID", undefined);
    setEnv("GITHUB_CLIENT_SECRET", undefined);
    const srv = await boot();
    const created = await srv.inject({
      method: "POST",
      url: "/projects",
      headers: { "x-user-id": "attacker-wants-this-id" },
      payload: { name: "Spoofed", configRepo: "acme/spoofed" },
    });
    expect(created.statusCode).toBe(201);
    // The project belongs to the demo owner, not to the attacker-supplied id.
    expect(created.json().ownerId).toBe("user-demo");
  });
});

/* ------------------------------------------------------------------ *
 * A02 — project resources are ownership-checked
 * ------------------------------------------------------------------ */
describe("A02 — project routes enforce per-project ownership", () => {
  async function ownedProject(srv: FastifyInstance, owner: TestUser, name: string): Promise<string> {
    const created = await srv.inject({
      method: "POST",
      url: "/projects",
      headers: owner.bearer,
      payload: { name, configRepo: `acme/${name.toLowerCase()}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().ownerId).toBe(owner.id);
    return created.json().id as string;
  }

  it("hides foreign projects and blocks GET/PATCH/DELETE plus sub-resources", async () => {
    const srv = await boot();
    const alice = makeUser(101, "owner-alice");
    const bob = makeUser(102, "other-bob");
    const pid = await ownedProject(srv, alice, "Private");
    const bobHeaders = { ...bob.bearer };

    // List filter hides it…
    const listForBob = (await srv.inject({ method: "GET", url: "/projects", headers: bobHeaders })).json() as Array<{ id: string }>;
    expect(listForBob.some((p) => p.id === pid)).toBe(false);

    // …and direct access denies (404 — no existence leak), without mutating.
    for (const attempt of [
      { method: "GET", url: `/projects/${pid}` },
      { method: "PATCH", url: `/projects/${pid}`, payload: { description: "hijacked" } },
      { method: "DELETE", url: `/projects/${pid}` },
      { method: "GET", url: `/projects/${pid}/agents` },
      { method: "GET", url: `/projects/${pid}/tasks` },
      { method: "GET", url: `/projects/${pid}/memory` },
      { method: "GET", url: `/projects/${pid}/overview` },
      { method: "POST", url: `/projects/${pid}/ask`, payload: { description: "hijack the project" } },
    ] as const) {
      const res = await srv.inject({ ...attempt, headers: bobHeaders });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }

    // The project was not modified by any of the denied calls.
    const asOwner = (await srv.inject({ method: "GET", url: `/projects/${pid}`, headers: alice.bearer })).json();
    expect(asOwner.description).toBe("");

    // The owner keeps full access.
    const patched = await srv.inject({ method: "PATCH", url: `/projects/${pid}`, headers: alice.bearer, payload: { description: "mine" } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().description).toBe("mine");
  });

  it("hides shared (unowned) projects from other accounts — they are handed over at login instead", async () => {
    const srv = await boot();
    const alice = makeUser(103, "sharer-alice");
    const bob = makeUser(104, "reader-bob");
    const pid = await ownedProject(srv, alice, "Shared");
    // Legacy/shared rows: a project without an owner used to be visible to
    // every account. That is exactly how one account ended up opening another
    // account's repository and erroring out on the first GitHub call made with
    // *its own* token (404 / no access). Unowned rows are now hidden from
    // signed-in accounts; `adoptStrandedProjects` hands them to the account
    // that logs in, so nothing disappears from the installation that owns them.
    const rec = container.projectRepo.findById(pid)!;
    container.projectRepo.upsert({ ...rec.data, ownerId: undefined }, { projectId: pid });

    const listForBob = (await srv.inject({ method: "GET", url: "/projects", headers: bob.bearer })).json() as Array<{ id: string }>;
    expect(listForBob.some((p) => p.id === pid)).toBe(false);
    // Direct access reveals neither existence nor content (404, not 403).
    expect((await srv.inject({ method: "GET", url: `/projects/${pid}`, headers: bob.bearer })).statusCode).toBe(404);
    expect((await srv.inject({ method: "GET", url: `/projects/${pid}/agents`, headers: bob.bearer })).statusCode).toBe(404);
    // The single-user/demo identity keeps seeing it, so an installation without
    // login loses nothing.
    expect((await srv.inject({ method: "GET", url: `/projects/${pid}` })).statusCode).toBe(200);
    // Alice is not locked out of her own project by the missing owner row: a
    // connected account that owns the repository can still take it back.
    storeUserGitHubToken(container.kv, alice.id, "tok-alice", { scopes: "repo", login: "alice" });
    const reclaimed = await srv.inject({ method: "GET", url: `/projects/${pid}`, headers: alice.bearer });
    expect(reclaimed.statusCode).toBe(200);
    expect(container.projectRepo.findById(pid)?.data.ownerId).toBe(alice.id);
  });
});

/* ------------------------------------------------------------------ *
 * A03 — realtime is authenticated and project-scoped
 * ------------------------------------------------------------------ */
describe("A03 — Socket.io handshakes authenticate and events stay project-scoped", () => {
  function connect(port: number, token?: string): ClientSocket {
    const extraHeaders: Record<string, string> = {};
    if (token) extraHeaders.cookie = `cv_session=${encodeURIComponent(token)}`;
    return Client(`http://127.0.0.1:${port}`, {
      transports: ["polling", "websocket"],
      extraHeaders,
      reconnection: false,
      timeout: 5000,
    });
  }

  async function listenPort(srv: FastifyInstance): Promise<number> {
    await srv.listen({ port: 0, host: "127.0.0.1" });
    const addr = srv.server.address();
    expect(addr && typeof addr === "object").toBe(true);
    return (addr as { port: number }).port;
  }

  function subscribeAll(socket: ClientSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.on("connect", () => {
        socket.emit("subscribe_all", {}, (ack: { ok?: boolean } | undefined) => {
          if (ack?.ok) resolve();
          else reject(new Error(`subscribe_all rejected: ${JSON.stringify(ack)}`));
        });
      });
      socket.on("connect_error", (err: Error) => reject(err));
    });
  }

  function collectTaskEvents(socket: ClientSocket): { seen: string[]; off: () => void } {
    const seen: string[] = [];
    const handler = (ev: { taskId?: string }) => {
      if (ev?.taskId) seen.push(ev.taskId);
    };
    socket.on("task.updated", handler);
    return { seen, off: () => socket.off("task.updated", handler) };
  }

  it("rejects anonymous sockets in strict mode when login is configured", async () => {
    setEnv("REQUIRE_AUTH", "true");
    setEnv("GITHUB_CLIENT_ID", "Ov23liTESTCLIENTID");
    setEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
    const srv = await boot();
    const port = await listenPort(srv);
    const error = await new Promise<Error>((resolve, reject) => {
      const s = connect(port);
      s.on("connect", () => {
        s.disconnect();
        reject(new Error("anonymous socket connected — realtime is unauthenticated"));
      });
      s.on("connect_error", (err: Error) => {
        s.disconnect();
        resolve(err);
      });
    });
    expect(error.message).toMatch(/Authentication required/);
  });

  it("delivers project events only to sockets allowed to see that project", async () => {
    const srv = await boot();
    const port = await listenPort(srv);
    const alice = makeUser(201, "rt-alice");
    const bob = makeUser(202, "rt-bob");
    const created = await srv.inject({
      method: "POST",
      url: "/projects",
      headers: alice.bearer,
      payload: { name: "Realtime", configRepo: "acme/realtime" },
    });
    expect(created.statusCode).toBe(201);
    const pid = created.json().id as string;

    const sAlice = connect(port, alice.token);
    const sBob = connect(port, bob.token);
    const sAnon = connect(port);
    try {
      await Promise.all([subscribeAll(sAlice), subscribeAll(sBob), subscribeAll(sAnon)]);
      const aliceEvents = collectTaskEvents(sAlice);
      const bobEvents = collectTaskEvents(sBob);
      const anonEvents = collectTaskEvents(sAnon);

      live.emit({ type: "task.updated", taskId: "task-alice-only", projectId: pid, data: { status: "running" } });
      await sleep(300);

      expect(aliceEvents.seen).toContain("task-alice-only");
      // Bob and anonymous sockets must not observe Alice's private project.
      expect(bobEvents.seen).not.toContain("task-alice-only");
      expect(anonEvents.seen).not.toContain("task-alice-only");

      // Direct subscription to a foreign project is refused.
      const ack = await new Promise<{ ok?: boolean }>((resolve) => sBob.emit("subscribe", { projectId: pid }, resolve));
      expect(ack.ok).toBe(false);
      live.emit({ type: "task.updated", taskId: "task-alice-only-2", projectId: pid, data: { status: "running" } });
      await sleep(300);
      expect(bobEvents.seen).not.toContain("task-alice-only-2");

      // Ownership is re-evaluated on every subscribe, so even a reconnecting
      // client never joins another account's room: Bob re-subscribes (like the
      // SPA does on reconnect) and still receives nothing, while Alice keeps
      // receiving her own project's events.
      await new Promise<void>((resolve, reject) => {
        sBob.emit("subscribe_all", {}, (ack: { ok?: boolean } | undefined) => (ack?.ok ? resolve() : reject(new Error("re-subscribe failed"))));
      });
      live.emit({ type: "task.updated", taskId: "task-alice-only-3", projectId: pid, data: { status: "running" } });
      await sleep(300);
      expect(bobEvents.seen).not.toContain("task-alice-only-3");
      expect(anonEvents.seen).not.toContain("task-alice-only-3");
      expect(aliceEvents.seen).toContain("task-alice-only-3");

      aliceEvents.off();
      bobEvents.off();
      anonEvents.off();
    } finally {
      sAlice.disconnect();
      sBob.disconnect();
      sAnon.disconnect();
    }
  });
});
