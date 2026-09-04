import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { signSession } from "../auth/github-oauth.js";
import {
  decryptToken,
  describeUserGitHubToken,
  encryptToken,
  getUserGitHubToken,
  storeUserGitHubToken,
  GITHUB_TOKEN_KV_PREFIX,
} from "../auth/github-tokens.js";
import { setUserGitHubFetchForTest } from "../github/registry.js";
import { RealGitHubService, GitHubAuthError, parseNextLink } from "../github/real-service.js";
import { MockGitHubService } from "../github/mock-service.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Regression tests for "GitHub repositories are not displayed":
 *   - the OAuth callback discarded the user's access token, so the repo
 *     picker never had anything to list;
 *   - the dev mock had no repositories at all;
 *   - GitHub failures came back as 200 `{error}` bodies.
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

/** A fake GitHub REST API: two pages of /user/repos, /user with scopes. */
function fakeGitHub(opts: { token: string; scopes?: string; failWith?: number }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (opts.failWith) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: opts.failWith });
    if (auth !== `Bearer ${opts.token}`) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    if (url.includes("/user/repos")) {
      const page = new URL(url).searchParams.get("page") ?? "1";
      const mk = (i: number, priv: boolean) => ({
        id: i,
        name: `repo-${i}`,
        full_name: `octo/repo-${i}`,
        private: priv,
        default_branch: "main",
        description: `Repository ${i}`,
        html_url: `https://github.com/octo/repo-${i}`,
        language: "TypeScript",
        pushed_at: "2026-01-01T00:00:00Z",
        archived: false,
        owner: { login: "octo" },
        permissions: { admin: true, push: true, pull: true },
      });
      if (page === "1") {
        return new Response(JSON.stringify([mk(1, false), mk(2, true)]), {
          status: 200,
          headers: { link: `<https://api.github.com/user/repos?per_page=100&page=2>; rel="next"` },
        });
      }
      return new Response(JSON.stringify([mk(3, true)]), { status: 200 });
    }
    if (url.endsWith("/user")) {
      return new Response(JSON.stringify({ login: "octo", name: "Octo Cat" }), {
        status: 200,
        headers: { "x-oauth-scopes": opts.scopes ?? "repo, read:user, user:email" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_SECRET = "test-auth-secret-for-github-repo-tests-0123456789";
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

describe("encrypted per-user GitHub token store", () => {
  it("round-trips through AES-GCM and never stores the token in clear text", async () => {
    await boot();
    const kv = container.kv;
    storeUserGitHubToken(kv, "user-1", "gho_secret_token_value", { scopes: "repo, read:user", login: "octo" });
    const raw = kv.get<Record<string, unknown>>(GITHUB_TOKEN_KV_PREFIX + "user-1");
    expect(JSON.stringify(raw)).not.toContain("gho_secret_token_value");
    expect(getUserGitHubToken(kv, "user-1")).toMatchObject({ token: "gho_secret_token_value", scopes: ["repo", "read:user"], login: "octo" });
    expect(describeUserGitHubToken(kv, "user-1")).toMatchObject({ stored: true, canReadPrivateRepos: true, login: "octo" });
    expect(JSON.stringify(describeUserGitHubToken(kv, "user-1"))).not.toContain("gho_");
    expect(getUserGitHubToken(kv, "nobody")).toBeUndefined();
  });

  it("detects a missing `repo` scope (private repositories hidden)", async () => {
    await boot();
    storeUserGitHubToken(container.kv, "u2", "t", { scopes: "read:user,user:email" });
    expect(describeUserGitHubToken(container.kv, "u2").canReadPrivateRepos).toBe(false);
  });

  it("fails closed when decrypted with a different secret", () => {
    const enc = encryptToken("abc", "secret-A");
    expect(decryptToken(enc, "secret-A")).toBe("abc");
    expect(decryptToken(enc, "secret-B")).toBeUndefined();
  });
});

describe("RealGitHubService.listRepositories", () => {
  it("paginates /user/repos, maps fields and applies query/limit", async () => {
    const svc = new RealGitHubService({ token: "tok", fetchImpl: fakeGitHub({ token: "tok" }) });
    const all = await svc.listRepositories();
    expect(all.map((r) => r.fullName)).toEqual(["octo/repo-1", "octo/repo-2", "octo/repo-3"]);
    expect(all[1]).toMatchObject({ owner: "octo", name: "repo-2", private: true, defaultBranch: "main", language: "TypeScript" });
    expect((await svc.listRepositories({ query: "repo-3" })).map((r) => r.fullName)).toEqual(["octo/repo-3"]);
    expect(await svc.listRepositories({ limit: 1 })).toHaveLength(1);
    const viewer = await svc.getViewer();
    expect(viewer).toMatchObject({ login: "octo", scopes: ["repo", "read:user", "user:email"] });
  });

  it("throws GitHubAuthError on 401 and when no token is configured", async () => {
    const bad = new RealGitHubService({ token: "wrong", fetchImpl: fakeGitHub({ token: "tok" }) });
    await expect(bad.listRepositories()).rejects.toBeInstanceOf(GitHubAuthError);
    const none = new RealGitHubService({ token: () => undefined, fetchImpl: fakeGitHub({ token: "tok" }) });
    await expect(none.listRepositories()).rejects.toThrow(/token not configured/);
  });

  it("parses the Link header", () => {
    expect(parseNextLink('<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"')).toBe(
      "https://api.github.com/user/repos?page=2",
    );
    expect(parseNextLink('<https://api.github.com/user/repos?page=1>; rel="prev"')).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });
});

describe("GET /github/repositories", () => {
  it("lists demo repositories from the mock in dev (never an empty picker)", async () => {
    const srv = await boot();
    const res = await srv.inject({ method: "GET", url: "/github/repositories" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("mock");
    expect(body.repositories.map((r: { fullName: string }) => r.fullName)).toContain("acme/accounting");
    expect(body.count).toBeGreaterThanOrEqual(3);
    const filtered = (await srv.inject({ method: "GET", url: "/github/repositories?q=store" })).json();
    expect(filtered.repositories.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/storefront"]);
  });

  it("uses the logged-in user's stored OAuth token (their own repositories)", async () => {
    process.env.REQUIRE_AUTH = "true";
    process.env.GITHUB_CLIENT_ID = "Ov23liTESTCLIENTID";
    process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
    getEnvFresh();
    const srv = await boot();
    const { user } = container.userRepo.upsertGitHubUser({ id: 42, login: "octo", name: "Octo Cat", email: "octo@example.com" });
    storeUserGitHubToken(container.kv, user.id, "tok", { scopes: "repo,read:user,user:email", login: "octo" });
    setUserGitHubFetchForTest(fakeGitHub({ token: "tok" }));
    const cookie = `cv_session=${signSession(user.id)}`;

    const res = await srv.inject({ method: "GET", url: "/github/repositories", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("user-oauth");
    expect(res.json().repositories.map((r: { fullName: string }) => r.fullName)).toEqual(["octo/repo-1", "octo/repo-2", "octo/repo-3"]);

    const status = (await srv.inject({ method: "GET", url: "/integrations/github/status", headers: { cookie } })).json();
    expect(status.source).toBe("user-oauth");
    expect(status.repoCount).toBe(3);
    expect(status.viewer.login).toBe("octo");
    expect(status.userToken).toMatchObject({ stored: true, canReadPrivateRepos: true });

    const me = (await srv.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).json();
    expect(me.githubToken).toMatchObject({ stored: true, canReadPrivateRepos: true, login: "octo" });
    expect(JSON.stringify(me)).not.toContain("tok\"");

    // logout drops the stored token
    await srv.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect(getUserGitHubToken(container.kv, user.id)).toBeUndefined();
  });

  it("maps a revoked user token to 401 with a re-login hint instead of a 200 error body", async () => {
    process.env.REQUIRE_AUTH = "true";
    process.env.GITHUB_CLIENT_ID = "Ov23liTESTCLIENTID";
    process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
    getEnvFresh();
    const srv = await boot();
    const { user } = container.userRepo.upsertGitHubUser({ id: 43, login: "revoked", name: "R", email: "r@example.com" });
    storeUserGitHubToken(container.kv, user.id, "old", { scopes: "repo" });
    setUserGitHubFetchForTest(fakeGitHub({ token: "new", failWith: 401 }));
    const res = await srv.inject({ method: "GET", url: "/github/repositories", headers: { cookie: `cv_session=${signSession(user.id)}` } });
    expect(res.statusCode).toBe(401);
    expect(res.json().hint).toMatch(/log in with GitHub again/i);
  });

  it("mock service exposes viewer + repo metadata for the picker", async () => {
    const mock = new MockGitHubService();
    const repos = await mock.listRepositories({ query: "acme" });
    expect(repos.length).toBeGreaterThanOrEqual(3);
    expect(repos[0]).toHaveProperty("fullName");
    expect(repos[0]).toHaveProperty("defaultBranch");
    expect((await mock.getViewer()).login).toBe("mock-user");
  });
});
