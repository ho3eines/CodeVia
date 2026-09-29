import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { signSession } from "../auth/github-oauth.js";
import { storeUserGitHubToken } from "../auth/github-tokens.js";
import { setUserGitHubFetchForTest, resolveGitHubForProject } from "../github/registry.js";
import {
  GitHubAuthorizationRequiredError,
  hasGitHubWriteScope,
  mergeOAuthScopes,
  buildWriteAuthorizeUrl,
} from "../github/authorization.js";
import { runWithGitHubRequestContext, pendingGitHubAuthorization } from "../github/request-actor.js";
import type { Project } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * "Changes cannot be applied to the current project — it uses the site
 * token. It must use the user's GitHub API and automatically request write
 * permission from the user."
 *
 *  - A signed-in user never writes through the site-wide GITHUB_TOKEN: when
 *    they have no token of their own, the platform asks them to authorize.
 *  - A read-only user token (no `repo` scope) that GitHub rejects on a write
 *    becomes "grant write access" instead of an opaque 403/404.
 *  - `/auth/github/login?scope=write` requests `repo` on top of the login scope.
 *  - Error responses carry `githubAuthorization` so the SPA starts the flow.
 * ------------------------------------------------------------------ */

const ENV_KEYS = [
  "REQUIRE_AUTH",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_OAUTH_SCOPE",
  "AUTH_SECRET",
  "GITHUB_TOKEN",
  "GITHUB_ENABLED",
] as const;
let savedEnv: Record<string, string | undefined>;
let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;

async function boot(register?: (srv: FastifyInstance) => void): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  register?.(app);
  await app.ready();
  return app;
}

function user(id: number, login: string) {
  return container.userRepo.upsertGitHubUser({ id, login, name: login, email: `${login}@example.com` }).user;
}

/** GitHub fake that rejects writes unless the token is allowed to write. */
function writeGuardedGitHub(opts: { token: string; canWrite: boolean; writeStatus?: number }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (auth !== `Bearer ${opts.token}`) {
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && !opts.canWrite) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: opts.writeStatus ?? 404 });
    }
    if (method === "POST" && url.endsWith("/git/refs")) {
      return new Response(JSON.stringify({ ref: "refs/heads/x" }), { status: 201 });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as typeof fetch;
}

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: "p-write",
    ownerId: "u-owner",
    name: "Write",
    githubConnection: { kind: "server-token" },
    ...over,
  }) as unknown as Project;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_SECRET = "test-auth-secret-for-github-write-auth-0123456789";
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

function enableServerToken(): void {
  process.env.GITHUB_TOKEN = "ghs_site_token";
  process.env.GITHUB_ENABLED = "true";
  getEnvFresh();
}

describe("scope helpers", () => {
  it("detects write scope and merges scopes without duplicates", () => {
    expect(hasGitHubWriteScope(["repo", "read:user"])).toBe(true);
    expect(hasGitHubWriteScope(["public_repo"])).toBe(false);
    expect(hasGitHubWriteScope(undefined)).toBe(false);
    expect(mergeOAuthScopes("read:user user:email", ["repo"])).toBe("read:user user:email repo");
    expect(mergeOAuthScopes("repo,read:user", ["repo"])).toBe("repo read:user");
    expect(buildWriteAuthorizeUrl("#/projects/p1")).toBe("/auth/github/login?scope=write&next=%23%2Fprojects%2Fp1");
  });
});

describe("the site token is never used for a signed-in user's writes", () => {
  it("asks a signed-in user without a token to authorize instead of using GITHUB_TOKEN", async () => {
    enableServerToken();
    await boot();
    const alice = user(1, "alice");
    let thrown: unknown;
    try {
      resolveGitHubForProject({
        project: project({ ownerId: alice.id }),
        kv: container.kv,
        fallback: container.github,
        requestUserId: alice.id,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GitHubAuthorizationRequiredError);
    const notice = (thrown as GitHubAuthorizationRequiredError).notice;
    expect(notice.reason).toBe("no-token");
    expect(notice.requiredScopes).toEqual(["repo"]);
    expect(notice.authorizeUrl).toContain("/auth/github/login?scope=write");
  });

  it("uses the signed-in user's own token when present (not the site token)", async () => {
    enableServerToken();
    await boot();
    const alice = user(1, "alice");
    storeUserGitHubToken(container.kv, alice.id, "tok-alice", { scopes: "repo", login: "alice" });
    const seen: string[] = [];
    setUserGitHubFetchForTest((async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ login: "alice" }), { status: 200 });
    }) as typeof fetch);
    const gh = resolveGitHubForProject({
      project: project({ ownerId: alice.id }),
      kv: container.kv,
      fallback: container.github,
      requestUserId: alice.id,
    });
    expect((await gh.getViewer()).login).toBe("alice");
    expect(seen).toEqual(["Bearer tok-alice"]);
  });

  it("the request context alone (no explicit requestUserId) is enough to block the site token", async () => {
    enableServerToken();
    await boot();
    const alice = user(1, "alice");
    runWithGitHubRequestContext({ signedInUserId: alice.id }, () => {
      expect(() =>
        resolveGitHubForProject({
          project: project({ ownerId: alice.id }),
          kv: container.kv,
          fallback: container.github,
        }),
      ).toThrow(GitHubAuthorizationRequiredError);
      expect(pendingGitHubAuthorization()?.reason).toBe("no-token");
    });
  });

  it("background work without a request user keeps the stored server-token connection", async () => {
    enableServerToken();
    await boot();
    const gh = resolveGitHubForProject({ project: project(), kv: container.kv, fallback: container.github });
    expect(gh.kind).toBe("real");
  });
});

describe("read-only user tokens are upgraded to write access", () => {
  it("turns a write rejected for a read-only token into 'grant write access'", async () => {
    await boot();
    const alice = user(1, "alice");
    storeUserGitHubToken(container.kv, alice.id, "tok-ro", { scopes: "public_repo,read:user", login: "alice" });
    setUserGitHubFetchForTest(writeGuardedGitHub({ token: "tok-ro", canWrite: false }));
    const gh = resolveGitHubForProject({
      project: project({ ownerId: alice.id, githubConnection: { kind: "user-oauth", userId: alice.id } }),
      kv: container.kv,
      fallback: container.github,
      requestUserId: alice.id,
    });
    const err = await gh.createBranch({ owner: "alice", name: "private" }, "x", "abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubAuthorizationRequiredError);
    expect((err as GitHubAuthorizationRequiredError).notice.reason).toBe("missing-scope");
    expect((err as GitHubAuthorizationRequiredError).notice.grantedScopes).toEqual(["public_repo", "read:user"]);
  });

  it("keeps a genuine 404 for a token that already has write scope", async () => {
    await boot();
    const alice = user(1, "alice");
    storeUserGitHubToken(container.kv, alice.id, "tok-rw", { scopes: "repo", login: "alice" });
    setUserGitHubFetchForTest(writeGuardedGitHub({ token: "tok-rw", canWrite: false }));
    const gh = resolveGitHubForProject({
      project: project({ ownerId: alice.id }),
      kv: container.kv,
      fallback: container.github,
      requestUserId: alice.id,
    });
    const err = await gh.createBranch({ owner: "alice", name: "gone" }, "x", "abc").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GitHubAuthorizationRequiredError);
    expect(String(err)).toMatch(/404/);
  });

  it("asks to re-authorize when GitHub rejects the stored token", async () => {
    await boot();
    const alice = user(1, "alice");
    storeUserGitHubToken(container.kv, alice.id, "tok-revoked", { scopes: "repo", login: "alice" });
    setUserGitHubFetchForTest(writeGuardedGitHub({ token: "something-else", canWrite: true }));
    const gh = resolveGitHubForProject({
      project: project({ ownerId: alice.id }),
      kv: container.kv,
      fallback: container.github,
      requestUserId: alice.id,
    });
    const err = await gh.createBranch({ owner: "alice", name: "r" }, "x", "abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubAuthorizationRequiredError);
    expect((err as GitHubAuthorizationRequiredError).notice.reason).toBe("token-rejected");
  });
});

describe("HTTP: automatic write-access request", () => {
  function configureOAuth(scope?: string): void {
    process.env.GITHUB_CLIENT_ID = "Iv1.testclientid";
    process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
    if (scope) process.env.GITHUB_OAUTH_SCOPE = scope;
    getEnvFresh();
  }

  it("/auth/github/login?scope=write requests `repo` on top of the configured login scope", async () => {
    configureOAuth("read:user user:email");
    const srv = await boot();
    const plain = await srv.inject({ method: "GET", url: "/auth/github/login?format=json" });
    expect(plain.statusCode).toBe(200);
    expect(new URL(plain.json().url).searchParams.get("scope")).toBe("read:user user:email");

    const write = await srv.inject({
      method: "GET",
      url: "/auth/github/login?format=json&scope=write&next=%23%2Fprojects",
    });
    const url = new URL(write.json().url);
    expect(url.searchParams.get("scope")).toBe("read:user user:email repo");
    // Arbitrary scopes are never passed through.
    const evil = await srv.inject({ method: "GET", url: "/auth/github/login?format=json&scope=admin:org" });
    expect(new URL(evil.json().url).searchParams.get("scope")).toBe("read:user user:email");
  });

  it("/auth/me reports whether the user's token can write", async () => {
    configureOAuth();
    const srv = await boot();
    const alice = user(1, "alice");
    storeUserGitHubToken(container.kv, alice.id, "tok-ro", { scopes: "public_repo", login: "alice" });
    const ro = await srv.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: `cv_session=${signSession(alice.id)}` },
    });
    expect(ro.json().githubToken.canWrite).toBe(false);
    expect(ro.json().githubToken.writeAuthorizeUrl).toBe("/auth/github/login?scope=write");

    storeUserGitHubToken(container.kv, alice.id, "tok-rw", { scopes: "repo,read:user", login: "alice" });
    const rw = await srv.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: `cv_session=${signSession(alice.id)}` },
    });
    expect(rw.json().githubToken.canWrite).toBe(true);
  });

  it("GitHub-page writes by a token-less user answer 403 with an authorization block, never the site token", async () => {
    configureOAuth();
    enableServerToken();
    const srv = await boot();
    const alice = user(1, "alice");
    const res = await srv.inject({
      method: "POST",
      url: "/github/repositories",
      headers: { cookie: `cv_session=${signSession(alice.id)}` },
      payload: { name: "new-repo" },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe("github_authorization_required");
    expect(body.githubAuthorization.reason).toBe("no-token");
    expect(body.githubAuthorization.authorizeUrl).toContain("scope=write");
  });

  it("project creation by a token-less user asks for authorization instead of binding the site token", async () => {
    configureOAuth();
    enableServerToken();
    const srv = await boot();
    const alice = user(1, "alice");
    const before = container.projectRepo.findMany({}).length;
    const res = await srv.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie: `cv_session=${signSession(alice.id)}` },
      payload: { name: "Mine", configRepo: "alice/mine" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().githubAuthorization.reason).toBe("no-token");
    expect(container.projectRepo.findMany({}).length).toBe(before);
  });

  it("attaches the authorization block even when a route catches the GitHub error itself", async () => {
    configureOAuth();
    enableServerToken();
    let aliceId = "";
    // Route whose handler swallows the error and answers with its own message.
    const srv = await boot((s) =>
      s.get("/__test/swallow", async (_req, reply) => {
        try {
          resolveGitHubForProject({
            project: project({ ownerId: aliceId }),
            kv: container.kv,
            fallback: container.github,
          });
          return { ok: true };
        } catch {
          reply.code(500);
          return { error: "sync failed" };
        }
      }),
    );
    const alice = user(1, "alice");
    aliceId = alice.id;
    const res = await srv.inject({
      method: "GET",
      url: "/__test/swallow",
      headers: { cookie: `cv_session=${signSession(alice.id)}` },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("sync failed");
    expect(res.json().githubAuthorization.reason).toBe("no-token");
  });

  it("an escaped authorization error becomes a structured 403", async () => {
    configureOAuth();
    enableServerToken();
    let aliceId = "";
    const srv = await boot((s) =>
      s.get("/__test/escape", async () => {
        resolveGitHubForProject({
          project: project({ ownerId: aliceId }),
          kv: container.kv,
          fallback: container.github,
        });
        return { ok: true };
      }),
    );
    const alice = user(1, "alice");
    aliceId = alice.id;
    const res = await srv.inject({
      method: "GET",
      url: "/__test/escape",
      headers: { cookie: `cv_session=${signSession(alice.id)}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("github_authorization_required");
  });
});
