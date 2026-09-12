import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealGitHubService } from "../github/real-service.js";
import type { IGitHubService } from "../github/types.js";
import { verifyGithubChecks } from "../tools/github-checks.js";
import { ToolRegistry } from "../tools/registry.js";
import { CORE_TOOLS } from "../tools/core-tools.js";
import type { ToolContext } from "../tools/types.js";
import type { ModelProvider, Project } from "../domain/entities.js";
import { Container } from "../app/container.js";
import { freshDb } from "./test-helpers.js";
import { deleteUserGitHubToken, storeUserGitHubToken } from "../auth/github-tokens.js";
import { saveGitHubAdminSettings } from "../auth/admin-settings.js";
import { getEnvFresh } from "../config/env.js";
import {
  resolveGitHubForProject,
  resolveProjectUserIdWithGitHubToken,
  setUserGitHubFetchForTest,
} from "../github/registry.js";
import { encryptSecret } from "../auth/encrypted-secrets.js";
import { OpenAICompatibleProvider } from "../ai/http-provider.js";
import { AnthropicProvider } from "../ai/anthropic-provider.js";
import { GeminiProvider } from "../ai/gemini-provider.js";

const repo = { owner: "acme", name: "app" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("real GitHub adapter contract", () => {
  it("recurses Contents API directories (type=dir) and preserves file/directory types", async () => {
    const fetcher = vi.fn(async (url: unknown) =>
      String(url).includes("/contents/src?")
        ? json([{ type: "file", path: "src/app.ts", size: 30 }])
        : json([
            { type: "file", path: "README.md" },
            { type: "dir", path: "src" },
          ]),
    );
    const gh = new RealGitHubService({ token: "test-only", fetchImpl: fetcher as typeof fetch });
    expect(await gh.listFiles(repo, "main")).toEqual([
      { path: "README.md", type: "blob", size: undefined },
      { path: "src", type: "tree", size: undefined },
      { path: "src/app.ts", type: "blob", size: 30 },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("only treats 404 as missing; server errors cannot trigger blind creation", async () => {
    const missing = new RealGitHubService({
      token: "test-only",
      fetchImpl: (async () => json({}, 404)) as typeof fetch,
    });
    expect(await missing.getFile(repo, "missing.ts", "main")).toBeUndefined();
    const unavailable = new RealGitHubService({
      token: "test-only",
      fetchImpl: (async () => json({}, 503)) as typeof fetch,
    });
    await expect(unavailable.getFile(repo, "existing.ts", "main")).rejects.toThrow(/503/);
  });

  it("commits with the parent's TREE SHA and checks the inspected HEAD", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const gh = new RealGitHubService({
      token: "test-only",
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
        if (String(url).includes("/branches/")) return json({ commit: { sha: "old-commit" } });
        if (String(url).endsWith("/git/commits/old-commit")) return json({ tree: { sha: "old-tree" } });
        if (String(url).endsWith("/git/trees")) return json({ sha: "new-tree" });
        return json({ sha: "new-commit" });
      }) as typeof fetch,
    });
    await gh.commit(repo, "feature", "change", [{ path: "src/a.ts", content: "export const a = 1;" }], "old-commit");
    expect(calls.find((c) => c.url.endsWith("/git/trees"))?.body.base_tree).toBe("old-tree");
    const before = calls.length;
    await expect(
      gh.commit(repo, "feature", "stale", [{ path: "src/a.ts", content: "bad" }], "stale-head"),
    ).rejects.toThrow(/changed after inspection/);
    expect(calls).toHaveLength(before + 1); // read only, no stale write
  });

  it("combines check-runs and commit statuses without accepting failed or skipped checks", async () => {
    const gh = new RealGitHubService({
      token: "test-only",
      fetchImpl: (async (url) =>
        String(url).includes("/check-runs")
          ? json({
              total_count: 3,
              check_runs: [
                { name: "build", status: "completed", conclusion: "success" },
                { name: "test", status: "completed", conclusion: "failure", output: { title: "assertion failed" } },
                { name: "optional", status: "completed", conclusion: "skipped" },
              ],
            })
          : json({ total_count: 1, statuses: [{ context: "external", state: "pending" }] })) as typeof fetch,
    });
    expect((await gh.getChecks(repo, "commit-sha")).map((c) => [c.name, c.status])).toEqual([
      ["build", "success"],
      ["test", "failure"],
      ["optional", "skipped"],
      ["external", "pending"],
    ]);
  });
});

let fx: ReturnType<typeof freshDb>;
let c: Container;
let project: Project;
let ctx: ToolContext;
beforeEach(async () => {
  fx = freshDb();
  c = new Container();
  await c.ensureSeed();
  project = await c.agentManager.createProject({ name: "Contract", description: "app", configRepo: "acme/app" });
  ctx = {
    project,
    agent: c.agentRepo.byType(project.id, "backend-developer")!,
    github: {
      kind: "real",
      listBranches: async () => [{ name: "feature", sha: "head-sha" }],
      getChecks: async () => [{ name: "build", status: "success" }],
    } as unknown as ToolContext["github"],
    logger: { info() {}, warn() {}, error() {} } as unknown as ToolContext["logger"],
    correlationId: "contract",
  };
});
afterEach(() => {
  c.githubAutomation.stop();
  setUserGitHubFetchForTest(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  getEnvFresh();
  fx.cleanup();
});

describe("CI evidence and tool guards", () => {
  it("verifies an exact SHA, not the unchanged main branch", async () => {
    const checks = vi.spyOn(ctx.github, "getChecks");
    const result = await verifyGithubChecks(ctx, { ref: "feature", waitMs: 0 });
    expect(result.ok).toBe(true);
    expect(result.data?.verification).toBe("passed");
    expect(checks).toHaveBeenCalledWith(repo, "head-sha");
  });
  it("reports missing, skipped and required-but-absent checks as unverified", async () => {
    for (const checks of [[], [{ name: "build", status: "skipped" as const }]]) {
      ctx.github.getChecks = async () => checks;
      const result = await verifyGithubChecks(ctx, { ref: "feature", waitMs: 0 });
      expect(result.ok).toBe(false);
      expect(result.data).toMatchObject({ verification: "unverified", fixable: false });
    }
    ctx.github.getChecks = async () => [{ name: "build", status: "success" }];
    ctx.project.settings.metadata.requiredChecks = ["build", "test"];
    expect((await verifyGithubChecks(ctx, { ref: "feature", waitMs: 0 })).data?.verification).toBe("unverified");
  });
  it("classifies CI API failures as unverified infrastructure, never fixable code", async () => {
    ctx.github.getChecks = async () => {
      throw new Error("GitHub HTTP 503");
    };
    const result = await verifyGithubChecks(ctx, { ref: "feature", waitMs: 0 });
    expect(result.data).toMatchObject({ verification: "unverified", fixable: false });
    expect(result.output).toContain("503");
  });
  it("refuses a mismatched expected commit and detects a branch moving during CI", async () => {
    const checks = vi.spyOn(ctx.github, "getChecks");
    const stale = await verifyGithubChecks(ctx, { ref: "feature", expectedSha: "older", waitMs: 0 });
    expect(stale.data?.verification).toBe("unverified");
    expect(checks).not.toHaveBeenCalled();
    vi.spyOn(ctx.github, "listBranches")
      .mockResolvedValueOnce([{ name: "feature", sha: "head-sha" }])
      .mockResolvedValue([{ name: "feature", sha: "new-head" }]);
    const moved = await verifyGithubChecks(ctx, { ref: "feature", expectedSha: "head-sha", waitMs: 0 });
    expect(moved.ok).toBe(false);
    expect(moved.data).toMatchObject({ verification: "unverified", fixable: false });
  });
  it("supports exact required-check names per linked repository", async () => {
    ctx.project.settings.metadata = {
      requiredChecks: ["global-unused"],
      requiredChecksByRepo: { "acme/app": ["build"] },
    };
    expect((await verifyGithubChecks(ctx, { ref: "feature", waitMs: 0 })).data?.verification).toBe("passed");
    ctx.project.settings.metadata.requiredChecksByRepo = { "acme/app": ["build", "missing-test"] };
    expect((await verifyGithubChecks(ctx, { ref: "feature", waitMs: 0 })).data?.verification).toBe("unverified");
  });
  it("honours an explicit project policy denial despite agent permissions", async () => {
    const tools = new ToolRegistry();
    tools.registerMany(CORE_TOOLS);
    const list = vi.spyOn(ctx.github, "listBranches");
    ctx.project.settings.permissions["repository.read"] = false;
    const result = await tools.execute("list_branches", ctx, {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Project policy denies");
    expect(list).not.toHaveBeenCalled();
  });
  it("never runs user-provided shell commands or cwd on the host", async () => {
    const result = await verifyGithubChecks(ctx, { command: "echo should-not-run", cwd: "/", ref: "feature" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Host shell execution is disabled");
  });
  it("fails closed without an approval channel and denies tools removed from the toolbox", async () => {
    const tools = new ToolRegistry();
    tools.registerMany(CORE_TOOLS);
    const result = await tools.execute(
      "write_file",
      { ...ctx, github: c.github },
      { branch: "feature", path: "src/a.ts", content: "x" },
    );
    expect(result.ok).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(tools.isAllowed(tools.get("write_file")!, { ...ctx.agent, tools: ["read_file"] })).toBe(false);
  });

  it("aborts a cooperative tool on timeout so its late side effect never lands", async () => {
    const tools = new ToolRegistry();
    let lateEffect = false;
    tools.register({
      name: "delayed-effect",
      description: "fixture",
      dangerous: false,
      permissions: [],
      inputSchema: {},
      timeoutMs: 5,
      execute: async (toolCtx) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 40);
          toolCtx.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        lateEffect = true;
        return { ok: true, output: "fixture effect" };
      },
    });
    const result = await tools.execute(
      "delayed-effect",
      { ...ctx, agent: { ...ctx.agent, tools: ["delayed-effect"] } },
      {},
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out");
    expect(lateEffect).toBe(false);
  });
});

describe("project-scoped connections", () => {
  it("uses the persisted owner's OAuth connection for background operations", async () => {
    storeUserGitHubToken(c.kv, "owner-a", "fake-project-token", { scopes: "repo", login: "owner-a" });
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-project-token");
      return json([{ name: "main", commit: { sha: "head" } }]);
    });
    setUserGitHubFetchForTest(fetcher as typeof fetch);
    const bound = resolveGitHubForProject({
      project: { ...project, githubConnection: { kind: "user-oauth", userId: "owner-a" } },
      kv: c.kv,
      fallback: c.github,
    });
    expect(bound.kind).toBe("real");
    await bound.listBranches(repo);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() =>
      resolveGitHubForProject({
        project: { ...project, githubConnection: { kind: "user-oauth", userId: "missing-owner" } },
        kv: c.kv,
        fallback: c.github,
      }),
    ).toThrow(/reconnected/);
  });
  it("keeps mock only when neither a user login nor OAuth is configured", () => {
    const bound = resolveGitHubForProject({
      project: { ...project, githubConnection: { kind: "mock" } },
      kv: c.kv,
      fallback: c.github,
    });
    expect(bound.kind).toBe("mock");
  });
  it("does not substitute a real server fallback for a stale mock connection without a user token", () => {
    const realFallback = { kind: "real" as const } as IGitHubService;
    const bound = resolveGitHubForProject({
      project: { ...project, githubConnection: { kind: "mock" } },
      kv: c.kv,
      fallback: realFallback,
    });
    expect(bound.kind).not.toBe("real");
  });
  it("uses the owner's real GitHub login even for a project saved with mock connection", async () => {
    storeUserGitHubToken(c.kv, "owner-a", "fake-project-token", { scopes: "repo", login: "owner-a" });
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-project-token");
      return json([{ name: "main", commit: { sha: "head" } }]);
    });
    setUserGitHubFetchForTest(fetcher as typeof fetch);
    const bound = resolveGitHubForProject({
      project: { ...project, ownerId: "owner-a", githubConnection: { kind: "mock" } },
      kv: c.kv,
      fallback: c.github,
    });
    expect(bound.kind).toBe("real");
    await bound.listBranches(repo);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ownerId: "missing-owner", githubConnection: { kind: "mock" as const } },
    { githubConnection: { kind: "mock" as const, userId: "missing-connection-user" } },
    { ownerId: "missing-owner", githubConnection: { kind: "mock" as const, userId: "" } },
  ])("does not borrow the sole token when the project already has an identity: %j", (identity) => {
    storeUserGitHubToken(c.kv, "other-user", "other-user-token");
    const owned = { ...project, ...identity };
    expect(resolveProjectUserIdWithGitHubToken(c.kv, owned)).toBeUndefined();
    expect(resolveGitHubForProject({ project: owned, kv: c.kv, fallback: c.github }).kind).toBe("mock");
  });
  it("does not switch an explicit connection to its owner's token when that connection expires", () => {
    storeUserGitHubToken(c.kv, "owner-a", "owner-token");
    const owned: Project = {
      ...project,
      ownerId: "owner-a",
      githubConnection: { kind: "mock", userId: "expired-user" },
    };
    expect(resolveProjectUserIdWithGitHubToken(c.kv, owned)).toBeUndefined();
  });
  it("supports the sole OAuth token only for an ownerless legacy mock project", async () => {
    storeUserGitHubToken(c.kv, "sole-user", "sole-user-token");
    const legacy: Project = { ...project, ownerId: undefined, githubConnection: { kind: "mock" } };
    expect(resolveProjectUserIdWithGitHubToken(c.kv, legacy)).toBe("sole-user");
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sole-user-token");
      return json([{ name: "main", commit: { sha: "head" } }]);
    });
    setUserGitHubFetchForTest(fetcher as typeof fetch);
    const bound = resolveGitHubForProject({ project: legacy, kv: c.kv, fallback: c.github });
    await bound.listBranches(repo);
    deleteUserGitHubToken(c.kv, "sole-user");
    await expect(bound.listBranches(repo)).rejects.toThrow(/token not configured/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not guess an owner for a legacy project when multiple OAuth tokens exist", () => {
    storeUserGitHubToken(c.kv, "first-user", "first-token");
    storeUserGitHubToken(c.kv, "second-user", "second-token");
    expect(
      resolveProjectUserIdWithGitHubToken(c.kv, { ...project, ownerId: undefined, githubConnection: { kind: "mock" } }),
    ).toBeUndefined();
  });
  it.each(["environment", "admin"])("requires login instead of mocking when OAuth is configured via %s", (source) => {
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-only-oauth-app-secret");
    vi.stubEnv("GITHUB_CLIENT_ID", source === "environment" ? "test-client-id" : "");
    if (source === "admin") saveGitHubAdminSettings(c.kv, { clientId: "admin-client-id" });
    getEnvFresh();
    expect(() =>
      resolveGitHubForProject({
        project: { ...project, githubConnection: { kind: "mock" } },
        kv: c.kv,
        fallback: c.github,
      }),
    ).toThrow(/Log in with GitHub/);
  });
  it("prefers the owner's OAuth token over GITHUB_TOKEN for a server-token project", async () => {
    storeUserGitHubToken(c.kv, "owner-a", "owner-token");
    const connected: Project = { ...project, ownerId: "owner-a", githubConnection: { kind: "server-token" } };
    const fallback = { kind: "real" as const } as IGitHubService;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner-token");
      return json([{ name: "main", commit: { sha: "head" } }]);
    });
    setUserGitHubFetchForTest(fetcher as typeof fetch);
    const bound = resolveGitHubForProject({ project: connected, kv: c.kv, fallback });
    expect(bound).not.toBe(fallback);
    expect(bound.kind).toBe("real");
    await bound.listBranches(repo);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps explicit server-token connections off the mock when the owner has no OAuth token", () => {
    const connected: Project = { ...project, ownerId: "owner-a", githubConnection: { kind: "server-token" } };
    const fallback = { kind: "real" as const } as IGitHubService;
    expect(resolveGitHubForProject({ project: connected, kv: c.kv, fallback })).toBe(fallback);
    expect(() => resolveGitHubForProject({ project: connected, kv: c.kv, fallback: c.github })).toThrow(
      /refusing a mock fallback/,
    );
  });
  it("rehydrates default provider adapters from persisted credentials on restart", async () => {
    const stored = c.providerRepo.findById("provider-openai")!.data;
    c.providerRepo.upsert({ ...stored, active: true, secretValueEnc: JSON.stringify(encryptSecret("saved-ui-key")) });
    await c.ensureSeed();
    expect(c.providerRegistry.resolve(c.providerRepo.findById(stored.id)!.data).resolveApiKey()).toBe("saved-ui-key");
  });
  it.each([OpenAICompatibleProvider, AnthropicProvider, GeminiProvider])(
    "reads encrypted UI provider credentials in the runtime adapter",
    (Provider) => {
      const config = {
        id: "adapter",
        name: "adapter",
        type: "openai",
        secretValueEnc: JSON.stringify(encryptSecret("fake-provider-key")),
      } as ModelProvider;
      expect(new Provider(config).resolveApiKey()).toBe("fake-provider-key");
    },
  );
});
