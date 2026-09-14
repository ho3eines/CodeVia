import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RealGitHubService, GitHubAuthError } from "../github/real-service.js";
import { listRepoPaths, repoUnreadableNote } from "../github/repo-read.js";
import { buildRepoBriefDetailed } from "../agents/context.js";
import { projectChatEvidence } from "../agents/chat-evidence.js";
import { WorkspaceManager } from "../github/workspace.js";
import type { IGitHubService, GithubRepoRef, GithubTreeEntry, GithubFile } from "../github/types.js";
import type { Container } from "../app/container.js";
import type { Project } from "../domain/entities.js";

/* ------------------------------------------------------------------ *
 * "The AI cannot see my repository" — regression suite.
 *
 * Root causes fixed here:
 *   1. listFiles walked the Contents API one directory per request and
 *      never finished inside the chat's evidence budget on real repos;
 *      it now rides the single-request Git Trees API.
 *   2. A stale configured branch 404s exactly like a missing repo; the
 *      read path now heals onto the repository's default branch.
 *   3. When the repository is genuinely unreadable the model used to get
 *      NO evidence and invented a "404"; it now gets the exact cause and
 *      a hard instruction not to speculate.
 *   4. Clone-first: the chat reads from a local workspace copy whenever
 *      one is fresh, so repeated questions cost zero GitHub calls.
 * ------------------------------------------------------------------ */

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const REPO: GithubRepoRef = { owner: "acme", name: "widget" };

describe("RealGitHubService.listFiles via the trees API", () => {
  it("returns the whole recursive tree in one request", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      calls.push(String(input));
      return json({
        sha: "root",
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", size: 10 },
          { path: "src", type: "tree" },
          { path: "src/main.ts", type: "blob", size: 40 },
        ],
      });
    });
    const gh = new RealGitHubService({ token: "t", fetchImpl: fetcher });
    const entries = await gh.listFiles(REPO, "main");
    expect(entries).toEqual([
      { path: "README.md", type: "blob", size: 10 },
      { path: "src", type: "tree", size: undefined },
      { path: "src/main.ts", type: "blob", size: 40 },
    ]);
    expect(calls.filter((c) => c.includes("/git/trees/"))).toHaveLength(1);
  });

  it("falls back to the contents walk when the tree is truncated", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const u = new URL(String(input));
      if (u.pathname.includes("/git/trees/")) return json({ sha: "root", truncated: true, tree: [] });
      if (u.pathname.endsWith("/contents/src")) return json([{ path: "src/main.ts", type: "file", size: 40 }]);
      if (u.pathname.includes("/contents/"))
        return json([
          { path: "README.md", type: "file", size: 10 },
          { path: "src", type: "dir" },
        ]);
      return json({ message: "nope" }, 404);
    });
    const gh = new RealGitHubService({ token: "t", fetchImpl: fetcher });
    const entries = await gh.listFiles(REPO, "main");
    expect(entries.map((e) => e.path)).toEqual(["README.md", "src", "src/main.ts"]);
  });

  it("surfaces branch 404s unchanged so the caller can heal them", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/git/trees/")) return json({ message: "Not Found" }, 404);
      if (url.endsWith("/repos/acme/widget")) return json({ full_name: "acme/widget", default_branch: "master" });
      return json({ message: "nope" }, 404);
    });
    const gh = new RealGitHubService({ token: "t", fetchImpl: fetcher });
    await expect(gh.listFiles(REPO, "main")).rejects.toMatchObject({ status: 404 });
    expect(await gh.getRepository(REPO)).toEqual({
      fullName: "acme/widget",
      defaultBranch: "master",
      private: false,
    });
  });

  it("getRepository reports undefined for a missing repo (repo-not-found)", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ message: "Not Found" }, 404));
    const gh = new RealGitHubService({ token: "t", fetchImpl: fetcher });
    expect(await gh.getRepository(REPO)).toBeUndefined();
  });

  it("downloadTarball follows the codeload redirect while keeping the credential", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      seen.push({ url, auth });
      if (url.includes("/tarball"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://codeload.github.com/acme/widget/tar.gz/main" },
        });
      return new Response(Buffer.from("tarball-bytes"), { status: 200 });
    });
    const gh = new RealGitHubService({ token: "secret-token", fetchImpl: fetcher });
    const bytes = await gh.downloadTarball(REPO, "main");
    expect(Buffer.from(bytes).toString()).toBe("tarball-bytes");
    expect(seen).toHaveLength(2);
    // Both the API hop and the codeload hop carry the bearer credential —
    // a cross-origin redirect must not silently drop it (private repos).
    expect(seen[0].auth).toBe("Bearer secret-token");
    expect(seen[1].url).toContain("codeload.github.com");
    expect(seen[1].auth).toBe("Bearer secret-token");
  });
});

/** Scriptable fake adapter for read-path tests. */
function fakeService(opts: {
  kind?: "real" | "mock";
  files?: Record<string, string>;
  listStatus?: number;
  defaultBranch?: string;
  repoStatus?: number;
}): IGitHubService & { listCalls: number } {
  const state = { listCalls: 0 };
  const svc = {
    kind: opts.kind ?? "real",
    async listFiles(repo: GithubRepoRef, branch?: string): Promise<GithubTreeEntry[]> {
      state.listCalls += 1;
      if (opts.listStatus) throw Object.assign(new Error(`GitHub ${opts.listStatus}`), { status: opts.listStatus });
      // Like real GitHub: an unknown ref is a 404.
      if (opts.defaultBranch && branch !== opts.defaultBranch)
        throw Object.assign(new Error("GitHub 404"), { status: 404 });
      return Object.keys(opts.files ?? {}).map((path) => ({ path, type: "blob" as const }));
    },
    async getRepository(): Promise<{ fullName: string; defaultBranch: string; private: boolean } | undefined> {
      if (opts.repoStatus === 404) return undefined;
      if (opts.repoStatus) throw Object.assign(new Error(`GitHub ${opts.repoStatus}`), { status: opts.repoStatus });
      return { fullName: "acme/widget", defaultBranch: opts.defaultBranch ?? "main", private: false };
    },
    async getFile(repo: GithubRepoRef, path: string): Promise<GithubFile | undefined> {
      const content = opts.files?.[path];
      return content === undefined ? undefined : { path, content, sha: "blob" };
    },
  } as unknown as IGitHubService & { listCalls: number };
  return Object.assign(svc, state);
}

const baseProject = (_over: Partial<Project> = {}): Project =>
  ({
    id: "proj-w",
    slug: "widget",
    name: "Widget",
    configRepo: "acme/widget",
    branch: "main",
    githubConnection: undefined,
    settings: { rules: [] },
  }) as unknown as Project;

describe("listRepoPaths healing and classification", () => {
  it("heals a stale branch onto the repository default", async () => {
    const gh = fakeService({ files: { "README.md": "# w" }, defaultBranch: "master" });
    const res = await listRepoPaths(gh, REPO, "main");
    expect(res.ok).toBe(true);
    expect(res.branch).toBe("master");
    expect(res.fellBackToDefault).toBe(true);
    expect(res.paths).toEqual(["README.md"]);
  });

  it("reports repo-not-found when the repository itself is unreachable", async () => {
    const gh = fakeService({ listStatus: 404, repoStatus: 404 });
    const res = await listRepoPaths(gh, REPO, "main");
    expect(res.ok).toBe(false);
    expect(res.failure).toBe("repo-not-found");
  });

  it("reports auth failures for rejected credentials", async () => {
    const gh = {
      kind: "real",
      listFiles: async () => {
        throw new GitHubAuthError("GitHub 401 (token)", 401);
      },
    } as unknown as IGitHubService;
    const res = await listRepoPaths(gh, REPO, "main");
    expect(res.ok).toBe(false);
    expect(res.failure).toBe("auth");
  });
});

describe("buildRepoBriefDetailed", () => {
  it("assembles tree + README evidence when the repo is readable", async () => {
    const gh = fakeService({
      files: {
        "README.md": "# Widget — a gold-shop ERP",
        "package.json": '{"name":"widget"}',
        "src/app.ts": "export {}",
      },
    });
    const res = await buildRepoBriefDetailed({ github: gh, project: baseProject() });
    expect(res.ok).toBe(true);
    expect(res.brief).toContain("Repository files");
    expect(res.brief).toContain("# Widget — a gold-shop ERP");
    expect(res.brief).toContain('"name":"widget"');
  });

  it("states the exact failure instead of staying silent when the repo 404s", async () => {
    const gh = fakeService({ listStatus: 404, repoStatus: 404 });
    const res = await buildRepoBriefDetailed({ github: gh, project: baseProject() });
    expect(res.ok).toBe(false);
    expect(res.failure).toBe("repo-not-found");
    expect(res.brief).toContain("could NOT be read");
    expect(res.brief).toContain("acme/widget");
    expect(res.brief).toContain("HARD RULE");
    // The note must not claim a successful read of any file.
    expect(res.brief).not.toContain("Repository files");
  });
});

describe("projectChatEvidence (clone-first)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codevia-evidence-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function stubContainer(github: IGitHubService): Container {
    const kv = { get: () => undefined, set: () => undefined, delete: () => undefined, all: () => ({}) };
    return {
      githubForProject: () => github,
      workspaces: new WorkspaceManager({ rootDir: root, capabilities: { git: false, tar: false } }),
      kv,
    } as unknown as Container;
  }

  it("reads from the local workspace and then serves repeat questions from disk", async () => {
    const gh = fakeService({
      files: { "README.md": "# Widget", "src/x.ts": "export {}" },
    });
    const container = stubContainer(gh);
    const first = await projectChatEvidence(container, baseProject(), undefined, { workspaceWaitMs: 5000 });
    expect(first.source).toBe("workspace");
    expect(first.ok).toBe(true);
    expect(first.brief).toContain("# Widget");
    const callsAfterFirst = gh.listCalls;

    const second = await projectChatEvidence(container, baseProject(), undefined, { workspaceWaitMs: 5000 });
    expect(second.source).toBe("workspace");
    expect(second.brief).toContain("# Widget");
    // The fresh workspace answered from disk — zero additional listings.
    expect(gh.listCalls).toBe(callsAfterFirst);
  });

  it("falls back to the API and answers honestly when the clone fails", async () => {
    const gh = fakeService({ listStatus: 404, repoStatus: 404 });
    const container = stubContainer(gh);
    const res = await projectChatEvidence(container, baseProject(), undefined, { workspaceWaitMs: 2000 });
    expect(res.ok).toBe(false);
    expect(res.brief).toContain("could NOT be read");
  });

  it("surfaces a throwing credential resolution as an actionable note, not a crash", async () => {
    const container = {
      githubForProject: () => {
        throw new Error("GitHub OAuth is configured, but no user token is stored for project Widget.");
      },
      workspaces: new WorkspaceManager({ rootDir: root, capabilities: { git: false, tar: false } }),
      kv: { get: () => undefined, set: () => undefined, delete: () => undefined, all: () => ({}) },
    } as unknown as Container;
    const res = await projectChatEvidence(container, baseProject());
    expect(res.ok).toBe(false);
    expect(res.failure).toBe("auth");
    expect(res.brief).toContain("could NOT be read");
  });

  it("note builder never invents an HTTP error on its own", () => {
    const note = repoUnreadableNote({ repo: "acme/widget", branch: "main", failure: "timeout" });
    expect(note).toContain("did not respond in time");
    expect(note).not.toContain("404");
  });
});
