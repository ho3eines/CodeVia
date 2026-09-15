import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";
import { getEnvFresh } from "../config/env.js";
import { RealGitHubService } from "../github/real-service.js";
import { RepoMirrorService, setRepoMirrorForTest } from "../github/repo-mirror.js";
import { invalidateRepoBrief, readRepoBrief } from "../agents/repo-brief.js";
import { resolveGitHubTokenForProject, setUserGitHubFetchForTest } from "../github/registry.js";
import { storeUserGitHubToken } from "../auth/github-tokens.js";
import { toolRegistry } from "../tools/registry.js";
import { logger } from "../logger.js";
import type { Agent, Project } from "../domain/entities.js";

/* ------------------------------------------------------------------ *
 * The mirror is only worth having if the platform actually *uses* it.
 *
 * These tests pin the wiring end to end against a real `git` fixture and a
 * recording GitHub fake:
 *   - the repository brief reads from disk and spends **zero** API requests,
 *   - a mirror that cannot be built degrades to the API (never to silence),
 *   - the `search` tool gains real content grep (`git grep`) and says which
 *     transport produced its evidence,
 *   - `GET /projects/:id/repo-status` reports the mirror honestly, including
 *     when the feature is off, and the refresh/delete routes behave,
 *   - the credential handed to a clone is the *acting* account's own token.
 * ------------------------------------------------------------------ */

const ENV_KEYS = ["REQUIRE_AUTH", "GITHUB_TOKEN", "GITHUB_ENABLED", "AUTH_SECRET", "REPO_MIRROR_ENABLED"] as const;
let savedEnv: Record<string, string | undefined> = {};
let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container | undefined;

let tmp = "";
let fixture = "";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "codevia-mirror-wiring-"));
  fixture = join(tmp, "fixture");
  mkdirSync(fixture, { recursive: true });
  git(["init", "-b", "main"], fixture);
  git(["config", "user.email", "fixture@codevia.test"], fixture);
  git(["config", "user.name", "Fixture"], fixture);
  writeFileSync(join(fixture, "README.md"), "# Tarazin\nFive-layer gold jewellery ERP.\n");
  writeFileSync(join(fixture, "package.json"), '{ "name": "fixture", "version": "1.0.0" }\n');
  mkdirSync(join(fixture, "src/Data"), { recursive: true });
  writeFileSync(join(fixture, "src/program.ts"), "export const secretSauce = 42;\n");
  writeFileSync(join(fixture, "src/Data/DbContext.cs"), "public class DbContext { }\n");
  git(["add", "-A"], fixture);
  git(["commit", "-q", "-m", "fixture: initial"], fixture);
  git(["branch", "release-9"], fixture);
}, 60000);

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_SECRET = "test-auth-secret-for-repo-mirror-wiring-0123456789";
  getEnvFresh();
  cleanup = freshDb().cleanup;
  invalidateRepoBrief();
});

afterEach(async () => {
  setRepoMirrorForTest(undefined);
  setUserGitHubFetchForTest(undefined);
  invalidateRepoBrief();
  if (app) {
    await app.close();
    app = undefined;
  }
  container = undefined;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  getEnvFresh();
  cleanup?.();
});

/** A mirror over the local git fixture — no network is ever involved. */
function makeMirror(name: string, urlTemplate?: string): RepoMirrorService {
  return new RepoMirrorService({
    root: join(tmp, name),
    enabled: true,
    urlTemplate: urlTemplate ?? `file://${fixture}`,
    refreshMs: 300_000,
    timeoutMs: 30_000,
    readTimeoutMs: 15_000,
  });
}

const FILES: Record<string, string> = {
  "README.md": "# Tarazin\nFive-layer gold jewellery ERP.",
  "package.json": '{ "name": "fixture", "version": "1.0.0" }',
  "src/program.ts": "export const secretSauce = 42;",
};

/**
 * GitHub fake that records every URL it is asked for. `hidden` answers 404 for
 * everything, so a brief that still succeeds can only have come from disk.
 */
function recordingGitHub(opts: { hidden?: boolean; branch?: string } = {}) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/user")) return json({ login: "tester", name: "tester" });
    if (opts.hidden) return json({ message: "Not Found" }, 404);
    const path = url.split("?")[0];
    if (path.includes("/git/trees/")) {
      const ref = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
      if (ref !== (opts.branch ?? "main")) return json({ message: "Not Found" }, 404);
      return json({
        sha: "tree-sha",
        truncated: false,
        tree: Object.entries(FILES).map(([p, content]) => ({ path: p, type: "blob", size: content.length })),
      });
    }
    if (path.includes("/contents/")) {
      const p = decodeURIComponent(path.slice(path.indexOf("/contents/") + 10));
      const content = FILES[p];
      return content ? json({ type: "file", path: p, name: p, content, encoding: "utf8" }) : json({}, 404);
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(path)) return json({ full_name: "acme/widget", default_branch: "main" });
    if (path.includes("/branches")) return json([{ name: opts.branch ?? "main", commit: { sha: "abc123" } }]);
    return json({ message: "Not Found" }, 404);
  }) as unknown as typeof fetch;
  return { github: new RealGitHubService({ token: "test-only", fetchImpl }), calls };
}

function project(repo = "acme/widget", branch = "main", ownerId = "user-local"): Project {
  const now = new Date().toISOString();
  return {
    id: "p-mirror",
    slug: "mirror",
    name: "mirror",
    description: "Tarazin ERP",
    configRepo: repo,
    branch,
    ownerId,
    githubConnection: { kind: "user-oauth", userId: ownerId, login: "tester" },
    repositories: [{ repo, branch, role: "primary", isConfigRepo: true, addedAt: now }],
    settings: {},
    active: true,
    createdAt: now,
    updatedAt: now,
  } as unknown as Project;
}

function agent(): Agent {
  return { id: "a1", type: "backend", name: "Backend", permissions: { tools: ["search"] } } as unknown as Agent;
}

describe("repository mirror wiring — the platform really reads from disk", () => {
  it("reads the repository brief from the mirror with ZERO GitHub API requests", async () => {
    const { github, calls } = recordingGitHub({ hidden: true }); // every API answer is a 404
    const brief = await readRepoBrief({
      github,
      project: project(),
      cacheScope: "user-1",
      ttlMs: 0,
      mirror: makeMirror("brief-mirror"),
    });

    expect(brief.status).toBe("ok");
    expect(brief.via).toBe("mirror");
    expect(brief.files).toBeGreaterThanOrEqual(4);
    expect(brief.text).toContain("README.md");
    expect(brief.text).toContain("local read-only mirror");
    expect(brief.mirror?.ready).toBe(true);
    expect(brief.mirror?.headSha).toMatch(/^[0-9a-f]{7,40}$/);
    // The whole point: evidence came from a local clone, not from api.github.com.
    expect(calls).toEqual([]);
  }, 60000);

  it("reads the mirror for the branch the project asks about, not just HEAD", async () => {
    const { github, calls } = recordingGitHub({ hidden: true });
    const mirror = makeMirror("brief-branch");
    const main = await readRepoBrief({
      github,
      project: project("acme/widget", "main"),
      cacheScope: "u",
      ttlMs: 0,
      mirror,
    });
    const other = await readRepoBrief({
      github,
      project: project("acme/widget", "release-9"),
      cacheScope: "u",
      ttlMs: 0,
      mirror,
    });
    expect(main.status).toBe("ok");
    expect(other.status).toBe("ok");
    expect(other.branch).toBe("release-9");
    expect(other.via).toBe("mirror");
    expect(calls).toEqual([]);
  }, 60000);

  it("falls back to the GitHub API when the mirror cannot be built — and says so", async () => {
    const { github, calls } = recordingGitHub({});
    const broken = makeMirror("brief-broken", `file://${join(tmp, "does-not-exist")}`);
    const brief = await readRepoBrief({
      github,
      project: project(),
      cacheScope: "user-2",
      ttlMs: 0,
      mirror: broken,
    });

    expect(brief.status).toBe("ok");
    expect(brief.via).toBe("api");
    expect(calls.length).toBeGreaterThan(0);
    expect(brief.mirror?.ready).toBe(false);
    expect(brief.mirror?.blocker).toBe("clone-failed");
    // A broken mirror is never reported to the model as an unreadable repository.
    expect(brief.text).toContain("README.md");
  }, 60000);

  it("ignores the mirror entirely when the feature is disabled", async () => {
    const { github } = recordingGitHub({});
    const disabled = new RepoMirrorService({ root: join(tmp, "off"), enabled: false });
    const brief = await readRepoBrief({ github, project: project(), cacheScope: "user-3", ttlMs: 0, mirror: disabled });
    expect(brief.via).toBe("api");
    expect(brief.mirror).toBeUndefined();
    expect(brief.status).toBe("ok");
  }, 60000);

  it("gives the search tool real content grep and reports the transport", async () => {
    const tool = toolRegistry.get("search");
    expect(tool, "search tool registered").toBeTruthy();
    const { github, calls } = recordingGitHub({ hidden: true });
    const res = await tool!.execute(
      {
        project: project(),
        agent: agent(),
        github,
        logger,
        correlationId: "mirror-search",
        mirror: makeMirror("tool-mirror"),
        mirrorScope: "user-4",
      },
      { query: "secretSauce", limit: 5 },
    );

    expect(res.ok).toBe(true);
    expect(res.output).toContain("[match] src/program.ts:1");
    expect(res.data?.matchesVia).toBe("mirror");
    expect(res.data?.filesVia).toBe("mirror");
    expect(calls).toEqual([]); // no GitHub request: listing and grep both came from disk
  }, 60000);

  it("keeps the search tool working on the API when there is no mirror", async () => {
    const tool = toolRegistry.get("search")!;
    const { github, calls } = recordingGitHub({});
    const res = await tool.execute(
      { project: project(), agent: agent(), github, logger, correlationId: "api-search" },
      { query: "program", limit: 5 },
    );
    expect(res.ok).toBe(true);
    expect(res.data?.filesVia).toBe("api");
    expect(res.data?.matches).toBeUndefined();
    expect(res.output).toContain("[file] src/program.ts");
    expect(calls.length).toBeGreaterThan(0);
  }, 60000);
});

describe("repository mirror wiring — HTTP surface", () => {
  async function boot() {
    container = new Container();
    await container.ensureSeed();
    app = (await buildServer(container)).app;
    const p = await container.agentManager.createProject({
      name: "mirror-http",
      description: "mirror wiring",
      configRepo: "acme/widget",
      branch: "main",
    });
    return { container, app, project: p };
  }

  it("reports the mirror state in repo-status — including when the feature is off", async () => {
    const { app: srv, project: p } = await boot();
    const res = await srv.inject({ method: "GET", url: `/projects/${p.id}/repo-status` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mirror: Record<string, unknown>; brief?: { via?: string } };
    expect(body.mirror, "mirror block present").toBeTruthy();
    expect(body.mirror.enabled).toBe(false); // off by default under test: a clone is a real operation
    expect(body.mirror.blocker).toBe("disabled");
    expect(body.mirror.root).toBeTruthy();
    expect(String(body.mirror.note)).toMatch(/never executed/i);
    expect(body.brief?.via).toBe("api");
  }, 60000);

  it("refuses a refresh honestly when the mirror is disabled (409, not 500)", async () => {
    const { app: srv, project: p } = await boot();
    const res = await srv.inject({ method: "POST", url: `/projects/${p.id}/repo-mirror/refresh` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("disabled") });
  }, 60000);

  it("refreshes, reports ready, and deletes the local copy on demand", async () => {
    const { app: srv, project: p } = await boot();
    setRepoMirrorForTest(makeMirror("http-mirror"));

    const refreshed = await srv.inject({ method: "POST", url: `/projects/${p.id}/repo-mirror/refresh` });
    expect(refreshed.statusCode).toBe(200);
    const state = refreshed.json() as { ready: boolean; headSha?: string; sizeMb?: number };
    expect(state.ready).toBe(true);
    expect(state.headSha).toMatch(/^[0-9a-f]{7,40}$/);

    const status = await srv.inject({ method: "GET", url: `/projects/${p.id}/repo-status` });
    const body = status.json() as { mirror: { enabled: boolean; ready: boolean; exists: boolean } };
    expect(body.mirror).toMatchObject({ enabled: true, ready: true, exists: true });

    // The delete must really remove the local copy from disk…
    const mirrorDirs = () =>
      readdirSync(join(tmp, "http-mirror"), { recursive: true, withFileTypes: true }).filter((d) =>
        d.name.endsWith(".git"),
      ).length;
    expect(mirrorDirs()).toBe(1);

    const removed = await srv.inject({ method: "DELETE", url: `/projects/${p.id}/repo-mirror` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ removed: true });
    expect(mirrorDirs(), "local mirror deleted from disk").toBe(0);

    // …and the next read recreates it (the mirror is an optimisation, so a
    // deleted copy must never leave the project without repository evidence).
    const recreated = await srv.inject({ method: "GET", url: `/projects/${p.id}/repo-status?refresh=1` });
    expect((recreated.json() as { mirror: { ready: boolean } }).mirror.ready).toBe(true);
  }, 90000);
});

describe("repository mirror credential — the acting account's own token only", () => {
  it("resolves the acting user's token, then the project connection, then nothing", async () => {
    container = new Container();
    await container.ensureSeed();
    const kv = container.kv;
    storeUserGitHubToken(kv, "user-a", "tok-a", { scopes: ["repo"], login: "a" });
    storeUserGitHubToken(kv, "user-b", "tok-b", { scopes: ["repo"], login: "b" });

    const owned = project("acme/widget", "main", "user-b");
    // A signed-in user always acts as themselves, whoever owns the project.
    expect(resolveGitHubTokenForProject({ kv, project: owned, requestUserId: "user-a" })).toBe("tok-a");
    // No token of their own → the connection stored on the project (its owner).
    expect(resolveGitHubTokenForProject({ kv, project: owned, requestUserId: "user-z" })).toBe("tok-b");
    // No personal token anywhere and no server GitHub → an anonymous clone.
    const anonymous = { ...owned, githubConnection: undefined, ownerId: undefined } as unknown as Project;
    expect(resolveGitHubTokenForProject({ kv, project: anonymous, requestUserId: "user-z" })).toBeUndefined();
  }, 60000);
});
