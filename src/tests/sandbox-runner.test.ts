import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxRunner, sandboxConfigFromEnv, type DockerExecutionResult } from "../projects/sandbox-runner.js";
import type { Project } from "../domain/entities.js";
import type { GithubRepoRef, IGitHubService } from "../github/types.js";
import { CORE_TOOLS, runTestsTool } from "../tools/core-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type { Agent } from "../domain/entities.js";

/* ------------------------------------------------------------------ *
 * Docker sandbox for project lifecycle commands.
 *
 * Docker is injected, so these tests pin the *contract* without needing a
 * daemon: which commands run per stage, the exact hardening flags, that no
 * host shell is ever used, and how the result maps to `verification`.
 * ------------------------------------------------------------------ */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const projects: string[] = [];

afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "codevia-sandbox-test-"));
  projects.push(dir);
  return dir;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    slug: "demo",
    name: "Demo",
    description: "",
    configRepo: "acme/demo",
    branch: "main",
    repositories: [{ repo: "acme/demo", branch: "main", role: "backend", isConfigRepo: true }],
    capabilities: {
      platforms: [],
      languages: ["TypeScript"],
      frameworks: [],
      databases: [],
      deploymentTargets: [],
      features: [],
      integrations: [],
      agentTypes: [],
    },
    settings: {},
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    commands: { install: "npm ci", test: "npm test", lint: "npm run lint", build: "npm run build" },
    ...overrides,
  } as Project;
}

function github(): IGitHubService {
  const files: Record<string, string> = {
    "package.json": '{"name":"demo"}',
    "src/index.ts": "export {}",
    ".env": "SECRET=canary",
  };
  return {
    listCommits: async () => [{ sha: SHA, message: "init", author: "a", date: "2026-01-01" }],
    listFiles: async () =>
      Object.entries(files).map(([path, body], i) => ({
        path,
        type: "blob" as const,
        size: Buffer.byteLength(body),
        mode: "100644",
        _i: i,
      })),
    getFileBuffer: async (_repo: GithubRepoRef, path: string) => ({
      path,
      content: Buffer.from(files[path] ?? "", "utf8"),
    }),
  } as unknown as IGitHubService;
}

const ok = (patch: Partial<DockerExecutionResult> = {}): DockerExecutionResult => ({
  exitCode: 0,
  stdoutTail: "all good",
  stderrTail: "",
  timedOut: false,
  aborted: false,
  outputLimited: false,
  durationMs: 12,
  ...patch,
});

function volumeArg(args: string[]): string {
  const index = args.indexOf("--volume");
  expect(index).toBeGreaterThan(-1);
  return args[index + 1];
}

describe("sandboxConfigFromEnv", () => {
  it("uses safe defaults and lets explicit options win", () => {
    const defaults = sandboxConfigFromEnv();
    expect(defaults.dockerBin).toBe("docker");
    expect(defaults.timeoutMs).toBeGreaterThan(0);
    expect(defaults.memoryMb).toBeGreaterThan(0);
    const custom = sandboxConfigFromEnv({ dockerBin: "/usr/bin/docker", memoryMb: 4096, cpus: 2 });
    expect(custom.dockerBin).toBe("/usr/bin/docker");
    expect(custom.memoryMb).toBe(4096);
    expect(custom.cpus).toBe(2);
  });
});

describe("SandboxRunner.verify", () => {
  it("runs install → test → lint in a hardened, network-less container", async () => {
    const workspaceRoot = tempRoot();
    let seenArgs: string[] = [];
    let filesInWorkspace: string[] = [];
    let packageJson = "";
    const runDocker = vi.fn(async (_bin: string, args: string[]) => {
      seenArgs = args;
      const workspace = volumeArg(args).split(":")[0];
      filesInWorkspace = ["package.json", "src/index.ts", ".env"].filter((f) => existsSync(join(workspace, f)));
      packageJson = readFileSync(join(workspace, "package.json"), "utf8");
      return ok();
    });
    const runner = new SandboxRunner({ workspaceRoot, runDocker });
    const result = await runner.verify({ project: project(), github: github(), stage: "test" });

    expect(result.ok).toBe(true);
    expect(result.data?.verification).toBe("passed");
    expect(result.data?.sandbox).toBe("docker");
    expect(result.data?.sha).toBe(SHA);

    expect(seenArgs).toEqual(expect.arrayContaining(["--network=none", "--read-only", "--cap-drop=ALL"]));
    expect(seenArgs).toEqual(expect.arrayContaining(["--security-opt=no-new-privileges", "--user=1000:1000"]));
    expect(seenArgs).toEqual(expect.arrayContaining(["--pull=never", "--pids-limit=128"]));
    expect(seenArgs).toContain("--memory=1024m");
    expect(seenArgs).toContain("--cpus=1");

    const script = seenArgs[seenArgs.length - 1];
    const install = script.indexOf("npm ci");
    const test = script.indexOf("npm test");
    const lint = script.indexOf("npm run lint");
    expect(install).toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(install);
    expect(lint).toBeGreaterThan(test);

    // Source exported into the workspace; the secret-bearing file never is.
    expect(filesInWorkspace).toEqual(["package.json", "src/index.ts"]);
    expect(packageJson).toBe('{"name":"demo"}');
  });

  it("removes the exported workspace after the run", async () => {
    const workspaceRoot = tempRoot();
    let workspace = "";
    const runner = new SandboxRunner({
      workspaceRoot,
      runDocker: async (_bin, args) => {
        workspace = volumeArg(args).split(":")[0];
        expect(existsSync(workspace)).toBe(true);
        return ok({ exitCode: 1, stderrTail: "tests failed" });
      },
    });
    const result = await runner.verify({ project: project(), github: github(), stage: "test" });
    expect(result.ok).toBe(false);
    expect(result.data?.verification).toBe("failed");
    expect(result.data?.fixable).toBe(true);
    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(workspaceRoot)).toBe(true);
  });

  it("allows network only when the project explicitly opts in", async () => {
    const seen: string[][] = [];
    const runner = new SandboxRunner({
      workspaceRoot: tempRoot(),
      runDocker: async (_bin, args) => {
        seen.push(args);
        return ok();
      },
    });
    const base = project({ settings: { sandboxNetworkAccess: true } as Project["settings"] });
    await runner.verify({ project: base, github: github(), stage: "test" });
    expect(seen[0]).toContain("--network=bridge");
    expect(seen[0]).not.toContain("--network=none");
  });

  it("runs build + test + lint for a build stage", async () => {
    let script = "";
    const runner = new SandboxRunner({
      workspaceRoot: tempRoot(),
      runDocker: async (_bin, args) => {
        script = args[args.length - 1];
        return ok();
      },
    });
    const result = await runner.verify({ project: project(), github: github(), stage: "build" });
    expect(result.ok).toBe(true);
    expect(script).toContain("npm run build");
    expect(script).toContain("npm test");
    expect(script).toContain("npm run lint");
  });

  it("does not start Docker when the project has no command for the stage", async () => {
    const runDocker = vi.fn(async () => ok());
    const runner = new SandboxRunner({ workspaceRoot: tempRoot(), runDocker });
    const result = await runner.verify({
      project: project({ commands: { install: "npm ci" } }),
      github: github(),
      stage: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.data?.verification).toBe("unverified");
    expect(String(result.output)).toMatch(/No test command is configured/);
    expect(runDocker).not.toHaveBeenCalled();
  });

  it("refuses a repository that is not linked to the project", async () => {
    const runDocker = vi.fn(async () => ok());
    const runner = new SandboxRunner({ workspaceRoot: tempRoot(), runDocker });
    const result = await runner.verify({
      project: project(),
      github: github(),
      repoName: "other/repo",
      stage: "test",
    });
    expect(result.data?.verification).toBe("unverified");
    expect(String(result.output)).toMatch(/must be linked to this project/);
    expect(runDocker).not.toHaveBeenCalled();
  });

  it("pins the exported tree to expectedSha and reports a missing command as unverified (127)", async () => {
    const listFiles = vi.fn(async () => [{ path: "package.json", type: "blob" as const, size: 2, mode: "100644" }]);
    const gh = { ...github(), listFiles } as unknown as IGitHubService;
    const runner = new SandboxRunner({
      workspaceRoot: tempRoot(),
      runDocker: async () => ok({ exitCode: 127, stderrTail: "sh: npm: not found" }),
    });
    const result = await runner.verify({ project: project(), github: gh, stage: "test", expectedSha: SHA });
    expect(listFiles).toHaveBeenCalledWith({ owner: "acme", name: "demo" }, SHA);
    expect(result.data?.verification).toBe("unverified");
    expect(result.data?.fixable).toBe(false);
  });

  it("treats a timeout / output limit as a failed, non-green run", async () => {
    const runner = new SandboxRunner({
      workspaceRoot: tempRoot(),
      runDocker: async () => ok({ exitCode: 0, timedOut: true }),
    });
    const result = await runner.verify({ project: project(), github: github(), stage: "test" });
    expect(result.ok).toBe(false);
    expect(result.data?.verification).toBe("failed");
    expect(String(result.output)).toMatch(/timeout/i);
  });

  it("refuses symlinks and oversized sources before Docker is called", async () => {
    const runDocker = vi.fn(async () => ok());
    const symlink = {
      ...github(),
      listFiles: async () => [{ path: "link", type: "blob" as const, size: 1, mode: "120000" }],
    } as unknown as IGitHubService;
    const runner = new SandboxRunner({ workspaceRoot: tempRoot(), runDocker });
    const result = await runner.verify({ project: project(), github: symlink, stage: "test" });
    expect(result.data?.verification).toBe("unverified");
    expect(String(result.output)).toMatch(/symbolic links/i);
    expect(runDocker).not.toHaveBeenCalled();
  });

  it("stops before Docker when the signal is already aborted", async () => {
    const runDocker = vi.fn(async () => ok());
    const controller = new AbortController();
    controller.abort();
    const runner = new SandboxRunner({ workspaceRoot: tempRoot(), runDocker });
    const result = await runner.verify({
      project: project(),
      github: github(),
      stage: "test",
      signal: controller.signal,
    });
    expect(result.data?.verification).toBe("unverified");
    expect(runDocker).not.toHaveBeenCalled();
  });

  it("rejects an invalid or oversized command", async () => {
    const runner = new SandboxRunner({ workspaceRoot: tempRoot(), runDocker: async () => ok() });
    const result = await runner.verify({
      project: project({ commands: { test: "x".repeat(1001) } }),
      github: github(),
      stage: "test",
    });
    expect(result.data?.verification).toBe("unverified");
    expect(String(result.output)).toMatch(/command is invalid.*1000 characters/i);
  });
});

describe("sandbox availability", () => {
  it("marks a missing Docker CLI as unavailable, not as a failed test", async () => {
    const runner = new SandboxRunner({
      workspaceRoot: tempRoot(),
      runDocker: async () => ok({ exitCode: 127, stdoutTail: "", stderrTail: "Docker executable not found: docker" }),
    });
    const result = await runner.verify({ project: project(), github: github(), stage: "test" });
    expect(result.data).toMatchObject({ verification: "unverified", fixable: false, sandbox: "unavailable" });
  });

  it("falls back to GitHub CI evidence when no Docker CLI exists", async () => {
    const runner = new SandboxRunner({
      workspaceRoot: tempRoot(),
      runDocker: async () => ok({ exitCode: 127, stdoutTail: "", stderrTail: "Docker executable not found: docker" }),
    });
    const gh = {
      ...github(),
      kind: "real",
      listBranches: async () => [{ name: "main", sha: SHA }],
      getChecks: async () => [{ name: "build", status: "success" }],
    } as unknown as IGitHubService;
    const ctx = { project: project(), github: gh, sandboxRunner: runner } as unknown as ToolContext;
    const result = await runTestsTool.execute(ctx, { ref: "main", waitMs: 0 });
    expect(result.data).toMatchObject({ verification: "passed", sandbox: "unavailable", sha: SHA });
    expect(result.output).toMatch(/falling back to GitHub CI/i);
  });

  it("does not pretend CI covers a repo-less local project", async () => {
    const runner = new SandboxRunner({
      workspaceRoot: tempRoot(),
      runDocker: async () => ok({ exitCode: 127, stdoutTail: "", stderrTail: "Docker executable not found: docker" }),
    });
    const local = project({ sourceType: "local", configRepo: "local/demo" });
    const gh = {
      ...github(),
      kind: "real",
      listBranches: async () => [{ name: "main", sha: SHA }],
      getChecks: async () => [{ name: "build", status: "success" }],
    } as unknown as IGitHubService;
    const ctx = { project: local, github: gh, sandboxRunner: runner } as unknown as ToolContext;
    const result = await runTestsTool.execute(ctx, { ref: "main", waitMs: 0 });
    expect(result.data).toMatchObject({ verification: "unverified", sandbox: "unavailable" });
    expect(result.output).not.toMatch(/falling back/i);
    expect(result.output).toMatch(/Docker/i);
  });
});

describe("mock repositories", () => {
  it("reports a simulation instead of running Docker", async () => {
    const runDocker = vi.fn(async () => ok());
    const runner = new SandboxRunner({ workspaceRoot: tempRoot(), runDocker });
    const mock = { ...github(), kind: "mock" } as unknown as IGitHubService;
    const result = await runner.verify({ project: project(), github: mock, stage: "test" });
    expect(result).toMatchObject({ ok: true, data: { verification: "simulated", sandbox: "mock" } });
    expect(runDocker).not.toHaveBeenCalled();
  });

  it("needs no human approval for a sandbox simulation", async () => {
    const runDocker = vi.fn(async () => ok());
    const runner = new SandboxRunner({ workspaceRoot: tempRoot(), runDocker });
    const mock = { ...github(), kind: "mock" } as unknown as IGitHubService;
    const agent = {
      id: "a1",
      slug: "qa",
      tools: ["run_tests"],
      permissions: ["github.read"],
    } as unknown as Agent;
    const ctx = {
      project: project(),
      agent,
      github: mock,
      logger: { info() {}, warn() {}, error() {} },
      correlationId: "mock-sandbox",
      sandboxRunner: runner,
    } as unknown as ToolContext;
    const tools = new ToolRegistry();
    tools.registerMany(CORE_TOOLS);
    const result = await tools.execute("run_tests", ctx, {});
    expect(result.data?.verification).toBe("simulated");
    expect(runDocker).not.toHaveBeenCalled();
  });

  it("uses CI evidence without approval when the sandbox runner is disabled", async () => {
    const gh = {
      ...github(),
      kind: "real",
      listBranches: async () => [{ name: "main", sha: SHA }],
      getChecks: async () => [{ name: "build", status: "success" }],
    } as unknown as IGitHubService;
    const agent = {
      id: "a1",
      slug: "qa",
      tools: ["run_tests"],
      permissions: ["github.read"],
    } as unknown as Agent;
    const ctx = {
      project: project(),
      agent,
      github: gh,
      logger: { info() {}, warn() {}, error() {} },
      correlationId: "ci-only",
      // PROJECT_SANDBOX_ENABLED=false in the test environment.
    } as unknown as ToolContext;
    const tools = new ToolRegistry();
    tools.registerMany(CORE_TOOLS);
    const result = await tools.execute("run_tests", ctx, { ref: "main", waitMs: 0 });
    expect(result.data?.verification).toBe("passed");
    expect(result.output).toMatch(/GitHub CI passed/);
  });
});
