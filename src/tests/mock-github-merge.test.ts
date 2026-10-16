import { describe, it, expect, beforeEach } from "vitest";
import { MockGitHubService } from "../github/mock-service.js";
import type { GithubFile } from "../github/types.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------------ *
 * Mock merge fidelity (F5): the mock used to merge PRs as a union of
 * the head tree with "head wins". Files that advanced on the base
 * branch during the run (e.g. CodeVia/memory.md committed by the QA
 * phase) were silently clobbered by the branch's stale copy. With a
 * recorded fork point the merge is 3-way: only files the PR changed
 * are applied; same-file conflicts are refused like real git. Legacy
 * state without fork records keeps the previous union behavior.
 * ------------------------------------------------------------------ */

const ref = { owner: "demo", name: "merge" };
const f = (path: string, content: string): GithubFile => ({ path, content });

describe("MockGitHubService 3-way merge", () => {
  let gh: MockGitHubService;

  beforeEach(() => {
    gh = new MockGitHubService({ seedDemoRepos: false });
    gh.seedRepo("demo", "merge", { files: [f("README.md", "v1"), f("CodeVia/memory.md", "memory v1")] });
  });

  async function shaOf(branch: string): Promise<string> {
    return (await gh.listBranches(ref)).find((b) => b.name === branch)!.sha;
  }

  it("keeps files that advanced on the base branch after the fork (the F5 regression)", async () => {
    // The agent branch forks from main…
    await gh.createBranch(ref, "agent-task-1", await shaOf("main"));
    // …then the run continues committing to main (e.g. QA evidence)…
    await gh.commit(ref, "main", "update memory on main", [f("CodeVia/memory.md", "memory v2 — QA evidence")]);
    // …while the implementer only touches its own file on the branch.
    await gh.commit(ref, "agent-task-1", "implement feature", [f("src/feature.js", "// feature")]);

    const pr = await gh.createPullRequest(ref, "feature", "body", "agent-task-1", "main");
    const res = await gh.mergePullRequest(ref, pr.number, { method: "squash" });
    expect(res.merged).toBe(true);

    // The PR's file landed…
    expect((await gh.getFile(ref, "src/feature.js", "main"))?.content).toBe("// feature");
    // …and the newer memory on main SURVIVED the merge (it used to be reset
    // to the branch's stale "memory v1" copy).
    expect((await gh.getFile(ref, "CodeVia/memory.md", "main"))?.content).toBe("memory v2 — QA evidence");
  });

  it("refuses the merge when both sides changed the same file", async () => {
    await gh.createBranch(ref, "agent-task-2", await shaOf("main"));
    await gh.commit(ref, "main", "main edit", [f("README.md", "main v2")]);
    await gh.commit(ref, "agent-task-2", "branch edit", [f("README.md", "branch v2")]);

    const pr = await gh.createPullRequest(ref, "conflict", "body", "agent-task-2", "main");
    const res = await gh.mergePullRequest(ref, pr.number);
    expect(res.merged).toBe(false);
    expect(res.message).toMatch(/Merge conflict on: README\.md/);
    // The base branch is untouched by the refused merge.
    expect((await gh.getFile(ref, "README.md", "main"))?.content).toBe("main v2");
  });

  it("applies files changed on the branch and deletes files removed on the branch", async () => {
    await gh.createBranch(ref, "agent-task-3", await shaOf("main"));
    await gh.commit(ref, "agent-task-3", "change and remove", [f("README.md", "v1-edited")]);
    await gh.deleteFiles(ref, "agent-task-3", "remove stale doc", ["CodeVia/memory.md"]);

    const pr = await gh.createPullRequest(ref, "edit+delete", "body", "agent-task-3", "main");
    expect((await gh.mergePullRequest(ref, pr.number)).merged).toBe(true);
    expect((await gh.getFile(ref, "README.md", "main"))?.content).toBe("v1-edited");
    expect(await gh.getFile(ref, "CodeVia/memory.md", "main")).toBeUndefined();
  });

  it("falls back to the legacy head-wins union for branches without a fork record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-merge-legacy-"));
    const path = join(dir, "state.json");
    const prevEnv = process.env.MOCK_GITHUB_PATH;
    try {
      process.env.MOCK_GITHUB_PATH = path;
      const old = new MockGitHubService({ seedDemoRepos: false, persist: true });
      old.seedRepo("legacy", "repo", { files: [f("a.md", "fork")] });
      const legacyRef = { owner: "legacy", name: "repo" };
      const mainSha = (await old.listBranches(legacyRef)).find((b) => b.name === "main")!.sha;
      await old.createBranch(legacyRef, "feat", mainSha);
      await old.commit(legacyRef, "feat", "branch work", [f("a.md", "branch")]);

      // Rewrite the snapshot in the pre-fork format (no "forks" key), like an
      // older install's state file.
      const snap = JSON.parse(readFileSync(path, "utf8")) as { repos: Array<[string, Record<string, unknown>]> };
      for (const [, r] of snap.repos) delete r.forks;
      writeFileSync(path, JSON.stringify(snap));

      const loaded = new MockGitHubService({ seedDemoRepos: false, persist: true });
      const pr = await loaded.createPullRequest(legacyRef, "legacy", "body", "feat", "main");
      const res = await loaded.mergePullRequest(legacyRef, pr.number);
      expect(res.merged).toBe(true);
      // Legacy behavior: head wins.
      expect((await loaded.getFile(legacyRef, "a.md", "main"))?.content).toBe("branch");
    } finally {
      if (prevEnv === undefined) delete process.env.MOCK_GITHUB_PATH;
      else process.env.MOCK_GITHUB_PATH = prevEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
