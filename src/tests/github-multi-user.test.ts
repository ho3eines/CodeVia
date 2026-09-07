import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { signSession } from "../auth/github-oauth.js";
import { storeUserGitHubToken } from "../auth/github-tokens.js";
import { setUserGitHubFetchForTest, resolveGitHubForProject } from "../github/registry.js";
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
