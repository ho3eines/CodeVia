import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";
import { signSession } from "../auth/github-oauth.js";
import { storeUserGitHubToken } from "../auth/github-tokens.js";
import { createFakeGitHub } from "./fake-github-rest.js";
import { setUserGitHubFetchForTest } from "../github/registry.js";
import { clearWriteAccessCache } from "../github/write-access.js";
import {
  CI_SETUP_BRANCH,
  CI_WORKFLOW_PATH,
  detectStacks,
  renderCiWorkflow,
  requiredChecksForStacks,
  requiredChecksPatch,
  templateOptionsFromPaths,
  type CiStack,
} from "../github/ci-template.js";

/* ------------------------------------------------------------------ *
 * Step 2 — self-serve CI for target repositories (OP-02 / OP-03):
 * stack detection, per-stack workflow templates, the Draft-PR proposal
 * path, and the automatic requiredChecks fill after the PR is merged.
 * ------------------------------------------------------------------ */

describe("stack detection", () => {
  it("detects every supported stack from the file list", () => {
    expect(detectStacks(["package.json"])).toEqual(["node"]);
    expect(detectStacks(["src/App.csproj"])).toEqual(["dotnet"]);
    expect(detectStacks(["src/App.sln"])).toEqual(["dotnet"]);
    expect(detectStacks(["pyproject.toml"])).toEqual(["python"]);
    expect(detectStacks(["requirements.txt"])).toEqual(["python"]);
    expect(detectStacks(["go.mod"])).toEqual(["go"]);
    expect(detectStacks(["pom.xml"])).toEqual(["maven"]);
  });

  it("returns every present stack in canonical order and [] for unknown repos", () => {
    expect(detectStacks(["pom.xml", "package.json", "src/Web.csproj", "go.mod"])).toEqual([
      "node",
      "dotnet",
      "go",
      "maven",
    ]);
    expect(detectStacks(["README.md", "src/main.c"])).toEqual([]);
  });

  it("derives template options (locks, test presence) from the same file list", () => {
    expect(templateOptionsFromPaths(["package.json", "package-lock.json"]).nodeLock).toBe("npm");
    expect(templateOptionsFromPaths(["package.json", "pnpm-lock.yaml"]).nodeLock).toBe("pnpm");
    expect(templateOptionsFromPaths(["package.json", "yarn.lock"]).nodeLock).toBe("yarn");
    expect(templateOptionsFromPaths(["package.json"]).nodeLock).toBeUndefined();
    expect(templateOptionsFromPaths(["src/App.csproj", "src/App.Tests.csproj"]).dotnetHasTests).toBe(true);
    expect(templateOptionsFromPaths(["src/App.csproj"]).dotnetHasTests).toBe(false);
    expect(templateOptionsFromPaths(["tests/test_a.py"]).pythonHasTests).toBe(true);
    expect(templateOptionsFromPaths(["src/test/java/A.java"]).mavenHasTests).toBe(true);
  });
});

describe("workflow templates", () => {
  it("renders triggers for agent branches and pull requests including drafts", () => {
    const yaml = renderCiWorkflow(["node"]);
    expect(yaml).toContain("name: CodeVia CI");
    expect(yaml).toContain('      - "agent-task-*"');
    expect(yaml).toContain("types: [opened, synchronize, reopened, ready_for_review]");
    expect(yaml).toContain("pull_request:");
    expect(yaml).toContain("INCLUDING draft PRs");
    expect(yaml).toContain("workflow_dispatch:");
  });

  it("renders one job per detected stack and the check names match the job names", () => {
    const stacks: CiStack[] = ["node", "dotnet", "python", "go", "maven"];
    const yaml = renderCiWorkflow(stacks, templateOptionsFromPaths(["tests/test_a.py", "src/test/java/T.java"]));
    for (const job of requiredChecksForStacks(stacks)) expect(yaml).toContain(`    name: ${job}`);
    expect(yaml).toContain("npm ci || npm install");
    expect(yaml).toContain("dotnet build --no-restore");
    expect(yaml).toContain("python -m pytest -q");
    expect(yaml).toContain("go test ./...");
    expect(yaml).toContain("mvn -B -q test");
  });

  it("adapts to lockfiles and missing test suites", () => {
    const yarn = renderCiWorkflow(["node"], { nodeLock: "yarn" });
    expect(yarn).toContain("yarn install --frozen-lockfile");
    expect(yarn).not.toContain("npm ci");
    const dotnetNoTests = renderCiWorkflow(["dotnet"], { dotnetHasTests: false });
    expect(dotnetNoTests).toContain("no test project detected — build only");
    expect(dotnetNoTests).not.toContain("dotnet test");
    const pythonNoTests = renderCiWorkflow(["python"], { pythonHasTests: false });
    expect(pythonNoTests).toContain("python -m compileall -q .");
    expect(pythonNoTests).not.toContain("pytest -q");
    expect(() => renderCiWorkflow([])).toThrow(/without a detected stack/);
  });
});

describe("requiredChecks recording", () => {
  const meta = (extra: Record<string, unknown> = {}) => ({ metadata: extra });
  it("fills the project's required checks with the template's job names", () => {
    expect(requiredChecksPatch(undefined, "a/b", ["node"], false)).toEqual({
      requiredChecks: ["codevia-node"],
    });
    expect(requiredChecksPatch(meta(), "a/b", ["node", "dotnet"], false)).toEqual({
      requiredChecks: ["codevia-node", "codevia-dotnet"],
    });
  });

  it("never overwrites an explicit configuration and scopes multi-repo per repository", () => {
    expect(requiredChecksPatch(meta({ requiredChecks: ["custom"] }), "a/b", ["node"], false)).toBeUndefined();
    expect(requiredChecksPatch(meta({ requiredChecks: [] }), "a/b", ["node"], false)).toEqual({
      requiredChecks: ["codevia-node"],
    });
    const multi = requiredChecksPatch(
      meta({ requiredChecksByRepo: { "a/other": ["keep-me"] } }),
      "a/b",
      ["dotnet"],
      true,
    );
    expect(multi).toEqual({ requiredChecksByRepo: { "a/other": ["keep-me"], "a/b": ["codevia-dotnet"] } });
    // already recorded for this repo → no-op
    expect(
      requiredChecksPatch(meta({ requiredChecksByRepo: { "a/b": ["codevia-dotnet"] } }), "a/b", ["dotnet"], true),
    ).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* HTTP: propose → Draft PR → merge → automatic requiredChecks fill    */
/* ------------------------------------------------------------------ */

let cleanup: (() => void) | undefined;
let app: FastifyInstance;
let container: Container;
let cookie: string;
let projectId: string;
let seq = 0;
let repoName: string;
const repoRef = () => {
  const [owner, name] = repoName.split("/");
  return { owner, name };
};

beforeAll(async () => {
  delete process.env.REQUIRE_AUTH;
  process.env.AUTH_SECRET = "ci-setup-test-secret-0123456789abcdef";
  getEnvFresh();
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  cleanup?.();
});

beforeEach(async () => {
  const user = container.userRepo.upsertGitHubUser({
    id: 91,
    login: "ci-owner",
    name: "ci-owner",
    email: "ci-owner@example.com",
  }).user;
  cookie = `cv_session=${signSession(user.id)}`;
  repoName = `acme/needs-ci-${++seq}`;
  const p = await container.agentManager.createProject({
    name: `CI setup ${seq}`,
    description: "needs CI",
    configRepo: repoName,
    ownerId: user.id,
  });
  projectId = p.id;
  const gh = container.github as unknown as {
    seedRepo(owner: string, name: string, opts?: { files?: Array<{ path: string; content: string }> }): unknown;
  };
  gh.seedRepo("acme", repoName.slice("acme/".length), {
    files: [
      { path: "README.md", content: "# needs-ci\n" },
      { path: "package.json", content: '{"name":"needs-ci","scripts":{"test":"vitest run"}}' },
      { path: "src/index.js", content: "export const x = 1;\n" },
    ],
  });
});

afterEach(() => {
  container.githubAutomation.stop();
});

const req = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload ? { payload: payload as object } : {}),
  });

describe("POST /projects/:id/ci-setup", () => {
  it("proposes a CI workflow as a Draft PR on a dedicated branch (never main)", async () => {
    const res = await req("POST", `/projects/${projectId}/ci-setup`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { results: Array<Record<string, unknown>>; branch: string };
    expect(body.branch).toBe(CI_SETUP_BRANCH);
    expect(body.results).toHaveLength(1);
    const outcome = body.results[0];
    expect(outcome.status).toBe("created");
    expect(outcome.stacks).toEqual(["node"]);
    expect(outcome.jobNames).toEqual(["codevia-node"]);
    expect(outcome.prNumber).toBe(1);

    const gh = container.github as unknown as {
      listBranches(ref: { owner: string; name: string }): Promise<Array<{ name: string }>>;
      getFile(
        ref: { owner: string; name: string },
        path: string,
        branch?: string,
      ): Promise<{ content: string } | undefined>;
      listPullRequests(ref: {
        owner: string;
        name: string;
      }): Promise<Array<{ number: number; draft?: boolean; state: string; head: string; base: string }>>;
    };
    const ref = repoRef();
    // branch exists with the workflow committed — and the base branch untouched
    expect((await gh.listBranches(ref)).map((b) => b.name)).toContain(CI_SETUP_BRANCH);
    const wf = await gh.getFile(ref, CI_WORKFLOW_PATH, CI_SETUP_BRANCH);
    expect(wf?.content).toContain("name: CodeVia CI");
    expect(wf?.content).toContain("name: codevia-node");
    expect(await gh.getFile(ref, CI_WORKFLOW_PATH, "main")).toBeUndefined();
    // exactly one PR, opened as a Draft for human review/approval
    const prs = await gh.listPullRequests(ref);
    expect(prs).toHaveLength(1);
    expect(prs[0].draft).toBe(true);
    expect(prs[0].state).toBe("open");
    expect(prs[0].head).toBe(CI_SETUP_BRANCH);
    expect(prs[0].base).toBe("main");
  });

  it("is idempotent: a second call reports the existing Draft PR without duplicating it", async () => {
    const first = await req("POST", `/projects/${projectId}/ci-setup`);
    expect(first.statusCode).toBe(200);
    const second = await req("POST", `/projects/${projectId}/ci-setup`);
    expect(second.statusCode).toBe(200);
    const outcome = (second.json() as { results: Array<Record<string, unknown>> }).results[0];
    expect(outcome.status).toBe("pr-exists");
    expect(outcome.prNumber).toBe(1);
    const gh = container.github as unknown as {
      listPullRequests(ref: { owner: string; name: string }): Promise<unknown[]>;
    };
    expect(await gh.listPullRequests(repoRef())).toHaveLength(1);
  });

  it("reports already-has-ci when any workflow exists (no branch is created)", async () => {
    const gh = container.github as unknown as {
      seedRepo(owner: string, name: string, opts?: { files?: Array<{ path: string; content: string }> }): unknown;
    };
    gh.seedRepo("acme", repoName.slice("acme/".length), {
      files: [{ path: ".github/workflows/other.yml", content: "name: other\n" }],
    });
    const res = await req("POST", `/projects/${projectId}/ci-setup`);
    expect(res.statusCode).toBe(200);
    const outcome = (res.json() as { results: Array<Record<string, unknown>> }).results[0];
    expect(outcome.status).toBe("already-has-ci");
    expect(outcome.detail).toContain(".github/workflows/other.yml");
  });

  it("404s for a project the caller cannot access", async () => {
    const res = await app.inject({ method: "POST", url: "/projects/proj-missing/ci-setup", headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe("repo-status: CI report and automatic requiredChecks fill", () => {
  it("offers [ساخت CI] while the workflow is missing, then records job names after the merge", async () => {
    // 1) no CI yet → stacks detected, setup offered, requiredChecks untouched
    const before = await req("GET", `/projects/${projectId}/repo-status?refresh=1`);
    expect(before.statusCode, before.body).toBe(200);
    const rowBefore = (before.json() as { repositories: Array<Record<string, unknown>> }).repositories[0];
    expect(rowBefore.ciWorkflows).toEqual([]);
    expect(rowBefore.ciStacks).toEqual(["node"]);
    expect(rowBefore.ciSetupAvailable).toBe(true);

    // 2) propose → Draft PR → the human merges it (workflow lands on main)
    const proposed = await req("POST", `/projects/${projectId}/ci-setup`);
    expect(proposed.statusCode).toBe(200);
    const gh = container.github as unknown as {
      commit(
        ref: { owner: string; name: string },
        branch: string,
        message: string,
        files: Array<{ path: string; content: string }>,
      ): Promise<unknown>;
      getFile(
        ref: { owner: string; name: string },
        path: string,
        branch?: string,
      ): Promise<{ content: string } | undefined>;
      updatePullRequest?(
        ref: { owner: string; name: string },
        n: number,
        patch: Record<string, unknown>,
      ): Promise<unknown>;
    };
    const ref = repoRef();
    const wf = await gh.getFile(ref, CI_WORKFLOW_PATH, CI_SETUP_BRANCH);
    expect(wf).toBeDefined();
    await gh.commit(ref, "main", "Merge the CodeVia CI workflow", [{ path: CI_WORKFLOW_PATH, content: wf!.content }]);
    await gh.updatePullRequest?.(ref, 1, { state: "closed" });

    // 3) next repo-status read records the real job names automatically
    const after = await req("GET", `/projects/${projectId}/repo-status?refresh=1`);
    expect(after.statusCode).toBe(200);
    const rowAfter = (after.json() as { repositories: Array<Record<string, unknown>> }).repositories[0];
    expect(rowAfter.ciWorkflows).toEqual([CI_WORKFLOW_PATH]);
    expect(rowAfter.ciSetupAvailable).toBe(false);
    expect(rowAfter.requiredChecksApplied).toEqual(["codevia-node"]);

    const stored = container.projectRepo.findById(projectId)!.data;
    const metadata = (stored.settings?.metadata ?? {}) as { requiredChecks?: string[] };
    expect(metadata.requiredChecks).toEqual(["codevia-node"]);

    // 4) the fill is idempotent — a later read does not rewrite the setting
    const again = await req("GET", `/projects/${projectId}/repo-status?refresh=1`);
    expect(again.statusCode).toBe(200);
    expect(
      ((container.projectRepo.findById(projectId)!.data.settings?.metadata ?? {}) as { requiredChecks?: string[] })
        .requiredChecks,
    ).toEqual(["codevia-node"]);
  });
});

/* ------------------------------------------------------------------ *
 * Write-access preflight through the REAL adapter (fake-github-rest):
 * the Draft PR is only proposed from an account that can actually push,
 * and the site-wide token never writes.
 * ------------------------------------------------------------------ */

const GH_ENV_KEYS = ["GITHUB_TOKEN", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_ENABLED"] as const;

function stubRealGithubEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of GH_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GITHUB_TOKEN = "SITE";
  process.env.GITHUB_CLIENT_ID = "test-client";
  process.env.GITHUB_CLIENT_SECRET = "test-secret";
  process.env.GITHUB_ENABLED = "true";
  getEnvFresh();
  return saved;
}

function restoreGithubEnv(saved: Record<string, string | undefined>) {
  for (const k of GH_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  getEnvFresh();
}

async function projectWithConnection(userId: string, login: string, configRepo: string): Promise<string> {
  // Create against the mock (authoring CodeVia/ state needs no model), then
  // swap in the user-oauth connection — the same dance projectWithState uses.
  const p = await container.agentManager.createProject({
    name: `real connection ${++seq}`,
    description: "user-oauth connection",
    configRepo,
    ownerId: userId,
  });
  const rec = container.projectRepo.findById(p.id)!;
  container.projectRepo.update({
    ...rec.data,
    githubConnection: { kind: "user-oauth", userId, login },
  });
  return p.id;
}

describe("POST /projects/:id/ci-setup (write-access preflight)", () => {
  it("opens the Draft PR with the user's own token when the account can push", async () => {
    const savedEnv = stubRealGithubEnv();
    const fake = createFakeGitHub({
      accounts: { "tok-alice": { login: "alice", scopes: ["repo"], push: ["alice/ci-alice"] } },
      repos: [
        {
          fullName: "alice/ci-alice",
          files: { "README.md": "# ci-alice\n", "package.json": '{"name":"ci-alice"}' },
        },
      ],
    });
    setUserGitHubFetchForTest(fake.fetch);
    vi.stubGlobal("fetch", fake.fetch);
    clearWriteAccessCache();
    try {
      const alice = container.userRepo.upsertGitHubUser({
        id: 92,
        login: "alice",
        name: "alice",
        email: "alice@example.com",
      }).user;
      storeUserGitHubToken(container.kv, alice.id, "tok-alice", { scopes: ["repo"], login: "alice" });
      const pid = await projectWithConnection(alice.id, "alice", "alice/ci-alice");
      const res = await app.inject({
        method: "POST",
        url: `/projects/${pid}/ci-setup`,
        headers: { cookie: `cv_session=${signSession(alice.id)}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const outcome = (res.json() as { results: Array<Record<string, unknown>> }).results[0];
      expect(outcome.status).toBe("created");
      expect(outcome.stacks).toEqual(["node"]);

      const repo = [...fake.repos.values()][0];
      expect(repo.pulls).toHaveLength(1);
      expect(repo.pulls[0].draft).toBe(true);
      expect(repo.pulls[0].head).toBe(CI_SETUP_BRANCH);
      expect(fake.headOf("alice/ci-alice", CI_SETUP_BRANCH)).toBeDefined();
      expect(fake.fileAt("alice/ci-alice", CI_SETUP_BRANCH, CI_WORKFLOW_PATH)).toContain("codevia-node");
      // The site-wide token never took part — the user's own credential did.
      expect(fake.writes().some((w) => w.token === "SITE")).toBe(false);
      expect(fake.writes().some((w) => w.token === "tok-alice")).toBe(true);
    } finally {
      setUserGitHubFetchForTest(undefined);
      vi.unstubAllGlobals();
      restoreGithubEnv(savedEnv);
      clearWriteAccessCache();
    }
  });

  it("403s with writeAccess when the account cannot push — no branch, no PR", async () => {
    const savedEnv = stubRealGithubEnv();
    const fake = createFakeGitHub({
      accounts: { "tok-carol": { login: "carol", scopes: ["repo"], push: [] } },
      repos: [
        {
          fullName: "carol/ci-carol",
          files: { "README.md": "# ci-carol\n", "package.json": '{"name":"ci-carol"}' },
        },
      ],
    });
    setUserGitHubFetchForTest(fake.fetch);
    vi.stubGlobal("fetch", fake.fetch);
    clearWriteAccessCache();
    try {
      const carol = container.userRepo.upsertGitHubUser({
        id: 93,
        login: "carol",
        name: "carol",
        email: "carol@example.com",
      }).user;
      storeUserGitHubToken(container.kv, carol.id, "tok-carol", { scopes: ["repo"], login: "carol" });
      const pid = await projectWithConnection(carol.id, "carol", "carol/ci-carol");
      const res = await app.inject({
        method: "POST",
        url: `/projects/${pid}/ci-setup`,
        headers: { cookie: `cv_session=${signSession(carol.id)}` },
      });
      expect(res.statusCode, res.body).toBe(403);
      const body = res.json() as { error?: string; writeAccess?: { ok: boolean; problem?: string; repos?: unknown[] } };
      expect(body.error).toContain("carol");
      expect(body.writeAccess?.ok).toBe(false);
      expect(body.writeAccess?.repos?.[0]).toMatchObject({ repo: "carol/ci-carol", canPush: false });
      // Nothing was written to GitHub — the preflight stops the flow first.
      expect(fake.writes()).toHaveLength(0);
    } finally {
      setUserGitHubFetchForTest(undefined);
      vi.unstubAllGlobals();
      restoreGithubEnv(savedEnv);
      clearWriteAccessCache();
    }
  });
});
