import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { WorkspaceManager } from "../github/workspace.js";
import { MockGitHubService } from "../github/mock-service.js";
import type { IGitHubService } from "../github/types.js";

/* ------------------------------------------------------------------ *
 * Local repository workspaces — the clone-first read layer.
 *
 * The chat and context surfaces must be able to see a project's real
 * code even when the GitHub Contents API is too slow or too limited:
 * the platform keeps a local shallow copy of the repository and reads
 * from disk. These tests cover all three materialisation strategies
 * (git clone, adapter file-by-file, mock), freshness reuse, refresh
 * propagation, failure cooldown and the traversal guard.
 * ------------------------------------------------------------------ */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codevia-ws-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Helper: build a real on-disk git repository to clone from. */
function makeSourceRepo(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "ws@test.local"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Workspace Test"]);
  for (const [p, content] of Object.entries(files)) {
    const target = join(dir, p);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "initial"]);
}

describe("WorkspaceManager", () => {
  it("materialises a mock repository through the adapter strategy", async () => {
    const gh = new MockGitHubService();
    gh.seedRepo("acme", "demo", {
      files: [
        { path: "README.md", content: "# demo project" },
        { path: "src/main.ts", content: "console.log('hi');" },
      ],
      branch: "main",
    });
    const ws = new WorkspaceManager({ rootDir: root, capabilities: { git: false, tar: false } });
    const handle = await ws.ensure({ repo: { owner: "acme", name: "demo" }, branch: "main", github: gh });
    expect(handle).toBeDefined();
    const paths = handle!.listFiles();
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/main.ts");
    expect(handle!.readFile("README.md")).toBe("# demo project");
    expect(handle!.meta.source).toBe("mock");
    // Traversal guard: nothing escapes the workspace root.
    expect(handle!.readFile("../../../../etc/passwd")).toBeUndefined();
    expect(handle!.readFile("nope.txt")).toBeUndefined();
  });

  it("reuses a fresh workspace without re-fetching and honours force", async () => {
    const gh = new MockGitHubService();
    gh.seedRepo("acme", "demo", { files: [{ path: "a.txt", content: "v1" }], branch: "main" });
    const ws = new WorkspaceManager({ rootDir: root, capabilities: { git: false, tar: false } });
    const first = await ws.ensure({ repo: { owner: "acme", name: "demo" }, branch: "main", github: gh });
    expect(first!.readFile("a.txt")).toBe("v1");

    // The remote changes — a fresh workspace must not see it yet…
    await gh.commit({ owner: "acme", name: "demo" }, "main", "v2", [{ path: "a.txt", content: "v2" }]);
    const cached = await ws.ensure({ repo: { owner: "acme", name: "demo" }, branch: "main", github: gh });
    expect(cached!.readFile("a.txt")).toBe("v1");
    // …until a forced refresh picks it up.
    const forced = await ws.ensure({ repo: { owner: "acme", name: "demo" }, branch: "main", github: gh, force: true });
    expect(forced!.readFile("a.txt")).toBe("v2");
    // peek sees the now-fresh content without any network.
    expect(ws.peek({ owner: "acme", name: "demo" }, "main")!.readFile("a.txt")).toBe("v2");
  });

  it("shallow-clones a real repository with git and updates it on refresh", async () => {
    const source = join(root, "source");
    makeSourceRepo(source, {
      "README.md": "# real repo\n",
      "src/app.py": "print('hello')\n",
    });
    // A minimal "real" adapter stub — the git strategy only needs kind + repo.
    const gh = { kind: "real" } as unknown as IGitHubService;
    const ws = new WorkspaceManager({
      rootDir: join(root, "workspaces"),
      capabilities: { git: true, tar: false },
      remoteUrlFor: () => pathToFileURL(source).href,
    });
    const handle = await ws.ensure({ repo: { owner: "acme", name: "real" }, branch: "main", github: gh });
    expect(handle).toBeDefined();
    expect(handle!.meta.source).toBe("git");
    expect(handle!.meta.head).toMatch(/^[0-9a-f]{40}$/);
    expect(handle!.readFile("README.md")).toBe("# real repo\n");
    expect(handle!.readFile("src/app.py")).toContain("hello");

    // Push a new commit upstream; a forced refresh must pull it in.
    writeFileSync(join(source, "src/app.py"), "print('hello v2')\n");
    execFileSync("git", ["-C", source, "add", "-A"]);
    execFileSync("git", ["-C", source, "commit", "-q", "-m", "v2"]);
    const updated = await ws.ensure({
      repo: { owner: "acme", name: "real" },
      branch: "main",
      github: gh,
      force: true,
    });
    expect(updated!.readFile("src/app.py")).toContain("hello v2");
  });

  it("materialises a snapshot via the tarball strategy when git is unavailable", async () => {
    // Build a GitHub-shaped tarball: one top-level `owner-repo-sha` directory.
    const srcStage = join(root, "tar-src");
    const inner = join(srcStage, "acme-widget-abc1234");
    mkdirSync(join(inner, "src"), { recursive: true });
    writeFileSync(join(inner, "README.md"), "# tarball repo\n");
    writeFileSync(join(inner, "src/app.py"), "print('tar')\n");
    const archive = join(root, "snap.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", srcStage, "acme-widget-abc1234"]);
    const tarBytes = readFileSync(archive);

    const gh = {
      kind: "real",
      downloadTarball: async () => new Uint8Array(tarBytes),
    } as unknown as IGitHubService;
    const ws = new WorkspaceManager({
      rootDir: join(root, "workspaces"),
      capabilities: { git: false, tar: true },
    });
    const handle = await ws.ensure({ repo: { owner: "acme", name: "widget" }, branch: "main", github: gh });
    expect(handle).toBeDefined();
    expect(handle!.meta.source).toBe("tarball");
    expect(handle!.meta.head).toBe("abc1234");
    expect(handle!.readFile("README.md")).toBe("# tarball repo\n");
    expect(handle!.readFile("src/app.py")).toContain("tar");
  });

  it("keeps a failure cooldown instead of retrying a broken remote on every message", async () => {
    let calls = 0;
    const broken = {
      kind: "mock",
      listFiles: async () => {
        calls += 1;
        throw Object.assign(new Error("boom"), { status: 500 });
      },
      getFile: async () => undefined,
    } as unknown as IGitHubService;
    const ws = new WorkspaceManager({
      rootDir: root,
      capabilities: { git: false, tar: false },
      failureCooldownMs: 60_000,
    });
    expect(
      await ws.ensure({ repo: { owner: "acme", name: "broken" }, branch: "main", github: broken }),
    ).toBeUndefined();
    expect(
      await ws.ensure({ repo: { owner: "acme", name: "broken" }, branch: "main", github: broken }),
    ).toBeUndefined();
    expect(calls).toBe(1); // second ensure hit the cooldown, not the remote
  });

  it("deduplicates concurrent ensures for the same repo@branch", async () => {
    const gh = new MockGitHubService();
    gh.seedRepo("acme", "demo", { files: [{ path: "a.txt", content: "x" }], branch: "main" });
    const ws = new WorkspaceManager({ rootDir: root, capabilities: { git: false, tar: false } });
    const [a, b] = await Promise.all([
      ws.ensure({ repo: { owner: "acme", name: "demo" }, branch: "main", github: gh }),
      ws.ensure({ repo: { owner: "acme", name: "demo" }, branch: "main", github: gh }),
    ]);
    expect(a!.root).toBe(b!.root);
    expect(readFileSync(join(a!.root, ".codevia-workspace.json"), "utf8")).toContain('"repo": "acme/demo"');
  });

  it("rejects unsafe repository names without touching the filesystem", async () => {
    const gh = new MockGitHubService();
    const ws = new WorkspaceManager({ rootDir: root, capabilities: { git: false, tar: false } });
    const handle = await ws.ensure({ repo: { owner: "..", name: "evil" }, branch: "main", github: gh });
    expect(handle).toBeUndefined();
    expect(existsSync(join(root, "..--evil"))).toBe(false);
  });
});
