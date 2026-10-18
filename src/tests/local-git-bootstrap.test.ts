import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitService } from "../github/local-git-service.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";
import type { ChatRequest, IModelProvider } from "../ai/types.js";
import { PROJECT_FILE } from "../github/project-files.js";
import { extractStateArchive } from "../github/state-archive.js";
import { deflateRawSync, crc32 } from "node:zlib";

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    })),
  },
}));

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Dev",
  GIT_AUTHOR_EMAIL: "dev@local",
  GIT_COMMITTER_NAME: "Dev",
  GIT_COMMITTER_EMAIL: "dev@local",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Minimal deflate zip builder (store/deflate, correct CRCs — see state-archive.test.ts for coverage). */
function buildZip(files: Array<{ name: string; content: string }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const content = Buffer.from(f.content, "utf8");
    const data = deflateRawSync(content);
    const crc = crc32(content);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(content.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    local.push(lfh, name, data);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(content.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, cd, eocd]);
}

/* ================================================================== *
 * Part 1 — LocalGitService level: missing repos, unborn HEADs
 * ================================================================== */
describe("LocalGitService: bootstrap of empty/missing repositories", () => {
  let root: string;
  let svc: LocalGitService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cv-lgboot-"));
    svc = new LocalGitService({ rootDir: root, defaultOwner: "local", autoPush: false, autoFetch: false });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("initializes a missing repository on the first write and creates a root commit", async () => {
    const ref = { owner: "ho3eines", name: "fresh" };
    const commit = await svc.commit(ref, "main", "[CodeVia] initialize repository", [
      { path: "README.md", content: "# fresh\n" },
    ]);
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
    const dir = join(root, "ho3eines", "fresh");
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(dir, "rev-list", "--count", "main")).toBe("1");
    expect(git(dir, "show", "main:README.md")).toBe("# fresh");
    // The write synced the worktree: the file is present and the tree is clean.
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# fresh\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("turns a write into the root commit on an unborn HEAD and syncs the worktree", async () => {
    const dir = join(root, "acme", "unborn");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-b", "master"); // no commit: refs/heads is empty, HEAD is unborn
    await svc.commit({ owner: "acme", name: "unborn" }, "master", "root", [
      { path: "README.md", content: "# unborn\n" },
    ]);
    expect(git(dir, "rev-list", "--count", "master")).toBe("1");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# unborn\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("still refuses to invent a branch when the repository already has commits", async () => {
    const dir = join(root, "acme", "shop");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-b", "main");
    writeFileSync(join(dir, "README.md"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "init");
    await expect(
      svc.commit({ owner: "acme", name: "shop" }, "feature-x", "nope", [{ path: "a.md", content: "a" }]),
    ).rejects.toMatchObject({ code: "LOCAL_REF_NOT_FOUND" });
  });

  it("never initializes on reads: a missing repository still fails listBranches", async () => {
    await expect(svc.listBranches({ owner: "ghost", name: "none" })).rejects.toMatchObject({
      code: "LOCAL_REPO_NOT_FOUND",
    });
    expect(existsSync(join(root, "ghost"))).toBe(false);
  });
});

/* ================================================================== *
 * Part 2 — full platform under LOCAL_GIT_MODE
 * ================================================================== */
describe("LOCAL_GIT_MODE project lifecycle", () => {
  let root: string;
  let fx: ReturnType<typeof freshDb>;
  let c: Container;
  let app: FastifyInstance | undefined;
  let prevMode: string | undefined;
  let prevDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cv-lge2e-"));
    prevMode = process.env.LOCAL_GIT_MODE;
    prevDir = process.env.LOCAL_REPOS_DIR;
    process.env.LOCAL_GIT_MODE = "true";
    process.env.LOCAL_REPOS_DIR = root;
    fx = freshDb();
    c = new Container();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevMode === undefined) delete process.env.LOCAL_GIT_MODE;
    else process.env.LOCAL_GIT_MODE = prevMode;
    if (prevDir === undefined) delete process.env.LOCAL_REPOS_DIR;
    else process.env.LOCAL_REPOS_DIR = prevDir;
    c.githubAutomation.stop();
    await app?.close();
    app = undefined;
    await new Promise<void>((r) => setImmediate(r));
    fx.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  /** A chat-capable fake model (provider type "openai") so real-mode generation runs offline. */
  function registerModel() {
    const provider = c.providerRepo.create({
      name: "local-e2e",
      type: "openai",
      baseUrl: "https://unused.invalid/v1",
      authType: "none",
      apiFormat: "openai",
      rateLimitPerMinute: 100,
      timeoutMs: 1000,
      defaultTemperature: 0.2,
      maxTokensDefault: 4500,
      active: true,
    });
    const m = c.modelRepo.create({
      providerId: provider.id,
      modelId: "bootstrap-author",
      displayName: "bootstrap-author",
      contextWindow: 128000,
      inputCostPer1k: 0.01,
      outputCostPer1k: 0.02,
      capabilities: {
        code: true,
        reasoning: true,
        structuredOutput: true,
        tools: false,
        streaming: false,
        vision: false,
      },
      active: true,
      priority: 1,
      fallbackPriority: 1,
      tags: [],
    });
    const runtime: IModelProvider = {
      id: provider.id,
      type: "openai",
      name: "local-e2e",
      health: async () => true,
      listModels: async () => [],
      resolveApiKey: () => undefined,
      chat: async (req: ChatRequest) => {
        const entries = JSON.parse(req.messages[1].content.split("--- Current operation ---\n").at(-1)!) as Record<
          string,
          { fields: Record<string, unknown> }
        >;
        const result = Object.fromEntries(
          Object.entries(entries).map(([key, spec]) => [
            key,
            Object.fromEntries(
              Object.keys(spec.fields).map((field) => [
                field,
                field === "rules" ? ["Follow the documented contract."] : `Authored ${key} ${field}.`,
              ]),
            ),
          ]),
        );
        return {
          content: JSON.stringify(result),
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          costUsd: 0,
          modelId: req.modelId,
          providerId: provider.id,
        };
      },
    };
    c.providerRegistry.register(runtime);
    return m;
  }

  it("creates a project on a repository that does not exist yet", async () => {
    const modelId = registerModel().id;
    const p = await c.agentManager.createProject({
      name: "Fresh Start",
      configRepo: "ho3eines/fresh",
      description: "A brand-new local project",
      capabilities: { languages: ["typescript"] },
      defaultModelId: modelId,
    });
    expect(p.branch).toBe("main");
    const dir = join(root, "ho3eines", "fresh");
    expect(existsSync(join(dir, ".git"))).toBe(true);
    // Bootstrap history: README seed + generated state, all on main.
    expect(Number(git(dir, "rev-list", "--count", "main"))).toBeGreaterThanOrEqual(2);
    expect(git(dir, "show", `main:${PROJECT_FILE}`)).toContain("schemaVersion");
    expect(git(dir, "show", "main:README.md")).toContain("# Fresh Start");
    expect(c.agentRepo.byProject(p.id).length).toBeGreaterThan(0);
    expect(p.repositoryState?.generation).toBe("ai");
  });

  it("adopts the repository's master branch when the project defaulted to main", async () => {
    const dir = join(root, "ho3eines", "legacy");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-b", "master");
    writeFileSync(join(dir, "README.md"), "legacy\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "existing work");
    const modelId = registerModel().id;
    const p = await c.agentManager.createProject({
      name: "Legacy Repo",
      configRepo: "ho3eines/legacy",
      description: "master-based repository",
      capabilities: { languages: ["python"] },
      defaultModelId: modelId,
    });
    expect(p.branch).toBe("master");
    expect(git(dir, "show", `master:${PROJECT_FILE}`)).toContain("schemaVersion");
    expect(Number(git(dir, "rev-list", "--count", "master"))).toBeGreaterThanOrEqual(2);
    // No stray main branch was invented.
    expect(git(dir, "branch", "--list", "main")).toBe("");
    const stored = c.projectRepo.findById(p.id)!.data;
    expect(stored.branch).toBe("master");
    expect(stored.repositories.every((r) => r.repo !== "ho3eines/legacy" || r.branch === "master")).toBe(true);
  });

  it("adopts an unborn HEAD (fresh git init, no commits) and keeps the user's checkout aligned", async () => {
    const dir = join(root, "ho3eines", "unborn");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-b", "master"); // Windows-style fresh repo, zero commits
    const modelId = registerModel().id;
    const p = await c.agentManager.createProject({
      name: "Unborn",
      configRepo: "ho3eines/unborn",
      description: "no commits yet",
      capabilities: { languages: ["typescript"] },
      defaultModelId: modelId,
    });
    expect(p.branch).toBe("master");
    expect(Number(git(dir, "rev-list", "--count", "master"))).toBeGreaterThanOrEqual(2);
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
    // The state files were synced into the working tree the user sees.
    expect(existsSync(join(dir, PROJECT_FILE))).toBe(true);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("bootstraps the repository without a model, then a state archive import completes the project", async () => {
    // The exact user flow: no model configured → creation reports the model
    // guard, but the repository is initialized and the project row persists,
    // ready for the zip import.
    const dir = join(root, "ho3eines", "imported");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-b", "main");

    // Seed a complete, valid state once (sibling project WITH a model)…
    const seedModel = registerModel();
    const seed = await c.agentManager.createProject({
      name: "Seed",
      configRepo: "ho3eines/seed",
      description: "state donor",
      capabilities: { languages: ["typescript"] },
      defaultModelId: seedModel.id,
    });
    const seedState = await c.projectFiles.pull(seed);
    const archive = buildZip([...seedState.contents].map(([path, content]) => ({ name: path, content })));
    // The target project must be genuinely model-less: deactivate the donor model.
    c.modelRepo.upsert({ ...seedModel, active: false, updatedAt: new Date().toISOString() });

    // …then create the real target without any model.
    let failed: unknown;
    try {
      await c.agentManager.createProject({
        name: "Imported",
        configRepo: "ho3eines/imported",
        description: "state arrives by zip",
        capabilities: { languages: ["typescript"] },
      });
    } catch (err) {
      failed = err;
    }
    expect(String((failed as Error).message)).toMatch(/model/i);
    // The repository was bootstrapped: README seed landed on main.
    expect(git(dir, "show", "main:README.md")).toContain("# Imported");
    const stored = c.projectRepo.findMany().find(({ data }) => data.configRepo === "ho3eines/imported")!.data;

    // Import the sibling's state through the HTTP endpoint (model-free).
    app ??= (await buildServer(c)).app;
    const res = await app.inject({
      method: "POST",
      url: `/projects/${stored.id}/state-import`,
      payload: { archive: archive.toString("base64") },
    });
    expect(res.statusCode).toBe(200);
    const imported = res.json().imported as string[];
    expect(imported.length).toBe(seedState.contents.size);
    expect(imported).toContain(PROJECT_FILE);
    // The archive is committed to the repository…
    expect(git(dir, "show", "main:CodeVia/agents/research.md")).toContain("research");
    // …and loaded into the platform (agents materialized from the files).
    expect(c.agentRepo.byProject(stored.id).some((a) => a.type === "research")).toBe(true);
    const refreshed = await c.agentManager.readProject(stored.id);
    expect(refreshed.branch).toBe("main");
  });

  it("rejects an archive without state files with a 400", async () => {
    const modelId = registerModel().id;
    const p = await c.agentManager.createProject({
      name: "Zipless",
      configRepo: "ho3eines/zipless",
      description: "negative import",
      capabilities: { languages: ["typescript"] },
      defaultModelId: modelId,
    });
    app ??= (await buildServer(c)).app;
    const res = await app.inject({
      method: "POST",
      url: `/projects/${p.id}/state-import`,
      payload: { archive: buildZip([{ name: "README.md", content: "no state here\n" }]).toString("base64") },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no CodeVia\/ folder found/i);
  });

  it("extractStateArchive and the platform agree on what a valid archive is", () => {
    // Sanity bridge to the unit suite: the builder used here parses cleanly.
    const files = extractStateArchive(
      buildZip([{ name: "CodeVia/project.md", content: "---\ndefinition:\n  schemaVersion: 2\n---\nx\n" }]),
    );
    expect(files).toHaveLength(1);
  });
});
