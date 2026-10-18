import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalGitService } from "../github/local-git-service.js";

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

let root: string;
let svc: LocalGitService;
const ref = { owner: "acme", name: "shop" };
const repoDir = () => join(root, "acme", "shop");

function makeRepo(files: Record<string, string>, branch = "main"): string {
  const dir = repoDir();
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", branch);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}

const head = async (branch = "main") => (await svc.listBranches(ref)).find((b) => b.name === branch)!.sha;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cv-compat-"));
  svc = new LocalGitService({ rootDir: root, defaultOwner: "local", autoPush: false, autoFetch: false });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("LocalGit compatibility: repository discovery", () => {
  it("01 discovers an owner/name repo and reports its default branch", async () => {
    makeRepo({ "README.md": "x" });
    const list = await svc.listRepositories();
    expect(list.map((r) => r.fullName)).toContain("acme/shop");
    expect((await svc.getRepository(ref))?.defaultBranch).toBe("main");
  });

  it("02 a flat repo directly under the root is owned by defaultOwner", async () => {
    const dir = join(root, "legacy");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "init");
    const list = await svc.listRepositories();
    expect(list.map((r) => r.fullName)).toContain("local/legacy");
  });

  it("03 a bare repository (name.git) is resolved and readable", async () => {
    const dir = makeRepo({ "README.md": "bare me" });
    git(root, "clone", "--bare", dir, join(root, "acme", "shop.git"));
    const files = await svc.listFiles(ref, "main");
    expect(files.map((f) => f.path)).toContain("README.md");
  });

  it("04 an empty repository (no commits) has no branches and no files", async () => {
    mkdirSync(repoDir(), { recursive: true });
    git(repoDir(), "init", "-b", "main");
    expect(await svc.listBranches(ref)).toEqual([]);
    expect(await svc.listFiles(ref)).toEqual([]);
  });

  it("05 plain folders that are not git repos are ignored", async () => {
    mkdirSync(join(root, "acme", "notes"), { recursive: true });
    writeFileSync(join(root, "acme", "notes", "todo.txt"), "x");
    const list = await svc.listRepositories();
    expect(list.map((r) => r.fullName)).not.toContain("acme/notes");
  });

  it("06 detects the primary language from extensions and ignores CodeVia/", async () => {
    makeRepo({
      "a.cs": "1",
      "b.cs": "2",
      "c.ts": "3",
      "CodeVia/x.ts": "4",
      "CodeVia/y.ts": "5",
      "CodeVia/z.ts": "6",
    });
    expect((await svc.getRepository(ref))?.language).toBe("C#");
  });

  it("07 rejects unsafe repository names (path traversal)", async () => {
    await expect(svc.getRepository({ owner: "..", name: "etc" })).rejects.toThrow(/Unsafe/);
  });
});

describe("LocalGit compatibility: CodeVia/* state", () => {
  it("08 commit writes CodeVia/project.md and reads it back byte-identical (utf-8)", async () => {
    makeRepo({ "README.md": "x" });
    const content = "---\nid: p1\n---\n# فروشگاه\n中文\n";
    await svc.commit(
      ref,
      "main",
      "[CodeVia] save project state [skip ci]",
      [{ path: "CodeVia/project.md", content }],
      await head(),
    );
    expect((await svc.getFile(ref, "CodeVia/project.md", "main"))?.content).toBe(content);
  });

  it("09 a stale parentSha is refused (compare-and-swap)", async () => {
    makeRepo({ "README.md": "x" });
    const old = await head();
    await svc.commit(ref, "main", "A", [{ path: "CodeVia/a.md", content: "a" }], old);
    await expect(svc.commit(ref, "main", "B", [{ path: "CodeVia/b.md", content: "b" }], old)).rejects.toThrow(
      /changed after inspection/,
    );
  });

  it("10 five concurrent state writes all land; none is lost", async () => {
    makeRepo({ "README.md": "x" });
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) => svc.commit(ref, "main", `c${i}`, [{ path: `CodeVia/f${i}.md`, content: `${i}` }])),
    );
    const names = (await svc.listFiles(ref, "main", "CodeVia")).map((f) => f.path);
    expect(names.sort()).toEqual([1, 2, 3, 4, 5].map((i) => `CodeVia/f${i}.md`));
    expect(git(repoDir(), "rev-list", "--count", "main")).toBe("6");
  });

  it("11 an unstaged edit in the developer's working tree survives a state commit", async () => {
    const dir = makeRepo({ "src.cs": "original" });
    writeFileSync(join(dir, "src.cs"), "dirty local edit");
    await svc.commit(ref, "main", "state", [{ path: "CodeVia/project.md", content: "p" }], await head());
    expect(readFileSync(join(dir, "src.cs"), "utf8")).toBe("dirty local edit");
  });

  it("11b a STAGED change in the developer's index survives a state commit", async () => {
    const dir = makeRepo({ "src.cs": "original", "other.ts": "o" });
    writeFileSync(join(dir, "other.ts"), "staged edit");
    git(dir, "add", "other.ts"); // staged, not committed
    writeFileSync(join(dir, "src.cs"), "unstaged edit");
    await svc.commit(ref, "main", "state", [{ path: "CodeVia/project.md", content: "p" }], await head());
    // the developer's staging area is exactly as they left it:
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("other.ts");
    expect(git(dir, "diff", "--name-only")).toBe("src.cs");
    // and the state file is present on disk:
    expect(readFileSync(join(dir, "CodeVia", "project.md"), "utf8")).toBe("p");
  });

  it("12 a state commit on the checked-out branch appears on disk immediately", async () => {
    const dir = makeRepo({ "README.md": "x" });
    const content = "on disk";
    await svc.commit(ref, "main", "state", [{ path: "CodeVia/project.md", content }], await head());
    expect(readFileSync(join(dir, "CodeVia", "project.md"), "utf8")).toBe(content);
  });

  it("13 deleteFiles removes a CodeVia file; getFile then returns undefined", async () => {
    makeRepo({ "README.md": "x" });
    await svc.commit(ref, "main", "add", [{ path: "CodeVia/tmp.md", content: "t" }], await head());
    await svc.deleteFiles(ref, "main", "remove", ["CodeVia/tmp.md"], await head());
    expect(await svc.getFile(ref, "CodeVia/tmp.md", "main")).toBeUndefined();
  });

  it("14 deleteFiles of a path that does not exist is a successful no-op", async () => {
    makeRepo({ "README.md": "x" });
    await expect(svc.deleteFiles(ref, "main", "noop", ["CodeVia/nope.md"], await head())).resolves.toBeDefined();
  });

  it("15 listFiles on a missing CodeVia folder throws a 404 (state layer relies on this)", async () => {
    makeRepo({ "README.md": "x" });
    await expect(svc.listFiles(ref, "main", "CodeVia")).rejects.toMatchObject({ status: 404 });
  });

  it("16 getFile refuses path traversal and returns undefined", async () => {
    makeRepo({ "README.md": "x" });
    expect(await svc.getFile(ref, "../secret", "main")).toBeUndefined();
  });

  it("17 getFile accepts a commit SHA in place of a branch name (state layer reads by SHA)", async () => {
    makeRepo({ "README.md": "hello" });
    expect((await svc.getFile(ref, "README.md", await head()))?.content).toBe("hello");
  });

  it("18 Windows-style backslash paths are normalized in listFiles", async () => {
    makeRepo({ "CodeVia/agents/a.md": "a" });
    const paths = (await svc.listFiles(ref, "main", "CodeVia\\agents")).map((f) => f.path);
    expect(paths).toContain("CodeVia/agents/a.md");
  });

  it("19 the [skip ci] marker is stored verbatim in the commit message", async () => {
    const dir = makeRepo({ "README.md": "x" });
    await svc.commit(
      ref,
      "main",
      "[CodeVia] save memory [skip ci]",
      [{ path: "CodeVia/memory.md", content: "m" }],
      await head(),
    );
    expect(git(dir, "log", "-1", "--format=%B")).toContain("[skip ci]");
  });

  it("20 a commit on a path with a leading slash is accepted and stored under the clean path", async () => {
    makeRepo({ "README.md": "x" });
    await svc.commit(ref, "main", "s", [{ path: "/CodeVia/lead.md", content: "l" }], await head());
    expect((await svc.getFile(ref, "CodeVia/lead.md", "main"))?.content).toBe("l");
  });
});

describe("LocalGit compatibility: branches and working copy", () => {
  it("21 createBranch from a commit creates a branch that listBranches reports", async () => {
    makeRepo({ "README.md": "x" });
    await svc.createBranch(ref, "agent-task-1", await head());
    expect((await svc.listBranches(ref)).map((b) => b.name)).toContain("agent-task-1");
  });

  it("22 createBranch rejects option-like names", async () => {
    makeRepo({ "README.md": "x" });
    await expect(svc.createBranch(ref, "-bad", await head())).rejects.toThrow(/Invalid branch name/);
  });

  it("23 a commit to a feature branch leaves main untouched", async () => {
    makeRepo({ "README.md": "x" });
    const main = await head();
    await svc.createBranch(ref, "feat", main);
    await svc.commit(ref, "feat", "feature work", [{ path: "src/feat.ts", content: "export {}" }], main);
    expect(await head("main")).toBe(main);
    expect(await head("feat")).not.toBe(main);
  });
});

describe("LocalGit compatibility: pull requests, merge gate and checks", () => {
  it("24 createPullRequest is idempotent for the same head and base", async () => {
    makeRepo({ "README.md": "x" });
    await svc.createBranch(ref, "feat", await head());
    const a = await svc.createPullRequest(ref, "T", "B", "feat", "main", { draft: true });
    const b = await svc.createPullRequest(ref, "T", "B", "feat", "main", { draft: true });
    expect(b.number).toBe(a.number);
    expect(await svc.listPullRequests(ref)).toHaveLength(1);
  });

  it("25 numbers increase per repository", async () => {
    makeRepo({ "README.md": "x" });
    await svc.createBranch(ref, "f1", await head());
    await svc.createBranch(ref, "f2", await head());
    const p1 = await svc.createPullRequest(ref, "1", "", "f1", "main");
    const p2 = await svc.createPullRequest(ref, "2", "", "f2", "main");
    expect([p1.number, p2.number]).toEqual([1, 2]);
  });

  it("26 getPullRequest reports the live head SHA after a new commit on the head branch", async () => {
    makeRepo({ "README.md": "x" });
    const main = await head();
    await svc.createBranch(ref, "feat", main);
    const pr = await svc.createPullRequest(ref, "T", "", "feat", "main");
    await svc.commit(ref, "feat", "more", [{ path: "src/a.ts", content: "a" }], main);
    const live = await svc.getPullRequest(ref, pr.number);
    expect(live?.headSha).toBe(await head("feat"));
    expect(live?.headSha).not.toBe(pr.headSha);
  });

  it("27 squash merge advances main, marks the PR merged and brings the head's files", async () => {
    makeRepo({ "README.md": "x" });
    const main = await head();
    await svc.createBranch(ref, "feat", main);
    await svc.commit(ref, "feat", "feat", [{ path: "src/new.ts", content: "n" }], main);
    const pr = await svc.createPullRequest(ref, "T", "", "feat", "main");
    const res = await svc.mergePullRequest(ref, pr.number, { method: "squash" });
    expect(res.merged).toBe(true);
    expect(await head("main")).toBe(res.sha);
    expect((await svc.getFile(ref, "src/new.ts", "main"))?.content).toBe("n");
    expect(await svc.listPullRequests(ref)).toHaveLength(0);
  });

  it("28 merge with a stale expected SHA is refused and main is unchanged", async () => {
    makeRepo({ "README.md": "x" });
    const main = await head();
    await svc.createBranch(ref, "feat", main);
    await svc.commit(ref, "feat", "v1", [{ path: "src/a.ts", content: "1" }], main);
    const pr = await svc.createPullRequest(ref, "T", "", "feat", "main");
    const reviewed = await head("feat");
    await svc.commit(ref, "feat", "v2", [{ path: "src/a.ts", content: "2" }], reviewed);
    const res = await svc.mergePullRequest(ref, pr.number, { sha: reviewed });
    expect(res.merged).toBe(false);
    expect(res.message).toMatch(/moved/);
    expect(await head("main")).toBe(main);
  });

  it("29 a conflicting merge is refused cleanly and main is unchanged", async () => {
    makeRepo({ "README.md": "line" });
    const base = await head();
    await svc.createBranch(ref, "feat", base);
    await svc.commit(ref, "feat", "feat edit", [{ path: "README.md", content: "feat side" }], base);
    await svc.commit(ref, "main", "main edit", [{ path: "README.md", content: "main side" }], base);
    const mainBefore = await head("main");
    const pr = await svc.createPullRequest(ref, "T", "", "feat", "main");
    const res = await svc.mergePullRequest(ref, pr.number, { method: "squash" });
    expect(res.merged).toBe(false);
    expect(res.message).toMatch(/conflict/i);
    expect(await head("main")).toBe(mainBefore);
    expect(existsSync(join(repoDir(), ".git", "worktrees"))).toBe(false);
  });

  it("30 method 'merge' keeps both parents; getChecks passes a real commit and fails an unknown SHA", async () => {
    const dir = makeRepo({ "README.md": "x" });
    const main = await head();
    await svc.createBranch(ref, "feat", main);
    await svc.commit(ref, "feat", "feat", [{ path: "src/m.ts", content: "m" }], main);
    const pr = await svc.createPullRequest(ref, "T", "", "feat", "main");
    const res = await svc.mergePullRequest(ref, pr.number, { method: "merge" });
    expect(res.merged).toBe(true);
    expect(git(dir, "rev-list", "--parents", "-n", "1", res.sha!).split(" ")).toHaveLength(3);

    const ok = await svc.getChecks(ref, res.sha!);
    expect(ok.some((c) => c.name === "local-git-integrity" && c.status === "success")).toBe(true);
    const bad = await svc.getChecks(ref, "f".repeat(40));
    expect(bad[0].status).toBe("failure");
  });
});
