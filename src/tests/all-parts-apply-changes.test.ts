import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { signSession } from "../auth/github-oauth.js";
import { storeUserGitHubToken } from "../auth/github-tokens.js";
import { setUserGitHubFetchForTest, resolveGitHubForProject } from "../github/registry.js";
import { clearWriteAccessCache } from "../github/write-access.js";
import type { Project } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";
import { createFakeGitHub, type FakeGitHub } from "./fake-github-rest.js";

/* ------------------------------------------------------------------ *
 * Audit: "every part can change the project, manage it, and test before
 * applying" — end to end against the REAL GitHub adapter (in-memory REST
 * double), with the site token live and able to push, so any accidental use
 * of it would silently succeed and is caught by the call log.
 *
 *   manage  → project settings, agents, skills, workflows, memory, issues
 *   change  → feature branch + commit + pull request
 *   test    → CI gate on the PR head before merge (failed / pending / passed)
 *   access  → task dispatch preflights write access (scope, push permission)
 *   identity→ every request uses the user's token; background work too
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
let gh: FakeGitHub;

const SITE = "ghs_site_token";

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_SECRET = "test-auth-secret-for-all-parts-audit-0123456789";
  process.env.GITHUB_CLIENT_ID = "Iv1.auditclient";
  process.env.GITHUB_CLIENT_SECRET = "audit-secret";
  process.env.GITHUB_TOKEN = SITE;
  process.env.GITHUB_ENABLED = "true";
  getEnvFresh();
  cleanup = freshDb().cleanup;
  clearWriteAccessCache();
  gh = createFakeGitHub({
    accounts: {
      // The site token CAN push to alice/app: using it would "work", so the
      // call log is the only thing that proves it is never used.
      [SITE]: { login: "site-bot", scopes: ["repo"], push: ["alice/app"] },
      "tok-alice": { login: "alice", scopes: ["repo", "read:user"], push: ["alice/app"] },
      "tok-bob-ro": { login: "bob", scopes: ["public_repo", "read:user"], push: ["bob/priv"] },
      "tok-carol": { login: "carol", scopes: ["repo"], push: [] },
    },
    repos: [
      { fullName: "alice/app", files: { "README.md": "# app\n", "package.json": '{"name":"app"}' } },
      { fullName: "bob/priv" },
    ],
  });
  setUserGitHubFetchForTest(gh.fetch);
  vi.stubGlobal("fetch", gh.fetch);
});

afterEach(async () => {
  setUserGitHubFetchForTest(undefined);
  vi.unstubAllGlobals();
  container?.githubAutomation?.stop?.();
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

async function boot(): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
  return app;
}

function signIn(id: number, login: string, token: string, scopes: string) {
  const user = container.userRepo.upsertGitHubUser({ id, login, name: login, email: `${login}@example.com` }).user;
  storeUserGitHubToken(container.kv, user.id, token, { scopes, login });
  return { user, cookie: `cv_session=${signSession(user.id)}` };
}

/**
 * Real GitHub requires a real AI model to author missing CodeVia state. Author
 * it once in simulation (mock GitHub, pre-login demo owner), copy the files
 * into the fake repository, then hand the project to `ownerId` — exactly what
 * adoption does when a demo project's owner logs in.
 */
async function projectWithState(opts: {
  name: string;
  repo: string;
  ownerId: string;
  login: string;
}): Promise<Project> {
  const sim = await container.agentManager.createProject({
    name: opts.name,
    description: "audit",
    configRepo: opts.repo,
    ownerId: "user-demo",
    githubConnection: { kind: "mock" },
  } as Parameters<Container["agentManager"]["createProject"]>[0]);
  const mock = resolveGitHubForProject({ project: sim, kv: container.kv, fallback: container.github });
  const [owner, name] = opts.repo.split("/");
  const files: Record<string, string> = {};
  for (const e of await mock.listFiles({ owner, name }, "main")) {
    if (e.type !== "blob") continue;
    const f = await mock.getFile({ owner, name }, e.path, "main");
    if (f) files[e.path] = f.content;
  }
  gh.seed(opts.repo, files);
  const next: Project = {
    ...container.projectRepo.findById(sim.id)!.data,
    ownerId: opts.ownerId,
    githubConnection: { kind: "user-oauth", userId: opts.ownerId, login: opts.login },
  };
  container.projectRepo.update(next);
  return next;
}

describe("every part manages, changes and tests the project as the user", () => {
  it("full lifecycle uses only the user's token, and merges only tested changes", async () => {
    const srv = await boot();
    const alice = signIn(1, "alice", "tok-alice", "repo,read:user");
    const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
      srv.inject({
        method,
        url,
        headers: { cookie: alice.cookie },
        ...(payload ? { payload: payload as object } : {}),
      });

    // Real GitHub needs a real model to author CodeVia/ state, so the state is
    // seeded; from here on every action runs through the HTTP API as Alice.
    const project = await projectWithState({ name: "App", repo: "alice/app", ownerId: alice.user.id, login: "alice" });
    const projectId = project.id;
    const writesBefore = gh.writes().length;

    // --- manage: settings, agents, skills, workflows, memory, issues ---
    const patched = await req("PATCH", `/projects/${projectId}`, { description: "audited" });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(gh.writes().length, "settings change was committed to the repository").toBeGreaterThan(writesBefore);
    const agent = container.agentRepo.byProject(projectId)[0];
    expect(agent, "onboarding created agents").toBeTruthy();
    const agentPatch = await req("PATCH", `/agents/${agent.id}`, { description: "audited agent" });
    expect(agentPatch.statusCode, agentPatch.body).toBe(200);
    const skill = await req("POST", "/skills", {
      projectId,
      slug: "audit-skill",
      name: "Audit skill",
      instructions: "Check everything.",
    });
    expect(skill.statusCode, skill.body).toBe(200);
    const workflow = await req("POST", "/workflows", { projectId, name: "Audit flow", slug: "audit-flow" });
    expect(workflow.statusCode, workflow.body).toBe(200);
    const memory = await req("POST", "/memory", { projectId, key: "audit", content: "remember this" });
    expect(memory.statusCode, memory.body).toBe(200);
    const issue = await req("POST", `/projects/${projectId}/issues`, { title: "Audit issue" });
    expect(issue.statusCode, issue.body).toBe(201);

    // Each management action (settings, agent, skill, workflow, memory) was
    // committed to the repository by Alice.
    const commitsToMain = gh.writes().filter((c) => c.method === "PATCH" && c.path.endsWith("/git/refs/heads/main"));
    expect(commitsToMain.length).toBeGreaterThanOrEqual(5);
    expect(gh.fileAt("alice/app", "main", "CodeVia/skills/audit-skill.md")).toContain("Audit skill");

    // --- change: feature branch + commit + pull request ---
    const mainHead = gh.headOf("alice/app", "main")!;
    const branch = await req("POST", "/github/repositories/alice/app/branches", {
      name: "feat/audit",
      baseSha: mainHead,
    });
    expect(branch.statusCode, branch.body).toBe(200);
    const asAlice = resolveGitHubForProject({
      project: container.projectRepo.findById(projectId)!.data,
      kv: container.kv,
      fallback: container.github,
      requestUserId: alice.user.id,
    });
    await asAlice.commit({ owner: "alice", name: "app" }, "feat/audit", "feat: audited change", [
      { path: "src/feature.ts", content: "export const audited = true;\n" },
    ]);
    const pr = await req("POST", `/projects/${projectId}/pull-requests`, {
      title: "Audited change",
      head: "feat/audit",
      base: "main",
    });
    expect(pr.statusCode, pr.body).toBe(201);
    const number = pr.json().number as number;
    const head = gh.headOf("alice/app", "feat/audit")!;

    // --- test before applying: failing CI blocks the merge ---
    gh.setChecks(head, "failure");
    const failedChecks = await req("GET", `/projects/${projectId}/pull-requests/${number}/checks`);
    expect(failedChecks.json()).toMatchObject({ ok: false, verification: "failed", headSha: head });
    const blockedFail = await req("POST", `/projects/${projectId}/pull-requests/${number}/merge`, {});
    expect(blockedFail.statusCode).toBe(409);
    expect(gh.fileAt("alice/app", "main", "src/feature.ts")).toBeUndefined();

    // --- pending CI also blocks ---
    gh.setChecks(head, "pending");
    const blockedPending = await req("POST", `/projects/${projectId}/pull-requests/${number}/merge`, {});
    expect(blockedPending.statusCode).toBe(409);
    expect(blockedPending.json().gate.verification).toBe("pending");

    // --- no CI at all blocks (untested) ---
    gh.setChecks(head, "none");
    const blockedNone = await req("POST", `/projects/${projectId}/pull-requests/${number}/merge`, {});
    expect(blockedNone.statusCode).toBe(409);
    expect(blockedNone.json().gate.verification).toBe("no-ci");

    // --- a stale review (head moved) is refused ---
    gh.setChecks(head, "success");
    const stale = await req("POST", `/projects/${projectId}/pull-requests/${number}/merge`, {
      expectedSha: mainHead,
    });
    expect(stale.statusCode).toBe(409);

    // --- green CI: merged, pinned to the verified head ---
    const merged = await req("POST", `/projects/${projectId}/pull-requests/${number}/merge`, { expectedSha: head });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(gh.fileAt("alice/app", "main", "src/feature.ts")).toContain("audited");
    const mergeCall = gh.calls.find((c) => c.method === "PUT" && c.path.includes(`/pulls/${number}/merge`));
    expect(mergeCall?.token).toBe("tok-alice");

    // --- task dispatch preflight passes for a user who can write ---
    const ask = await req("POST", `/projects/${projectId}/ask`, {
      description: "Add a health endpoint",
      executionMode: "autonomous",
    });
    expect(ask.statusCode, ask.body).toBe(200);
    expect(ask.json().task).toBeTruthy();

    // --- background work (no request user) acts as the project owner ---
    const background = resolveGitHubForProject({
      project: container.projectRepo.findById(projectId)!.data,
      kv: container.kv,
      fallback: container.github,
    });
    expect((await background.getViewer()).login).toBe("alice");

    // --- identity: the site token was never used, every write is Alice's ---
    expect(gh.calls.filter((c) => c.token === SITE)).toEqual([]);
    const writers = new Set(gh.writes().map((c) => c.token));
    expect([...writers]).toEqual(["tok-alice"]);
  });

  it("asks a read-only user for write access before queueing work (and before the site token could be used)", async () => {
    const srv = await boot();
    const bob = signIn(2, "bob", "tok-bob-ro", "public_repo,read:user");
    const bobProject = await projectWithState({ name: "Bob", repo: "bob/priv", ownerId: bob.user.id, login: "bob" });

    const ask = await srv.inject({
      method: "POST",
      url: `/projects/${bobProject.id}/ask`,
      headers: { cookie: bob.cookie },
      payload: { description: "Change something", executionMode: "autonomous" },
    });
    expect(ask.statusCode).toBe(403);
    expect(ask.json().code).toBe("github_authorization_required");
    expect(ask.json().githubAuthorization).toMatchObject({ reason: "missing-scope", requiredScopes: ["repo"] });
    expect(container.taskRepo.findMany({}).filter((t) => t.data.projectId === bobProject.id)).toEqual([]);

    // Plain read-only questions (simulation) are not blocked.
    const sim = await srv.inject({
      method: "POST",
      url: `/projects/${bobProject.id}/ask`,
      headers: { cookie: bob.cookie },
      payload: { description: "What would you change?", executionMode: "simulation" },
    });
    expect(sim.statusCode, sim.body).toBe(200);
    expect(gh.calls.filter((c) => c.token === SITE)).toEqual([]);
  });

  it("reports a missing push permission per repository instead of failing at commit time", async () => {
    const srv = await boot();
    const carol = signIn(3, "carol", "tok-carol", "repo");
    const carolProject = await projectWithState({
      name: "Carol",
      repo: "alice/app",
      ownerId: carol.user.id,
      login: "carol",
    });
    const ask = await srv.inject({
      method: "POST",
      url: `/projects/${carolProject.id}/ask`,
      headers: { cookie: carol.cookie },
      payload: { description: "Change something", executionMode: "autonomous" },
    });
    expect(ask.statusCode).toBe(403);
    expect(ask.json().error).toMatch(/carol cannot push to alice\/app/);
    expect(ask.json().writeAccess.repos[0]).toMatchObject({ repo: "alice/app", readable: true, canPush: false });
  });

  it("a signed-in user without any GitHub token is asked to authorize — never served by the site token", async () => {
    const srv = await boot();
    const dave = container.userRepo.upsertGitHubUser({
      id: 4,
      login: "dave",
      name: "dave",
      email: "d@example.com",
    }).user;
    const res = await srv.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie: `cv_session=${signSession(dave.id)}` },
      payload: { name: "NoToken", configRepo: "alice/app" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().githubAuthorization.reason).toBe("no-token");
    expect(gh.calls.filter((c) => c.token === SITE)).toEqual([]);
  });

  it("background work on a real owner's project never falls back to the site token", async () => {
    await boot();
    const erin = container.userRepo.upsertGitHubUser({
      id: 5,
      login: "erin",
      name: "erin",
      email: "e@example.com",
    }).user;
    const project = {
      id: "p-bg",
      name: "Bg",
      ownerId: erin.id,
      configRepo: "alice/app",
      githubConnection: { kind: "server-token" },
    } as unknown as Project;
    expect(() => resolveGitHubForProject({ project, kv: container.kv, fallback: container.github })).toThrow(
      /owner must authorize GitHub/,
    );
  });
});
