import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { signSession } from "../auth/github-oauth.js";
import { storeUserGitHubToken } from "../auth/github-tokens.js";
import { setUserGitHubFetchForTest, resolveGitHubForProject, adoptStrandedProjects } from "../github/registry.js";
import { adoptProjectConnection } from "../auth/project-connection.js";
import { runWithGitHubRequestActor } from "../github/request-actor.js";
import type { Project } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Regression tests for "every user must see their own repositories".
 *
 * The GitHub page resolved the *signed-in* user's OAuth token, but project
 * actions resolved `project.githubConnection.userId || project.ownerId`. When
 * the person browsing was not the person who created the project — including
 * every project created before login existed, which was owned by the pre-login
 * `user-demo` and stored `kind: "mock"` — the two identities diverged and the
 * project fell back to a foreign token or to the mock.
 * ------------------------------------------------------------------ */

const ENV_KEYS = ["REQUIRE_AUTH", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "AUTH_SECRET", "GITHUB_TOKEN", "GITHUB_ENABLED"] as const;
let savedEnv: Record<string, string | undefined>;
let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;

async function boot(): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
  return app;
}

/** Per-token GitHub fake: each token sees only its own account's repositories. */
function multiUserGitHub(accounts: Record<string, { login: string; repos: string[] }>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const account = accounts[token];
    if (!account) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    if (url.includes("/user/repos")) {
      const body = account.repos.map((full, i) => ({
        id: i + 1,
        name: full.split("/")[1],
        full_name: full,
        private: false,
        default_branch: "main",
        description: null,
        html_url: `https://github.com/${full}`,
        language: "TypeScript",
        pushed_at: "2026-01-01T00:00:00Z",
        archived: false,
        owner: { login: full.split("/")[0] },
        permissions: { admin: true, push: true, pull: true },
      }));
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.endsWith("/user")) {
      return new Response(JSON.stringify({ login: account.login, name: account.login }), {
        status: 200,
        headers: { "x-oauth-scopes": "repo, read:user, user:email" },
      });
    }
    // Repo contents / files: only for repos this account owns.
    const owned = account.repos.some((r) => url.includes(`/repos/${r}`));
    if (url.includes("/repos/")) {
      if (!owned) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_SECRET = "test-auth-secret-for-multi-user-github-0123456789";
  getEnvFresh();
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  setUserGitHubFetchForTest(undefined);
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

describe("each user acts as their own GitHub identity", () => {
  it("lists only the signed-in user's repositories, per session", async () => {
    const srv = await boot();
    const alice = container.userRepo.upsertGitHubUser({ id: 1, login: "alice", name: "Alice", email: "a@example.com" }).user;
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "Bob", email: "b@example.com" }).user;
    storeUserGitHubToken(container.kv, alice.id, "tok-alice", { scopes: "repo", login: "alice" });
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });
    setUserGitHubFetchForTest(
      multiUserGitHub({
        "tok-alice": { login: "alice", repos: ["alice/one", "alice/two"] },
        "tok-bob": { login: "bob", repos: ["bob/only"] },
      }),
    );

    const asAlice = await srv.inject({ method: "GET", url: "/github/repositories", headers: { cookie: `cv_session=${signSession(alice.id)}` } });
    expect(asAlice.json().repositories.map((r: { fullName: string }) => r.fullName)).toEqual(["alice/one", "alice/two"]);

    const asBob = await srv.inject({ method: "GET", url: "/github/repositories", headers: { cookie: `cv_session=${signSession(bob.id)}` } });
    expect(asBob.json().repositories.map((r: { fullName: string }) => r.fullName)).toEqual(["bob/only"]);
  });

  it("uses the requesting user's token for a project owned by someone else", async () => {
    await boot();
    const alice = container.userRepo.upsertGitHubUser({ id: 1, login: "alice", name: "Alice", email: "a@example.com" }).user;
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "Bob", email: "b@example.com" }).user;
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });
    setUserGitHubFetchForTest(multiUserGitHub({ "tok-bob": { login: "bob", repos: ["bob/only"] } }));

    // Owned by Alice, but Bob is the one making the request.
    const project = { id: "p1", ownerId: alice.id, name: "Shared", githubConnection: { kind: "user-oauth" as const, userId: alice.id, login: "alice" } } as unknown as Project;

    const asBob = resolveGitHubForProject({ project, kv: container.kv, fallback: container.github, requestUserId: bob.id });
    expect(asBob.kind).toBe("real");
    expect((await asBob.getViewer()).login).toBe("bob");
  });

  it("never falls back to the mock for a legacy mock project when the caller is connected", async () => {
    await boot();
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "Bob", email: "b@example.com" }).user;
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });
    setUserGitHubFetchForTest(multiUserGitHub({ "tok-bob": { login: "bob", repos: ["bob/only"] } }));

    // Exactly the shape produced before GitHub login existed.
    const legacy = { id: "p2", ownerId: "user-demo", name: "Legacy", githubConnection: { kind: "mock" as const } } as unknown as Project;

    const resolved = resolveGitHubForProject({ project: legacy, kv: container.kv, fallback: container.github, requestUserId: bob.id });
    expect(resolved.kind).toBe("real");
    expect((await resolved.getViewer()).login).toBe("bob");
  });

  it("uses the ALS request actor when githubForProject is called without requestUserId", async () => {
    await boot();
    const alice = container.userRepo.upsertGitHubUser({ id: 1, login: "alice", name: "Alice", email: "a@example.com" }).user;
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "Bob", email: "b@example.com" }).user;
    storeUserGitHubToken(container.kv, alice.id, "tok-alice", { scopes: "repo", login: "alice" });
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });
    setUserGitHubFetchForTest(
      multiUserGitHub({
        "tok-alice": { login: "alice", repos: ["alice/one"] },
        "tok-bob": { login: "bob", repos: ["bob/only"] },
        ghs_server: { login: "bot", repos: ["bot/shared"] },
      }),
    );

    const project = {
      id: "p-als",
      ownerId: alice.id,
      name: "PAT",
      githubConnection: { kind: "server-token" as const },
    } as unknown as Project;

    const asBob = runWithGitHubRequestActor(bob.id, () =>
      resolveGitHubForProject({ project, kv: container.kv, fallback: container.github }),
    );
    expect(asBob.kind).toBe("real");
    expect((await asBob.getViewer()).login).toBe("bob");
  });

  it("still uses the project's stored connection for background work (no request user)", async () => {
    await boot();
    const alice = container.userRepo.upsertGitHubUser({ id: 1, login: "alice", name: "Alice", email: "a@example.com" }).user;
    storeUserGitHubToken(container.kv, alice.id, "tok-alice", { scopes: "repo", login: "alice" });
    setUserGitHubFetchForTest(multiUserGitHub({ "tok-alice": { login: "alice", repos: ["alice/one"] } }));

    const project = { id: "p3", ownerId: alice.id, name: "Owned", githubConnection: { kind: "user-oauth" as const, userId: alice.id, login: "alice" } } as unknown as Project;

    const background = resolveGitHubForProject({ project, kv: container.kv, fallback: container.github });
    expect(background.kind).toBe("real");
    expect((await background.getViewer()).login).toBe("alice");
  });

  it("adopts a legacy mock project onto the connected user so background runs work too", async () => {
    const srv = await boot();
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "Bob", email: "b@example.com" }).user;
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });
    setUserGitHubFetchForTest(multiUserGitHub({ "tok-bob": { login: "bob", repos: ["bob/only"] } }));

    const created = container.projectRepo.upsert({
      id: "p4",
      ownerId: "user-demo",
      name: "Legacy",
      slug: "legacy",
      description: "",
      status: "active",
      configRepo: "bob/only",
      branch: "main",
      repositories: [{ repo: "bob/only", branch: "main" }],
      githubConnection: { kind: "mock" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Project);
    expect(created.data.githubConnection?.kind).toBe("mock");

    // Any authenticated project request re-binds the connection.
    await srv.inject({ method: "GET", url: "/projects/p4/files", headers: { cookie: `cv_session=${signSession(bob.id)}` } });

    const after = container.projectRepo.findById("p4")?.data;
    expect(after?.githubConnection).toMatchObject({ kind: "user-oauth", userId: bob.id, login: "bob" });
  });
});

describe("stranded projects are handed to a connected user", () => {
  const mkProject = (over: Partial<Project>): Project =>
    ({
      id: "x",
      ownerId: "user-demo",
      name: "P",
      slug: "p",
      description: "",
      status: "active",
      configRepo: "o/r",
      branch: "main",
      repositories: [{ repo: "o/r", branch: "main" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...over,
    }) as unknown as Project;

  it("adopts mock and token-less projects but never a live one", async () => {
    await boot();
    const alice = container.userRepo.upsertGitHubUser({ id: 1, login: "alice", name: "A", email: "a@e.com" }).user;
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "B", email: "b@e.com" }).user;
    storeUserGitHubToken(container.kv, alice.id, "tok-alice", { scopes: "repo", login: "alice" });
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });

    const legacyMock = mkProject({ id: "m1", githubConnection: { kind: "mock" } });
    const noConnection = mkProject({ id: "m2", githubConnection: undefined });
    const goneUser = mkProject({ id: "m3", githubConnection: { kind: "user-oauth", userId: "vanished", login: "ghost" } });
    const aliceLive = mkProject({ id: "m4", ownerId: alice.id, githubConnection: { kind: "user-oauth", userId: alice.id, login: "alice" } });

    const saved: Project[] = [];
    const adopted = adoptStrandedProjects({
      kv: container.kv,
      projects: [legacyMock, noConnection, goneUser, aliceLive],
      save: (p) => void saved.push(p),
      userId: bob.id,
      login: "bob",
    });

    // Alice is still connected, so her project is untouched.
    expect(adopted).toEqual(["m1", "m2", "m3"]);
    expect(saved.map((p) => p.id)).toEqual(["m1", "m2", "m3"]);
    expect(aliceLive.githubConnection).toMatchObject({ userId: alice.id });
    for (const p of [legacyMock, noConnection, goneUser]) {
      expect(p.githubConnection).toMatchObject({ kind: "user-oauth", userId: bob.id, login: "bob" });
    }
  });

  it("leaves another user's server-token projects alone while adopting the caller's own", async () => {
    process.env.GITHUB_TOKEN = "ghs_server";
    process.env.GITHUB_ENABLED = "true";
    getEnvFresh();
    await boot();
    const alice = container.userRepo.upsertGitHubUser({ id: 1, login: "alice", name: "A", email: "a@e.com" }).user;
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "B", email: "b@e.com" }).user;
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });

    const aliceServer = mkProject({ id: "s1", ownerId: alice.id, githubConnection: { kind: "server-token" } });
    const bobServer = mkProject({ id: "s2", ownerId: bob.id, githubConnection: { kind: "server-token" } });
    const demoServer = mkProject({ id: "s3", ownerId: "user-demo", githubConnection: { kind: "server-token" } });
    const saved: string[] = [];
    const adopted = adoptStrandedProjects({
      kv: container.kv,
      projects: [aliceServer, bobServer, demoServer],
      save: (p) => void saved.push(p.id),
      userId: bob.id,
      login: "bob",
    });
    expect(adopted).toEqual(["s2", "s3"]);
    expect(aliceServer.githubConnection).toMatchObject({ kind: "server-token" });
    expect(bobServer.githubConnection).toMatchObject({ kind: "user-oauth", userId: bob.id, login: "bob" });
    expect(demoServer.githubConnection).toMatchObject({ kind: "user-oauth", userId: bob.id, login: "bob" });
  });
});

describe("status endpoints reflect the caller's own credential", () => {
  it("reports connected for an OAuth user even without a server GITHUB_TOKEN", async () => {
    const srv = await boot();
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "B", email: "b@e.com" }).user;
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });
    setUserGitHubFetchForTest(multiUserGitHub({ "tok-bob": { login: "bob", repos: ["bob/only"] } }));
    const cookie = `cv_session=${signSession(bob.id)}`;

    const settings = (await srv.inject({ method: "GET", url: "/settings", headers: { cookie } })).json();
    expect(settings.githubConnected).toBe(true);
    expect(settings.githubSource).toBe("user-oauth");

    const health = (await srv.inject({ method: "GET", url: "/admin/health", headers: { cookie } })).json();
    expect(health.github.status).toBe("connected");
    expect(health.github.source).toBe("user-oauth");
  });

  it("still reports mock for a caller with no GitHub credential at all", async () => {
    const srv = await boot();
    const settings = (await srv.inject({ method: "GET", url: "/settings" })).json();
    expect(settings.githubConnected).toBe(false);
    expect(settings.githubSource).toBe("mock");
  });
});

describe("per-account isolation of definition sub-resources", () => {
  it("hides another account's workflows and refuses writes", async () => {
    const srv = await boot();
    const alice = container.userRepo.upsertGitHubUser({ id: 1, login: "alice", name: "Alice", email: "a@example.com" }).user;
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "Bob", email: "b@example.com" }).user;
    const aliceProj = await container.agentManager.createProject({
      ownerId: alice.id, name: "Alice App", description: "private", configRepo: "alice/one",
    });
    const bobProj = await container.agentManager.createProject({
      ownerId: bob.id, name: "Bob App", description: "private", configRepo: "bob/only",
    });
    const aliceWf = container.workflowRepo.byProject(aliceProj.id)[0];
    expect(aliceWf).toBeDefined();
    const cookieBob = `cv_session=${signSession(bob.id)}`;

    const list = await srv.inject({ method: "GET", url: "/workflows", headers: { cookie: cookieBob } });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((w: { projectId: string }) => w.projectId === aliceProj.id)).toBe(false);
    expect(list.json().some((w: { projectId: string }) => w.projectId === bobProj.id)).toBe(true);

    const get = await srv.inject({ method: "GET", url: `/workflows/${aliceWf.id}`, headers: { cookie: cookieBob } });
    expect(get.statusCode).toBe(404);

    const patch = await srv.inject({
      method: "PATCH", url: `/workflows/${aliceWf.id}`, headers: { cookie: cookieBob },
      payload: { name: "Hijacked" },
    });
    expect(patch.statusCode).toBe(404);

    const run = await srv.inject({ method: "POST", url: `/workflows/${aliceWf.id}/run`, headers: { cookie: cookieBob }, payload: {} });
    expect(run.statusCode).toBe(404);

    const del = await srv.inject({ method: "DELETE", url: `/workflows/${aliceWf.id}`, headers: { cookie: cookieBob } });
    expect(del.statusCode).toBe(404);

    const create = await srv.inject({
      method: "POST", url: "/workflows", headers: { cookie: cookieBob },
      payload: { projectId: aliceProj.id, name: "Stolen", slug: "stolen" },
    });
    expect(create.statusCode).toBe(404);

    const tasks = await srv.inject({ method: "GET", url: "/tasks", headers: { cookie: cookieBob } });
    expect(tasks.json().every((t: { projectId: string }) => t.projectId !== aliceProj.id)).toBe(true);
  });

  it("adopts a ghost connection onto the owner only, never a foreign account", async () => {
    await boot();
    const alice = container.userRepo.upsertGitHubUser({ id: 1, login: "alice", name: "Alice", email: "a@example.com" }).user;
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "Bob", email: "b@example.com" }).user;
    storeUserGitHubToken(container.kv, alice.id, "tok-alice", { scopes: "repo", login: "alice" });
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });

    const owned = {
      id: "ghost-owned",
      ownerId: alice.id,
      name: "Ghost",
      slug: "ghost-owned",
      description: "",
      status: "active",
      configRepo: "alice/one",
      branch: "main",
      repositories: [{ repo: "alice/one", branch: "main" }],
      githubConnection: { kind: "user-oauth" as const, userId: "vanished", login: "ghost" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Project;
    container.projectRepo.upsert(owned);

    expect(adoptProjectConnection({ kv: container.kv, projectRepo: container.projectRepo, project: owned, userId: bob.id })).toBe(false);
    expect(container.projectRepo.findById("ghost-owned")?.data.githubConnection).toMatchObject({ userId: "vanished", login: "ghost" });

    expect(adoptProjectConnection({ kv: container.kv, projectRepo: container.projectRepo, project: owned, userId: alice.id })).toBe(true);
    expect(container.projectRepo.findById("ghost-owned")?.data.githubConnection).toMatchObject({ kind: "user-oauth", userId: alice.id, login: "alice" });
  });

  it("rebinds a server-token project onto the owner's OAuth token, never a foreign account", async () => {
    process.env.GITHUB_TOKEN = "ghs_server";
    process.env.GITHUB_ENABLED = "true";
    getEnvFresh();
    await boot();
    const alice = container.userRepo.upsertGitHubUser({ id: 1, login: "alice", name: "Alice", email: "a@example.com" }).user;
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "Bob", email: "b@example.com" }).user;
    storeUserGitHubToken(container.kv, alice.id, "tok-alice", { scopes: "repo", login: "alice" });
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });

    const owned = {
      id: "pat-owned",
      ownerId: alice.id,
      name: "PAT",
      slug: "pat-owned",
      description: "",
      status: "active",
      configRepo: "alice/one",
      branch: "main",
      repositories: [{ repo: "alice/one", branch: "main" }],
      githubConnection: { kind: "server-token" as const },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Project;
    container.projectRepo.upsert(owned);

    expect(adoptProjectConnection({ kv: container.kv, projectRepo: container.projectRepo, project: owned, userId: bob.id })).toBe(false);
    expect(container.projectRepo.findById("pat-owned")?.data.githubConnection).toMatchObject({ kind: "server-token" });

    expect(adoptProjectConnection({ kv: container.kv, projectRepo: container.projectRepo, project: owned, userId: alice.id })).toBe(true);
    expect(container.projectRepo.findById("pat-owned")?.data.githubConnection).toMatchObject({ kind: "user-oauth", userId: alice.id, login: "alice" });
  });

  it("binds the acting owner before a workflow write and never steals a live foreign connection", async () => {
    const srv = await boot();
    const alice = container.userRepo.upsertGitHubUser({ id: 1, login: "alice", name: "Alice", email: "a@example.com" }).user;
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "Bob", email: "b@example.com" }).user;
    storeUserGitHubToken(container.kv, alice.id, "tok-alice", { scopes: "repo", login: "alice" });
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });

    const aliceProj = await container.agentManager.createProject({
      ownerId: alice.id, name: "Alice Bind", description: "d", configRepo: "alice/bind",
    });
    container.projectRepo.update({ ...aliceProj, githubConnection: { kind: "mock" } });

    await srv.inject({
      method: "POST", url: "/workflows",
      headers: { cookie: `cv_session=${signSession(alice.id)}` },
      payload: { projectId: aliceProj.id, name: "Bound", slug: "bound-flow" },
    });
    const after = container.projectRepo.findById(aliceProj.id)?.data;
    expect(after?.githubConnection).toMatchObject({ kind: "user-oauth", userId: alice.id, login: "alice" });

    // Bob cannot take over Alice's now-live connection even by guessing the id.
    await srv.inject({
      method: "POST", url: "/workflows",
      headers: { cookie: `cv_session=${signSession(bob.id)}` },
      payload: { projectId: aliceProj.id, name: "Hijack", slug: "hijack" },
    });
    expect(container.projectRepo.findById(aliceProj.id)?.data.githubConnection).toMatchObject({ userId: alice.id, login: "alice" });
  });
});

describe("background jobs use the project's connection, not the platform mock", () => {
  it("runs a github.op job with the project owner's token, not the platform mock", async () => {
    await boot();
    const bob = container.userRepo.upsertGitHubUser({ id: 2, login: "bob", name: "B", email: "b@e.com" }).user;
    storeUserGitHubToken(container.kv, bob.id, "tok-bob", { scopes: "repo", login: "bob" });

    // Record which credential the background op actually presents.
    const seen: Array<{ url: string; auth: string }> = [];
    setUserGitHubFetchForTest((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") ?? "" });
      if (url.includes("/issues")) return new Response(JSON.stringify({ number: 7, title: "t", state: "open", html_url: "u" }), { status: 201 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch);

    container.projectRepo.upsert({
      id: "w1",
      ownerId: bob.id,
      name: "Worker",
      slug: "worker",
      description: "",
      status: "active",
      configRepo: "bob/only",
      branch: "main",
      repositories: [{ repo: "bob/only", branch: "main" }],
      githubConnection: { kind: "user-oauth", userId: bob.id, login: "bob" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Project);

    // The platform-wide service is the mock — a mock would never issue a request.
    expect(container.github.kind).toBe("mock");

    const job = container.queue.enqueue("github.op", { op: "create_issue", projectId: "w1", repo: "bob/only", title: "From worker", body: "b" });
    await container.worker.process(job.id);

    expect(container.queue.getById(job.id)?.status).toBe("succeeded");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.auth === "Bearer tok-bob")).toBe(true);
  });
});
