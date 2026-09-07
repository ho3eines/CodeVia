import type {
  IGitHubService,
  GithubRepoRef,
  GithubRepository,
  GithubViewer,
  GithubBranch,
  GithubCommit,
  GithubPullRequest,
  GithubIssue,
  GithubRelease,
  GithubFile,
  GithubTreeEntry,
  ListRepositoriesOptions,
  CreateRepositoryOptions,
} from "./types.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Disk snapshot so mock repos (incl. the CodeVia/ project folder) survive restarts. Tests opt out via VITEST. */
function mockPersistPath(): string {
  return process.env.MOCK_GITHUB_PATH ?? "./data/mock-github.json";
}

interface MockRepo {
  ref: GithubRepoRef;
  branches: Map<string, string>; // branch -> head sha
  /** Per-branch file trees — like real git, branches are isolated from each other. */
  trees: Map<string, Map<string, GithubFile>>;
  commits: GithubCommit[];
  pulls: GithubPullRequest[];
  issues: GithubIssue[];
  releases: GithubRelease[];
  defaultBranch: string;
  description?: string;
  language?: string;
  private: boolean;
}

/** Demo repositories seeded into every mock instance so the repo picker is never empty offline. */
export const MOCK_DEMO_REPOS: Array<{ owner: string; name: string; description: string; language: string; private?: boolean }> = [
  { owner: "acme", name: "accounting", description: "Demo: .NET + SQL Server accounting system", language: "C#" },
  { owner: "acme", name: "storefront", description: "Demo: React + Node.js storefront", language: "TypeScript", private: true },
  { owner: "acme", name: "mobile-app", description: "Demo: Flutter mobile app", language: "Dart" },
];

/**
 * In-memory GitHub implementation. Provides the full operation surface for
 * development, tests, and Simulation Mode without requiring authentication or
 * network access. Configuration that would normally live in the real repository
 * (e.g. .ai-engineering/*) can be seeded here so workflows run end-to-end.
 */
export class MockGitHubService implements IGitHubService {
  readonly kind = "mock" as const;
  private repos = new Map<string, MockRepo>();
  private counter = 1;
  private snapshots = new WeakMap<MockRepo, Map<string, Map<string, GithubFile>>>();

  private remember(r: MockRepo, sha: string, files: Map<string, GithubFile>): void {
    let snapshots = this.snapshots.get(r);
    if (!snapshots) { snapshots = new Map(); this.snapshots.set(r, snapshots); }
    snapshots.set(sha, new Map(files));
  }
  private readonly persistEnabled: boolean;

  constructor(opts: { seedDemoRepos?: boolean; persist?: boolean } = {}) {
    this.persistEnabled = opts.persist ?? process.env.VITEST !== "true";
    if (this.persistEnabled) this.load();
    if (opts.seedDemoRepos !== false) {
      for (const d of MOCK_DEMO_REPOS) {
        this.seedRepo(d.owner, d.name, {
          description: d.description,
          language: d.language,
          private: d.private,
          files: [{ path: "README.md", content: `# ${d.name}\n\n${d.description}\n` }],
        });
      }
      // Seeding merges into (never wipes) loaded state; persist once afterwards.
      this.persist();
    }
  }

  /** Serialize repos to disk (best-effort, mock mode only). */
  private persist(): void {
    if (!this.persistEnabled) return;
    try {
      mkdirSync(dirname(mockPersistPath()), { recursive: true });
      const snap = [...this.repos.entries()].map(([key, r]) => [
        key,
        {
          ...r,
          branches: [...r.branches.entries()],
          trees: [...r.trees.entries()].map(([b, t]) => [b, [...t.entries()]]),
        },
      ]);
      writeFileSync(mockPersistPath(), JSON.stringify({ version: 2, repos: snap }));
    } catch {
      /* mock persistence must never break the platform */
    }
  }

  private load(): void {
    try {
      if (!existsSync(mockPersistPath())) return;
      const snap = JSON.parse(readFileSync(mockPersistPath(), "utf8")) as {
        version?: number;
        repos: Array<[string, Record<string, unknown>]>;
      };
      for (const [key, r] of snap.repos ?? []) {
        const rec = r as Omit<MockRepo, "branches" | "trees"> & {
          branches: Array<[string, string]>;
          trees?: Array<[string, Array<[string, GithubFile]>]>;
          files?: Array<[string, GithubFile]>;
        };
        // v1 snapshots had one shared file map → migrate it onto the default branch.
        const trees = new Map<string, Map<string, GithubFile>>();
        if (rec.trees) {
          for (const [b, entries] of rec.trees) trees.set(b, new Map(entries));
        } else if (rec.files) {
          trees.set(rec.defaultBranch ?? "main", new Map(rec.files));
        }
        const { files: _dropped, trees: _t, ...rest } = rec;
        void _dropped;
        void _t;
        this.repos.set(key, { ...rest, branches: new Map(rec.branches), trees });
      }
    } catch {
      /* corrupted snapshot → start clean */
    }
  }

  seedRepo(
    owner: string,
    name: string,
    opts?: { files?: GithubFile[]; branch?: string; description?: string; language?: string; private?: boolean },
  ): GithubRepoRef {
    const key = `${owner}/${name}`;
    const branch = opts?.branch ?? "main";
    const existing = this.repos.get(key);
    // Re-seeding an existing repo (e.g. onboarding a project onto a demo repo)
    // only adds missing files — it never wipes commits/PRs made by agents.
    if (existing) {
      const tree = this.tree(existing, branch);
      for (const f of opts?.files ?? []) if (!tree.has(f.path)) tree.set(f.path, f);
      if (!existing.branches.has(branch)) existing.branches.set(branch, existing.commits[0]?.sha ?? this.sha("seed"));
      if (opts?.description) existing.description = opts.description;
      this.persist();
      return existing.ref;
    }
    const tree = new Map<string, GithubFile>();
    for (const f of opts?.files ?? []) tree.set(f.path, f);
    const now = new Date().toISOString();
    const sha = this.sha("seed");
    const repo: MockRepo = {
      ref: { owner, name },
      branches: new Map([[branch, sha]]),
      trees: new Map([[branch, tree]]),
      commits: [{ sha, message: `seed ${name}`, author: "seed", date: now }],
      pulls: [],
      issues: [],
      releases: [],
      defaultBranch: branch,
      description: opts?.description,
      language: opts?.language,
      private: !!opts?.private,
    };
    this.repos.set(key, repo);
    this.persist();
    return { owner, name };
  }

  async getViewer(): Promise<GithubViewer> {
    return { login: "mock-user", name: "Mock GitHub User", scopes: ["repo", "read:user", "user:email"] };
  }

  private repo(ref: GithubRepoRef): MockRepo {
    const r = this.repos.get(`${ref.owner}/${ref.name}`);
    if (!r) throw new Error(`Mock repo not found: ${ref.owner}/${ref.name}`);
    return r;
  }

  /**
   * File tree for a branch. Unknown branches start as a copy of the default
   * branch (lenient like the rest of the mock — real git would reject them).
   */
  private tree(r: MockRepo, branch?: string): Map<string, GithubFile> {
    const name = branch || r.defaultBranch;
    if (!r.branches.has(name)) {
      const snapshot = this.snapshots.get(r)?.get(name);
      if (snapshot) return snapshot;
      const refBranch = [...r.branches.entries()].find(([, sha]) => sha === name)?.[0];
      if (refBranch) return new Map(this.tree(r, refBranch));
    }
    let t = r.trees.get(name);
    if (!t) {
      const base = r.trees.get(r.defaultBranch) ?? new Map<string, GithubFile>();
      t = new Map(base);
      r.trees.set(name, t);
    }
    return t;
  }

  private sha(input: string): string {
    let h = 0;
    for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
    return "0000000" + Math.abs(h).toString(16).slice(-7);
  }

  async createRepository(opts: CreateRepositoryOptions): Promise<GithubRepository> {
    const owner = opts.owner || "mock-user";
    const name = opts.name.trim();
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Invalid repository name "${name}"`);
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) throw new Error(`Repository already exists: ${key}`);
    const defaultBranch = opts.defaultBranch || "main";
    const now = new Date().toISOString();
    const sha = this.sha("create:" + key);
    const repo: MockRepo = {
      ref: { owner, name },
      branches: new Map([[defaultBranch, sha]]),
      trees: new Map([
        [
          defaultBranch,
          new Map(
            (opts.autoInit === false ? [] : [{ path: "README.md", content: `# ${name}\n\n${opts.description ?? ""}\n` }]).map((f) => [f.path, f] as [string, GithubFile]),
          ),
        ],
      ]),
      commits: [{ sha, message: `create ${name}`, author: "mock-user", date: now }],
      pulls: [],
      issues: [],
      releases: [],
      defaultBranch,
      description: opts.description,
      language: undefined,
      private: !!opts.private,
    };
    this.repos.set(key, repo);
    this.persist();
    return {
      owner,
      name,
      fullName: key,
      private: !!opts.private,
      defaultBranch,
      description: opts.description,
      htmlUrl: `https://github.com/${key}`,
      language: undefined,
      updatedAt: now,
      archived: false,
      permissions: { admin: true, push: true, pull: true },
    };
  }

  async listFiles(ref: GithubRepoRef, branch?: string, path?: string): Promise<GithubTreeEntry[]> {
    const r = this.repo(ref);
    const tree = this.tree(r, branch);
    const base = path && path !== "." ? (path.endsWith("/") ? path : path + "/") : "";
    return [...tree.keys()]
      .filter((p) => p.startsWith(base))
      .map((p) => ({ path: p, type: "blob", size: (tree.get(p)?.content ?? "").length }));
  }

  async listRepositories(opts: ListRepositoriesOptions = {}): Promise<GithubRepository[]> {
    const q = (opts.query ?? "").trim().toLowerCase();
    const list: GithubRepository[] = [...this.repos.values()].map((r) => ({
      owner: r.ref.owner,
      name: r.ref.name,
      fullName: `${r.ref.owner}/${r.ref.name}`,
      private: r.private,
      defaultBranch: r.defaultBranch,
      description: r.description,
      htmlUrl: `https://github.com/${r.ref.owner}/${r.ref.name}`,
      language: r.language,
      updatedAt: r.commits[0]?.date,
      archived: false,
      permissions: { admin: true, push: true, pull: true },
    }));
    const filtered = list.filter((r) => !q || r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q));
    return filtered.slice(0, Math.max(1, opts.limit ?? 300));
  }

  async listBranches(ref: GithubRepoRef): Promise<GithubBranch[]> {
    const r = this.repo(ref);
    return [...r.branches.entries()].map(([name, sha]) => ({ name, sha }));
  }

  async listCommits(ref: GithubRepoRef): Promise<GithubCommit[]> {
    return this.repo(ref).commits;
  }

  async listPullRequests(ref: GithubRepoRef): Promise<GithubPullRequest[]> {
    return this.repo(ref).pulls;
  }

  async listIssues(ref: GithubRepoRef): Promise<GithubIssue[]> {
    return this.repo(ref).issues;
  }

  async listReleases(ref: GithubRepoRef): Promise<GithubRelease[]> {
    return this.repo(ref).releases;
  }

  async getFile(ref: GithubRepoRef, path: string, branch?: string): Promise<GithubFile | undefined> {
    return this.tree(this.repo(ref), branch).get(path);
  }

  async createBranch(ref: GithubRepoRef, name: string, baseSha: string): Promise<GithubBranch> {
    const r = this.repo(ref);
    if (!r.branches.has(name)) {
      const source = new Map(this.tree(r, baseSha));
      r.branches.set(name, baseSha);
      // The new branch starts as a copy of whichever branch the base sha
      // belongs to (default branch when the sha is unknown).
      const baseBranch = [...r.branches.entries()].find(([, sha]) => sha === baseSha)?.[0] ?? r.defaultBranch;
      r.trees.set(name, source);
      this.remember(r, baseSha, source);
    }
    this.persist();
    return { name, sha: baseSha };
  }

  async commit(ref: GithubRepoRef, branch: string, message: string, files: GithubFile[], parentSha?: string): Promise<GithubCommit> {
    const r = this.repo(ref);
    if (parentSha && r.branches.get(branch) !== parentSha) throw new Error("Repository changed after inspection");
    const tree = this.tree(r, branch);
    const previousSha = r.branches.get(branch);
    if (previousSha) this.remember(r, previousSha, tree);
    for (const f of files) tree.set(f.path, f);
    const sha = this.sha(message + Date.now() + this.counter++);
    r.branches.set(branch, sha);
    this.remember(r, sha, tree);
    const commit: GithubCommit = { sha, message, author: "codevia-agent", date: new Date().toISOString() };
    r.commits.unshift(commit);
    this.persist();
    return commit;
  }

  async createPullRequest(ref: GithubRepoRef, title: string, body: string, head: string, base: string, opts: { draft?: boolean } = {}): Promise<GithubPullRequest> {
    const r = this.repo(ref);
    const pr: GithubPullRequest = {
      number: r.pulls.length + 1,
      draft: opts.draft,
      title,
      state: "open",
      head,
      base,
      htmlUrl: `https://github.com/${ref.owner}/${ref.name}/pull/${r.pulls.length + 1}`,
      createdAt: new Date().toISOString(),
    };
    r.pulls.unshift(pr);
    this.persist();
    return pr;
  }

  async updatePullRequest(ref: GithubRepoRef, number: number, patch: Partial<{ title: string; body: string; state: string }>): Promise<GithubPullRequest> {
    const r = this.repo(ref);
    const pr = r.pulls.find((p) => p.number === number);
    if (!pr) throw new Error(`PR #${number} not found`);
    if (patch.title) pr.title = patch.title;
    if (patch.state) pr.state = patch.state;
    this.persist();
    return pr;
  }

  async createIssue(ref: GithubRepoRef, title: string, body: string): Promise<GithubIssue> {
    const r = this.repo(ref);
    const issue: GithubIssue = {
      number: r.issues.length + 1,
      title,
      state: "open",
      htmlUrl: `https://github.com/${ref.owner}/${ref.name}/issues/${r.issues.length + 1}`,
    };
    r.issues.unshift(issue);
    this.persist();
    return issue;
  }

  async commentOnIssue(_ref: GithubRepoRef, _number: number, _body: string): Promise<void> {
    return;
  }

  async commentOnPullRequest(_ref: GithubRepoRef, _number: number, _body: string): Promise<void> {
    return;
  }

  async mergePullRequest(ref: GithubRepoRef, number: number, opts: { method?: "merge" | "squash" | "rebase"; commitTitle?: string } = {}): Promise<{ merged: boolean; sha?: string; message?: string }> {
    const r = this.repo(ref);
    const pr = r.pulls.find((p) => p.number === number);
    if (!pr) return { merged: false, message: `PR #${number} not found` };
    if (pr.state !== "open") return { merged: false, message: `PR #${number} is ${pr.state}` };
    const sha = this.sha(`merge-${number}-${Date.now()}`);
    // Merge = union of the head tree into the base tree (head wins).
    const base = this.tree(r, pr.base);
    for (const [p, f] of this.tree(r, pr.head)) base.set(p, f);
    r.branches.set(pr.base, sha);
    r.commits.unshift({ sha, message: opts.commitTitle ?? `Merge pull request #${number} (${opts.method ?? "merge"})`, author: "codevia-agent", date: new Date().toISOString() });
    pr.state = "merged";
    this.persist();
    return { merged: true, sha };
  }
}
