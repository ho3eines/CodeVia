import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";
import { signSession } from "../auth/github-oauth.js";
import { storeUserGitHubToken } from "../auth/github-tokens.js";
import { setUserGitHubFetchForTest } from "../github/registry.js";
import { RealGitHubService } from "../github/real-service.js";
import type { IGitHubService } from "../github/types.js";
import type { Project } from "../domain/entities.js";
import {
  readRepoBrief,
  repoContextPrompt,
  repoContextFor,
  invalidateRepoBrief,
  repoBriefCacheSize,
} from "../agents/repo-brief.js";

/* ------------------------------------------------------------------ *
 * "Why can't the AI see my repository?"
 *
 * Reported symptom: the project chat answered a code question with
 * "I cannot see your project's real code because the repository
 * ho3eines/Projects returns 404" — for a repository that is public,
 * reachable and 906 files large.
 *
 * Root cause: `buildRepoBrief()` walked the GitHub Contents API one
 * directory at a time (99 sequential requests, ~12 s for that repository)
 * inside an 8 s chat budget, and every failure was swallowed into an empty
 * string. The model therefore received no evidence and no explanation, and
 * invented the most plausible-sounding one (a 404).
 *
 * These tests pin the three fixes: a one-request listing (see
 * agent-github-contract.test.ts), a brief that reports *why* it is empty
 * (cached per account, branch self-heal, timeout), and a prompt/UI that
 * carries that diagnosis instead of leaving the model to guess.
 * ------------------------------------------------------------------ */

const ENV_KEYS = ["REQUIRE_AUTH", "GITHUB_TOKEN", "GITHUB_ENABLED", "AUTH_SECRET", "REPO_BRIEF_TTL_MS"] as const;
let savedEnv: Record<string, string | undefined>;
let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;

/** A repository as the fake GitHub serves it. */
interface FakeRepo {
  defaultBranch?: string;
  branches?: string[];
  files?: Record<string, string>;
  /** Answer 404 for everything under this repository (private/missing). */
  hidden?: boolean;
}

/**
 * GitHub fake that speaks the endpoints the platform actually uses:
 * `/user`, `/repos/{o}/{r}`, `/branches`, `/git/trees/{ref}?recursive=1`
 * and `/contents/{path}`. Unknown repositories answer 404 like GitHub does.
 */
function fakeGitHub(opts: {
  login: string;
  scopes?: string;
  repos: Record<string, FakeRepo>;
  onRequest?: (url: string) => void;
}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    opts.onRequest?.(url);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers });
    if (url.endsWith("/user"))
      return json({ login: opts.login, name: opts.login }, 200, {
        "x-oauth-scopes": opts.scopes ?? "repo, read:user, user:email",
      });

    const m = url.match(/\/repos\/([^/]+)\/([^/?]+)(\/.*)?$/);
    if (!m) return json({ message: "Not Found" }, 404);
    const full = `${m[1]}/${m[2]}`;
    const rest = m[3] ?? "";
    const repo = opts.repos[full];
    if (!repo || repo.hidden) return json({ message: "Not Found" }, 404);
    const branch = repo.defaultBranch ?? "main";
    const branches = repo.branches ?? [branch];
    const files = repo.files ?? {};

    if (rest === "" || rest === "/")
      return json({
        full_name: full,
        name: m[2],
        private: false,
        default_branch: branch,
        owner: { login: m[1] },
        html_url: `https://github.com/${full}`,
        permissions: { admin: true, push: true, pull: true },
      });
    if (rest.startsWith("/branches")) return json(branches.map((name) => ({ name, commit: { sha: `sha-${name}` } })));
    if (rest.startsWith("/git/trees/")) {
      const ref = decodeURIComponent(rest.slice("/git/trees/".length).replace(/\?.*$/, ""));
      if (!branches.includes(ref) && !ref.startsWith("sha-")) return json({ message: "Not Found" }, 404);
      const paths = Object.keys(files);
      const dirs = new Set<string>();
      for (const p of paths) {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
      }
      return json({
        sha: `sha-${ref}`,
        truncated: false,
        tree: [
          ...[...dirs].map((path) => ({ path, type: "tree" })),
          ...paths.map((path) => ({ path, type: "blob", size: (files[path] ?? "").length })),
        ],
      });
    }
    if (rest.startsWith("/contents/")) {
      const path = decodeURIComponent(rest.slice("/contents/".length).replace(/\?.*$/, ""));
      const q = new URL(url).searchParams.get("ref") ?? branch;
      if (!branches.includes(q)) return json({ message: "Not Found" }, 404);
      if (path in files)
        return json({
          path,
          sha: "blob-sha",
          encoding: "base64",
          content: Buffer.from(files[path]).toString("base64"),
        });
      return json({ message: "Not Found" }, 404);
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
}

/** Minimal project record with a real (non-mock) GitHub connection. */
function project(id: string, slug: string, repo: string, branch = "main", ownerId?: string): Project {
  const now = new Date().toISOString();
  return {
    id,
    slug,
    name: slug,
    description: "Tarazin — multi-branch gold jewellery ERP",
    configRepo: repo,
    branch,
    ownerId,
    capabilities: {
      platforms: [],
      languages: [],
      frameworks: [],
      databases: [],
      deploymentTargets: [],
      features: [],
      integrations: [],
      agentTypes: [],
    },
    githubConnection: { kind: "user-oauth", userId: ownerId ?? "user-local", login: "tester" },
    repositories: [{ repo, branch, role: "primary", isConfigRepo: true, addedAt: now }],
    settings: {
      environment: "development",
      notifications: [],
      rules: [],
      skills: [],
      generatedSkills: [],
      workflows: [],
      budget: { maxTokensPerRun: 20000, maxCallsPerRun: 20, maxCostUsdPerRun: 5, maxDurationMs: 600000 },
      permissions: {},
      metadata: {},
    },
    active: true,
    createdAt: now,
    updatedAt: now,
  } as unknown as Project;
}

/** A repository shaped like the real report: many folders, a README, CI. */
function bigRepo(dirs = 40, perDir = 22): Record<string, string> {
  const files: Record<string, string> = {
    "README.md": "# Tarazin\nFive-layer ERP for multi-branch gold jewellery stores.",
    "Tarazin.slnx": "<Solution />",
    "global.json": '{ "sdk": { "version": "9.0.100" } }',
    ".github/workflows/ci.yml": "name: ci\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest",
  };
  for (let d = 0; d < dirs; d += 1)
    for (let f = 0; f < perDir; f += 1) files[`Tarazin.Layer${d}/Service${f}.cs`] = `// class Service${f}`;
  return files;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_SECRET = "test-auth-secret-for-repo-context-0123456789";
  getEnvFresh();
  cleanup = freshDb().cleanup;
  invalidateRepoBrief();
});

afterEach(async () => {
  setUserGitHubFetchForTest(undefined);
  invalidateRepoBrief();
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

describe("repository brief — evidence instead of silence", () => {
  it("reads a 900-file repository and keeps the folder roll-up", async () => {
    const requests: string[] = [];
    const gh = new RealGitHubService({
      token: "t",
      fetchImpl: fakeGitHub({
        login: "ho3eines",
        repos: { "ho3eines/Projects": { files: bigRepo() } },
        onRequest: (u) => requests.push(u),
      }),
    });
    const brief = await readRepoBrief({ github: gh, project: project("p1", "tarazin", "ho3eines/Projects") });
    expect(brief.status).toBe("ok");
    expect(brief.files).toBeGreaterThan(800);
    expect(brief.text).toContain("# Tarazin");
    expect(brief.text).toContain("Top-level folders:");
    expect(brief.text).toContain("Tarazin.Layer0/ (22)");
    expect(brief.text).toContain("ci.yml");
    // One tree request + README + manifests: never one request per directory.
    expect(requests.filter((u) => u.includes("/contents/")).length).toBeLessThanOrEqual(4);
    expect(requests.filter((u) => u.includes("/git/trees/")).length).toBe(1);
  });

  it("caches the brief per account and never shares a cached read across accounts", async () => {
    let calls = 0;
    const gh = new RealGitHubService({
      token: "t",
      fetchImpl: fakeGitHub({
        login: "ho3eines",
        repos: { "acme/app": { files: { "README.md": "# app" } } },
        onRequest: () => (calls += 1),
      }),
    });
    const p = project("p2", "app", "acme/app");
    const first = await readRepoBrief({ github: gh, project: p, cacheScope: "user-a" });
    const second = await readRepoBrief({ github: gh, project: p, cacheScope: "user-a" });
    expect(first.source).toBe("github");
    expect(second.source).toBe("cache");
    expect(second.text).toBe(first.text);
    const callsAfterReuse = calls;

    // A different account must not be served another account's cached answer.
    const other = await readRepoBrief({ github: gh, project: p, cacheScope: "user-b" });
    expect(other.source).toBe("github");
    expect(calls).toBeGreaterThan(callsAfterReuse);
    expect(repoBriefCacheSize()).toBe(2);

    // refresh=1 re-reads even for the same scope.
    const refreshed = await readRepoBrief({ github: gh, project: p, cacheScope: "user-a", refresh: true });
    expect(refreshed.source).toBe("github");
  });

  it("reports an actionable reason when GitHub answers 404 — never a silent empty string", async () => {
    const gh = new RealGitHubService({
      token: "t",
      fetchImpl: fakeGitHub({ login: "someone-else", repos: { "ho3eines/Projects": { hidden: true } } }),
    });
    const brief = await readRepoBrief({ github: gh, project: project("p3", "hidden", "ho3eines/Projects") });
    expect(brief.status).toBe("unavailable");
    expect(brief.text).toBe("");
    expect(brief.errorKind).toBe("not-found");
    expect(brief.reason).toContain("404");
    expect(brief.hint).toMatch(/github\.com\/ho3eines\/Projects/);
    expect(brief.hint).toMatch(/sign out and back in/i);
  });

  it("self-heals a wrong branch: reads the default branch and says so", async () => {
    const gh = new RealGitHubService({
      token: "t",
      fetchImpl: fakeGitHub({
        login: "ho3eines",
        repos: { "acme/legacy": { defaultBranch: "master", branches: ["master"], files: { "README.md": "# legacy" } } },
      }),
    });
    const brief = await readRepoBrief({ github: gh, project: project("p4", "legacy", "acme/legacy", "main") });
    expect(brief.status).toBe("ok");
    expect(brief.branch).toBe("master");
    expect(brief.configuredBranch).toBe("main");
    expect(brief.reason).toContain('Branch "main" does not exist');
    expect(brief.hint).toContain("master");
    expect(repoContextPrompt(brief)).toContain('configured for branch "main"');
  });

  it("reports a timeout instead of hanging or answering with nothing", async () => {
    const slow = {
      kind: "real",
      listFiles: () => new Promise((resolve) => setTimeout(() => resolve([]), 500)),
      getFile: async () => undefined,
    } as unknown as IGitHubService;
    const brief = await readRepoBrief({
      github: slow,
      project: project("p5", "slow", "acme/slow"),
      timeoutMs: 40,
      ttlMs: 0,
    });
    expect(brief.status).toBe("unavailable");
    expect(brief.errorKind).toBe("timeout");
    expect(brief.reason).toContain("aborted");
  });

  it("reports an empty repository as empty (not as unreachable)", async () => {
    const gh = new RealGitHubService({
      token: "t",
      fetchImpl: fakeGitHub({ login: "ho3eines", repos: { "acme/blank": { files: {} } } }),
    });
    const brief = await readRepoBrief({ github: gh, project: project("p6", "blank", "acme/blank") });
    expect(brief.status).toBe("empty");
    expect(brief.reason).toContain("no files");
  });

  it("explains a project with no connected repository", async () => {
    const gh = new RealGitHubService({ token: "t", fetchImpl: fakeGitHub({ login: "x", repos: {} }) });
    const p = project("p7", "norepo", "acme/x");
    (p as unknown as { configRepo: string }).configRepo = "";
    const brief = await readRepoBrief({ github: gh, project: p });
    expect(brief.status).toBe("unavailable");
    expect(brief.hint).toMatch(/link the GitHub repository/i);
  });

  it("forbids the model from inventing a 404 when evidence is unavailable", () => {
    const blocked = repoContextPrompt({
      text: "",
      status: "unavailable",
      repo: "ho3eines/Projects",
      branch: "main",
      files: 0,
      listed: 0,
      directories: [],
      reason: "GitHub answered 404 while reading ho3eines/Projects@main.",
      hint: "Re-connect GitHub.",
      errorKind: "not-found",
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
      source: "github",
      via: "api",
      elapsedMs: 1,
    });
    expect(blocked).toContain("UNAVAILABLE");
    expect(blocked).toContain("GitHub answered 404 while reading ho3eines/Projects@main.");
    expect(blocked).toContain("Never claim the repository does not exist");
    expect(blocked).toContain("label every assumption as an assumption");

    const ok = repoContextPrompt({
      text: "Repository files (2):\n- README.md\n- src/a.ts",
      status: "ok",
      repo: "acme/app",
      branch: "main",
      files: 2,
      listed: 2,
      directories: [],
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
      source: "github",
      via: "api",
      elapsedMs: 1,
    });
    expect(ok).toContain("Repository files (2)");
    expect(ok).not.toContain("UNAVAILABLE");
  });

  it("projects a UI-safe summary without the prompt text", () => {
    const summary = repoContextFor({
      text: "x".repeat(5000),
      status: "ok",
      repo: "acme/app",
      branch: "main",
      files: 906,
      listed: 120,
      directories: Array.from({ length: 30 }, (_, i) => ({ path: `d${i}`, files: i })),
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
      source: "cache",
      via: "api",
      elapsedMs: 3,
    });
    expect(summary).toBeDefined();
    expect(summary!.text).toBeUndefined();
    expect(summary!.files).toBe(906);
    expect((summary!.directories as unknown[]).length).toBe(12);
    expect(repoContextFor(undefined)).toBeUndefined();
  });
});

describe("project chat + repository health endpoint", () => {
  async function boot() {
    container = new Container();
    await container.ensureSeed();
    app = (await buildServer(container)).app;
    await app.ready();
    return app;
  }

  async function signedInProject(opts: { repo: string; branch?: string; repos: Record<string, FakeRepo> }) {
    const srv = await boot();
    const user = container.userRepo.upsertGitHubUser({
      id: 42,
      login: "ho3eines",
      name: "Hossein",
      email: "h@example.com",
    }).user;
    storeUserGitHubToken(container.kv, user.id, "tok-user", { scopes: "repo", login: "ho3eines" });
    setUserGitHubFetchForTest(fakeGitHub({ login: "ho3eines", repos: opts.repos }));
    const p = project(
      `proj-${opts.repo.replace(/\W/g, "-")}`,
      opts.repo.replace(/\W/g, "-"),
      opts.repo,
      opts.branch,
      user.id,
    );
    container.projectRepo.upsert(p, { key: p.slug });
    const conv = (
      await srv.inject({
        method: "POST",
        url: "/conversations",
        payload: { projectId: p.id, title: "Project chat", userId: user.id },
        headers: { cookie: `cv_session=${signSession(user.id)}` },
      })
    ).json();
    return { srv, user, project: p, conversationId: conv.id as string, cookie: `cv_session=${signSession(user.id)}` };
  }

  it("gives the chat model real repository evidence through a real GitHub connection", async () => {
    const {
      srv,
      project: p,
      conversationId,
      cookie,
    } = await signedInProject({
      repo: "ho3eines/Projects",
      repos: {
        "ho3eines/Projects": {
          files: {
            "README.md": "# Tarazin — five-layer ERP",
            "Tarazin.Data/DbContext.cs": "public class DbContext {}",
            ".github/workflows/ci.yml": "name: ci",
          },
        },
      },
    });
    const spy = vi.spyOn(container.aiText, "complete");
    try {
      const res = await srv.inject({
        method: "POST",
        url: `/conversations/${conversationId}/messages`,
        payload: { role: "user", content: "پروژه رو بررسی کن" },
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.repoContext.status).toBe("ok");
      expect(body.repoContext.repo).toBe("ho3eines/Projects");
      expect(body.repoContext.files).toBe(3);
      const system = spy.mock.calls[0][0].messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("Tarazin — five-layer ERP");
      expect(system).toContain("Tarazin.Data/DbContext.cs");
      expect(system).not.toContain("UNAVAILABLE");
    } finally {
      spy.mockRestore();
    }
    expect(p.configRepo).toBe("ho3eines/Projects");
  }, 30000);

  it("tells the chat model the truth (and the fix) when the repository cannot be read", async () => {
    const { srv, conversationId, cookie } = await signedInProject({
      repo: "ho3eines/Private",
      repos: { "ho3eines/Private": { hidden: true } },
    });
    const spy = vi.spyOn(container.aiText, "complete");
    try {
      const res = await srv.inject({
        method: "POST",
        url: `/conversations/${conversationId}/messages`,
        payload: { role: "user", content: "چرا ریپازیتوری را نمی‌بینی؟" },
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      // The response carries the diagnosis so the UI can show it too.
      expect(body.repoContext.status).toBe("unavailable");
      expect(body.repoContext.errorKind).toBe("not-found");
      expect(body.repoContext.reason).toContain("404");
      const system = spy.mock.calls[0][0].messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("Repository context: UNAVAILABLE");
      expect(system).toContain("Never claim the repository does not exist");
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it("GET /projects/:id/repo-status reports a healthy, CI-backed repository", async () => {
    const {
      srv,
      project: p,
      cookie,
    } = await signedInProject({
      repo: "ho3eines/Projects",
      repos: {
        "ho3eines/Projects": {
          files: {
            "README.md": "# Tarazin",
            "Tarazin.Data/DbContext.cs": "x",
            ".github/workflows/ci.yml": "name: ci",
          },
        },
      },
    });
    const res = await srv.inject({ method: "GET", url: `/projects/${p.id}/repo-status`, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.healthy).toBe(true);
    expect(body.connection.source).toBe("user-oauth");
    expect(body.connection.login).toBe("ho3eines");
    expect(body.connection.scopes).toContain("repo");
    const repo = body.repositories[0];
    expect(repo.readable).toBe(true);
    expect(repo.branchExists).toBe(true);
    expect(repo.files).toBe(3);
    expect(repo.readme).toBe(true);
    expect(repo.ciWorkflows).toEqual([".github/workflows/ci.yml"]);
    expect(repo.hint).toBeUndefined();
    expect(body.brief.status).toBe("ok");
  }, 30000);

  it("GET /projects/:id/repo-status explains a wrong branch, missing CI and a hidden repository", async () => {
    const {
      srv,
      project: p,
      cookie,
    } = await signedInProject({
      repo: "acme/app",
      branch: "release-9",
      repos: {
        "acme/app": { defaultBranch: "main", branches: ["main"], files: { "README.md": "# app" } },
        "acme/hidden": { hidden: true },
      },
    });
    const res = await srv.inject({ method: "GET", url: `/projects/${p.id}/repo-status`, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.healthy).toBe(false);
    const repo = body.repositories[0];
    expect(repo.branchExists).toBe(false);
    expect(repo.error).toContain('Branch "release-9" does not exist');
    expect(repo.hint).toContain("main");
    expect(repo.availableBranches).toEqual(["main"]);
    expect(body.brief.status).toBe("ok"); // self-healed onto the default branch
    expect(body.brief.branch).toBe("main");
    expect(body.brief.configuredBranch).toBe("release-9");

    // A repository without CI can never be test-verified — say so.
    const noCi = await srv.inject({
      method: "GET",
      url: `/projects/${p.id}/repo-status?refresh=1`,
      headers: { cookie },
    });
    expect(noCi.json().repositories[0].ciWorkflows).toEqual([]);

    // A hidden repository is reported as unreachable, with the credential named.
    const hidden = project("proj-hidden", "hiddenproj", "acme/hidden", "main", p.ownerId);
    container.projectRepo.upsert(hidden, { key: hidden.slug });
    const hiddenRes = await srv.inject({
      method: "GET",
      url: `/projects/${hidden.id}/repo-status`,
      headers: { cookie },
    });
    const hiddenRow = hiddenRes.json().repositories[0];
    expect(hiddenRow.readable).toBe(false);
    expect(hiddenRow.exists).toBe(false);
    expect(hiddenRow.hint).toContain("404");
    expect(hiddenRow.hint).toContain("ho3eines");
  }, 30000);

  it("GET /projects/:id/repo-status answers 404 for somebody else's project", async () => {
    const { srv, project: p } = await signedInProject({
      repo: "acme/app",
      repos: { "acme/app": { files: { "README.md": "# app" } } },
    });
    const stranger = container.userRepo.upsertGitHubUser({
      id: 43,
      login: "eve",
      name: "Eve",
      email: "e@example.com",
    }).user;
    const res = await srv.inject({
      method: "GET",
      url: `/projects/${p.id}/repo-status`,
      headers: { cookie: `cv_session=${signSession(stranger.id)}` },
    });
    expect(res.statusCode).toBe(404);
  }, 30000);
});

describe("project chat UI — repository banner", () => {
  async function bootListening() {
    container = new Container();
    await container.ensureSeed();
    app = (await buildServer(container)).app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo;
    return { srv: app, baseUrl: `http://127.0.0.1:${addr.port}` };
  }

  /** Boot the SPA in jsdom; `repoStatus` overrides GET /projects/:id/repo-status. */
  async function bootSpa(baseUrl: string, repoStatus?: unknown) {
    const pub = resolve(process.cwd(), "public");
    const dom = new JSDOM(readFileSync(resolve(pub, "index.html"), "utf8"), {
      url: `${baseUrl}/#/chat`,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    });
    const win = dom.window as unknown as Record<string, any>;
    const calls: string[] = [];
    win.fetch = (u: string, o?: RequestInit) => {
      const url = new URL(String(u), baseUrl);
      calls.push(url.pathname + url.search);
      if (repoStatus !== undefined && /\/projects\/[^/]+\/repo-status$/.test(url.pathname))
        return Promise.resolve(
          new Response(JSON.stringify(repoStatus), { status: 200, headers: { "content-type": "application/json" } }),
        );
      return fetch(url, o);
    };
    win.eval(readFileSync(resolve(pub, "app.js"), "utf8"));
    const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));
    await settle();
    const go = async (hash: string) => {
      win.location.hash = hash;
      win.dispatchEvent(new win.Event("hashchange"));
      await settle(1800);
      return win.document;
    };
    return { win, go, settle, calls };
  }

  async function bannerProject(baseUrl: string, srv: FastifyInstance, name: string) {
    const gh = container.github as unknown as {
      seedRepo(
        owner: string,
        repo: string,
        opts?: { files?: Array<{ path: string; content: string }>; branch?: string },
      ): unknown;
    };
    gh.seedRepo("acme", name, {
      files: [
        { path: "README.md", content: "# Banner project" },
        { path: "src/app.ts", content: "export const app = 1;" },
      ],
      branch: "main",
    });
    const p = await container.agentManager.createProject({
      name,
      description: "banner",
      configRepo: `acme/${name}`,
      branch: "main",
    });
    const conv = (
      await srv.inject({ method: "POST", url: "/conversations", payload: { projectId: p.id, title: "Chat" } })
    ).json();
    return { project: p, conversationId: conv.id as string };
  }

  it("shows the measured repository state on the project chat page", async () => {
    const { srv, baseUrl } = await bootListening();
    const { conversationId } = await bannerProject(baseUrl, srv, "banner-ok");
    const { go } = await bootSpa(baseUrl);
    const doc = await go(`#/conversations/${conversationId}`);
    const banner = doc.querySelector("#cv-repo");
    expect(banner, "banner container rendered").toBeTruthy();
    const text = (banner!.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toMatch(/Repository context: available/);
    expect(text).toContain("acme/banner-ok@main");
    expect(text).toContain("README ✓");
    // The mock repository has no GitHub Actions workflow — the banner must say
    // that QA cannot be test-verified instead of leaving it implicit.
    expect(text).toMatch(/CI ✗|No GitHub Actions workflow/);
    expect(doc.querySelector("#cv-repo-recheck")).toBeTruthy();
  }, 60000);

  it("shows the banner on the project Chat tab (the surface the report came from)", async () => {
    const { srv, baseUrl } = await bootListening();
    const { project: p } = await bannerProject(baseUrl, srv, "banner-tab");
    const { go } = await bootSpa(baseUrl);
    const doc = await go(`#/projects/${p.id}`);
    const banner = doc.querySelector("#cv-repo");
    expect(banner, "banner mounted above the project chat thread").toBeTruthy();
    expect(banner!.getAttribute("data-project-id")).toBe(p.id);
    const text = (banner!.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toMatch(/Repository context/);
    expect(text).toContain("acme/banner-tab@main");
  }, 60000);

  it("shows the real reason and the fix when the repository cannot be read, and re-checks on demand", async () => {
    const { srv, baseUrl } = await bootListening();
    const { conversationId } = await bannerProject(baseUrl, srv, "banner-bad");
    const status = {
      project: { id: "p", name: "banner-bad", configRepo: "acme/banner-bad", branch: "main" },
      connection: { kind: "real", source: "user-oauth", login: "ho3eines", scopes: ["public_repo"], tokenStored: true },
      repositories: [
        {
          repo: "acme/banner-bad",
          branch: "main",
          readable: false,
          exists: false,
          error: "GitHub 404 for acme/banner-bad@main",
          hint: "Open https://github.com/acme/banner-bad as that account, then sign out and in again.",
        },
      ],
      brief: {
        status: "unavailable",
        repo: "acme/banner-bad",
        branch: "main",
        files: 0,
        listed: 0,
        directories: [],
        reason: "GitHub answered 404 while reading acme/banner-bad@main.",
        hint: "Verify the repository name and branch, then re-connect GitHub.",
        errorKind: "not-found",
        source: "github",
        via: "api",
        elapsedMs: 120,
      },
      healthy: false,
      checkedAt: new Date().toISOString(),
    };
    const { win, go, calls } = await bootSpa(baseUrl, status);
    const doc = await go(`#/conversations/${conversationId}`);
    const banner = doc.querySelector("#cv-repo");
    const text = (banner!.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toMatch(/Repository context: not readable/);
    expect(text).toContain("GitHub answered 404 while reading acme/banner-bad@main.");
    expect(text).toContain("Verify the repository name and branch, then re-connect GitHub.");
    expect(text).toContain("ho3eines");
    expect(text).toContain("public_repo");
    expect(text).toMatch(/without\s+your code/);

    // Re-check must force a fresh read (?refresh=1), not serve the cache.
    const before = calls.filter((c) => c.includes("repo-status")).length;
    (doc.querySelector("#cv-repo-recheck") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 400));
    const after = calls.filter((c) => c.includes("repo-status"));
    expect(after.length).toBeGreaterThan(before);
    expect(after.at(-1)).toContain("refresh=1");
    expect(win.document.querySelector("#cv-repo")).toBeTruthy();
  }, 60000);
});
