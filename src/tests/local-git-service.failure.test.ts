import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalGitService } from "../github/local-git-service.js";
import { LocalGitError } from "../github/local-git-error.js";
import { logger } from "../logger.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn() })) },
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

function makeRepo(files: Record<string, string> = { "README.md": "x" }): string {
  const dir = repoDir();
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}

const head = async (branch = "main") => (await svc.listBranches(ref)).find((b) => b.name === branch)!.sha;
const asError = async (p: Promise<unknown>): Promise<LocalGitError> => {
  try {
    await p;
  } catch (err) {
    return err as LocalGitError;
  }
  throw new Error("expected the promise to reject");
};

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "cv-fail-"));
  svc = new LocalGitService({ rootDir: root, defaultOwner: "local", autoPush: false, autoFetch: false });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * Crash / failure scenarios for LocalGitService, mirroring the
 * recovery analysis: A (crash mid-commit), B (stale lock files),
 * C (index.lock during working-tree sync), D (missing git binary),
 * E (corrupt metadata), F (unreachable remote), G (worktree leaks).
 * ------------------------------------------------------------------ */

describe("LocalGit failure scenarios", () => {
  it("A: a crash between commit-tree and update-ref leaves the branch untouched (dangling commit only)", async () => {
    const dir = makeRepo();
    const before = await head();
    // Directly exercise the plumbing step that would be interrupted: the
    // commit object is created, but update-ref never runs (process "crashed").
    const internal = svc as unknown as {
      commitViaIndex(
        repoDir: string,
        parent: string,
        message: string,
        adds: Array<{ path: string; content: string }>,
        removes: string[],
      ): Promise<{ sha: string; author: string }>;
    };
    const { sha } = await internal.commitViaIndex(dir, before, "dangling", [{ path: "CodeVia/d.md", content: "d" }], []);
    expect(sha).not.toBe(before);
    expect(await head()).toBe(before); // the branch never moved
    // The dangling commit is harmless: it is not on main, and a normal commit
    // right after still works.
    const res = await svc.commit(ref, "main", "real", [{ path: "CodeVia/r.md", content: "r" }], before);
    expect(await head()).toBe(res.sha);
    expect(git(dir, "rev-list", "--count", "main")).toBe("2"); // init + the real commit only
  });

  it("B1: a STALE ref lock (older than the threshold) is removed and the commit succeeds", async () => {
    makeRepo();
    const lockPath = join(repoDir(), ".git", "refs", "heads", "main.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "", "utf8");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(lockPath, twoHoursAgo, twoHoursAgo);

    const res = await svc.commit(ref, "main", "after stale lock", [{ path: "CodeVia/x.md", content: "x" }]);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(lockPath)).toBe(false); // the stale lock was cleaned up
    expect((await svc.getFile(ref, "CodeVia/x.md", "main"))?.content).toBe("x");
    expect(vi.mocked(logger.warn)).toHaveBeenCalled(); // the recovery was logged
  });

  it("B2: a FRESH lock fails with LOCAL_LOCKED (retryable) and the branch does not move", async () => {
    makeRepo();
    const before = await head();
    const lockPath = join(repoDir(), ".git", "refs", "heads", "main.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "", "utf8"); // fresh — another process may own it

    const err = await asError(svc.commit(ref, "main", "blocked", [{ path: "CodeVia/x.md", content: "x" }]));
    expect(err.code).toBe("LOCAL_LOCKED");
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(423);
    expect(err.message).toMatch(/lock/i);
    expect(await head()).toBe(before); // nothing was committed
    expect(existsSync(lockPath)).toBe(true); // we did not delete a live lock
  });

  it("C: index.lock held during the working-tree sync → committed:true with the sha, branch moved", async () => {
    makeRepo();
    const before = await head();
    const indexLock = join(repoDir(), ".git", "index.lock");
    writeFileSync(indexLock, "", "utf8"); // e.g. the IDE is mid-operation

    const err = await asError(
      svc.commit(ref, "main", "state", [{ path: "CodeVia/project.md", content: "p" }], before),
    );
    expect(err.code).toBe("LOCAL_LOCKED");
    expect(err.committed).toBe(true); // the caller must NOT think the commit failed
    expect(err.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await head()).toBe(err.sha); // the branch DID advance
    expect((await svc.getFile(ref, "CodeVia/project.md", "main"))?.content).toBe("p");

    // Retrying with the pre-crash parent is a clean, explicit stale-parent error:
    const retry = await asError(svc.commit(ref, "main", "retry", [{ path: "CodeVia/q.md", content: "q" }], before));
    expect(retry.code).toBe("LOCAL_STALE_PARENT");

    rmSync(indexLock);
    // after the lock is gone, the next commit to the same path heals the working
    // tree: the "staged deletion, no file on disk" residue is recognized as
    // healable rather than as the developer's data:
    await svc.commit(ref, "main", "heal", [{ path: "CodeVia/project.md", content: "p" }]);
    expect(readFileSync(join(repoDir(), "CodeVia", "project.md"), "utf8")).toBe("p");
    expect(git(repoDir(), "status", "--porcelain")).toBe(""); // fully reconciled
  });

  it("D: a missing git binary fails fast with LOCAL_GIT_UNAVAILABLE (503) on every entry point", async () => {
    makeRepo();
    const broken = new LocalGitService({ rootDir: root, gitBin: "/nonexistent/git-binary-xyz" });
    const err = await asError(broken.listBranches(ref));
    expect(err.code).toBe("LOCAL_GIT_UNAVAILABLE");
    expect(err.statusCode).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/LOCAL_GIT_BIN|Install Git/i);
    // every entry point shares the same cached verdict — no misleading downstream errors:
    await expect(broken.getViewer()).rejects.toMatchObject({ code: "LOCAL_GIT_UNAVAILABLE" });
    await expect(broken.listRepositories()).rejects.toMatchObject({ code: "LOCAL_GIT_UNAVAILABLE" });
  });

  it("E: corrupt metadata is reported as LOCAL_META_CORRUPT and NEVER silently reset", async () => {
    makeRepo();
    await svc.createBranch(ref, "feat", await head());
    const metaFile = join(repoDir(), ".git", "codevia-local-meta.json");
    writeFileSync(metaFile, "{ not valid json !!", "utf8");

    const err = await asError(svc.createPullRequest(ref, "T", "", "feat", "main"));
    expect(err.code).toBe("LOCAL_META_CORRUPT");
    expect(err.statusCode).toBe(500);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/codevia-local-meta\.json/);
    // the corrupt file was NOT overwritten (PR #1 was not silently erased):
    expect(readFileSync(metaFile, "utf8")).toBe("{ not valid json !!");

    // commits keep working — they never needed the metadata:
    await svc.commit(ref, "main", "unaffected", [{ path: "CodeVia/u.md", content: "u" }]);

    // after the operator restores a valid file, PRs work again and writes are backed up:
    writeFileSync(metaFile, JSON.stringify({ pulls: [], issues: [], releases: [] }), "utf8");
    const pr = await svc.createPullRequest(ref, "T2", "", "feat", "main");
    expect(pr.number).toBe(1);
    expect(existsSync(`${metaFile}.bak`)).toBe(true);
  });

  it("F: a failed push is a warning — the commit succeeds and stays local", async () => {
    makeRepo();
    const pushSvc = new LocalGitService({ rootDir: root, defaultOwner: "local", autoPush: true, autoFetch: false });
    git(repoDir(), "remote", "add", "origin", join(root, "no-such-remote.git")); // unreachable

    const res = await pushSvc.commit(ref, "main", "offline commit", [{ path: "CodeVia/a.md", content: "a" }]);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await pushSvc.getFile(ref, "CodeVia/a.md", "main"))?.content).toBe("a");
    expect(vi.mocked(logger.warn)).toHaveBeenCalled(); // surfaced, not swallowed
    expect(await head()).toBe(res.sha);
  });

  it("G: merges never create (or leak) git worktree metadata", async () => {
    makeRepo();
    const base = await head();
    for (let i = 0; i < 3; i++) {
      await svc.createBranch(ref, `g${i}`, base);
      await svc.commit(ref, `g${i}`, `g${i}`, [{ path: `src/g${i}.ts`, content: "g" }], base);
      const pr = await svc.createPullRequest(ref, `g${i}`, "", `g${i}`, "main");
      const res = await svc.mergePullRequest(ref, pr.number, { method: "merge" });
      expect(res.merged).toBe(true);
    }
    expect(existsSync(join(repoDir(), ".git", "worktrees"))).toBe(false);
    expect(git(repoDir(), "worktree", "list")).not.toMatch(/codevia-/);
    // init + (branch commit + merge commit) × 3 — merges keep both parents:
    expect(git(repoDir(), "rev-list", "--count", "main")).toBe("7");
  });

  it("H: dirty local files are never overwritten by a state commit (skip + warn, ref still advances)", async () => {
    const dir = makeRepo();
    // the developer hand-edited a state file without committing it:
    mkdirSync(join(dir, "CodeVia"), { recursive: true });
    writeFileSync(join(dir, "CodeVia", "project.md"), "developer's uncommitted edit");

    const res = await svc.commit(ref, "main", "state", [{ path: "CodeVia/project.md", content: "agent version" }]);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    // the ref moved and the agent version is what git serves:
    expect((await svc.getFile(ref, "CodeVia/project.md", "main"))?.content).toBe("agent version");
    // but the developer's uncommitted bytes on disk were preserved:
    expect(readFileSync(join(dir, "CodeVia", "project.md"), "utf8")).toBe("developer's uncommitted edit");
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("I: a concurrent merge and PR creation never lose each other's metadata write", async () => {
    makeRepo();
    const base = await head();
    for (const b of ["f1", "f2", "f3"]) await svc.createBranch(ref, b, base);
    await svc.commit(ref, "f1", "c1", [{ path: "src/1.ts", content: "1" }], base);
    await svc.commit(ref, "f2", "c2", [{ path: "src/2.ts", content: "2" }], base);
    const pr1 = await svc.createPullRequest(ref, "T1", "", "f1", "main");
    await svc.createPullRequest(ref, "T2", "", "f2", "main");

    // Both rewrite codevia-local-meta.json — without the per-repo lock one
    // write silently erased the other (a merged PR springing back open, or a
    // created PR vanishing).
    const [mergeResult, pr3] = await Promise.all([
      svc.mergePullRequest(ref, pr1.number, { method: "squash" }),
      svc.createPullRequest(ref, "T3", "", "f3", "main"),
    ]);
    expect(mergeResult.merged).toBe(true);
    expect(pr3.number).toBe(3);
    expect((await svc.listPullRequests(ref)).map((p) => p.number).sort()).toEqual([2, 3]);
    // the merge really is recorded — not lost to the racing write:
    expect((await svc.getPullRequest(ref, pr1.number))?.state).toBe("merged");
  });

  it("J: a commit with 200 files lands correctly (batched argv — Windows E2BIG safety)", async () => {
    makeRepo({ "README.md": "x" });
    const files = Array.from({ length: 200 }, (_, i) => ({
      path: `src/mod${i}.ts`,
      content: `export const v${i} = ${i};\n`,
    }));
    const res = await svc.commit(ref, "main", "bulk commit", files);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    const listed = (await svc.listFiles(ref, "main", "src")).filter((e) => e.type === "blob");
    expect(listed).toHaveLength(200);
    expect((await svc.getFile(ref, "src/mod199.ts", "main"))?.content).toBe("export const v199 = 199;\n");
    // and the working tree got them all:
    expect(readFileSync(join(repoDir(), "src", "mod0.ts"), "utf8")).toBe("export const v0 = 0;\n");
  });
});
