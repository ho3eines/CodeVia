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

interface MockRepo {
  ref: GithubRepoRef;
  branches: Map<string, string>; // branch -> head sha
  files: Map<string, GithubFile>;
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

  constructor(opts: { seedDemoRepos?: boolean } = {}) {
    if (opts.seedDemoRepos !== false) {
      for (const d of MOCK_DEMO_REPOS) {
        this.seedRepo(d.owner, d.name, {
          description: d.description,
          language: d.language,
          private: d.private,
          files: [{ path: "README.md", content: `# ${d.name}\n\n${d.description}\n` }],
        });
      }
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
      for (const f of opts?.files ?? []) if (!existing.files.has(f.path)) existing.files.set(f.path, f);
      if (!existing.branches.has(branch)) existing.branches.set(branch, existing.commits[0]?.sha ?? this.sha("seed"));
      if (opts?.description) existing.description = opts.description;
      return existing.ref;
    }
    const files = new Map<string, GithubFile>();
    for (const f of opts?.files ?? []) files.set(f.path, f);
    const now = new Date().toISOString();
    const sha = this.sha("seed");
    const repo: MockRepo = {
      ref: { owner, name },
      branches: new Map([[branch, sha]]),
      files,
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
      files: new Map(
        (opts.autoInit === false ? [] : [{ path: "README.md", content: `# ${name}\n\n${opts.description ?? ""}\n` }]).map((f) => [f.path, f]),
      ),
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
    const base = path && path !== "." ? (path.endsWith("/") ? path : path + "/") : "";
    return [...r.files.keys()]
      .filter((p) => p.startsWith(base))
      .map((p) => ({ path: p, type: "blob", size: (r.files.get(p)?.content ?? "").length }));
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

  async getFile(ref: GithubRepoRef, path: string): Promise<GithubFile | undefined> {
    return this.repo(ref).files.get(path);
  }

  async createBranch(ref: GithubRepoRef, name: string, baseSha: string): Promise<GithubBranch> {
    const r = this.repo(ref);
    if (!r.branches.has(name)) r.branches.set(name, baseSha);
    return { name, sha: baseSha };
  }

  async commit(ref: GithubRepoRef, branch: string, message: string, files: GithubFile[]): Promise<GithubCommit> {
    const r = this.repo(ref);
    for (const f of files) r.files.set(f.path, f);
    const sha = this.sha(message + Date.now());
    r.branches.set(branch, sha);
    const commit: GithubCommit = { sha, message, author: "codevia-agent", date: new Date().toISOString() };
    r.commits.unshift(commit);
    return commit;
  }

  async createPullRequest(ref: GithubRepoRef, title: string, body: string, head: string, base: string): Promise<GithubPullRequest> {
    const r = this.repo(ref);
    const pr: GithubPullRequest = {
      number: r.pulls.length + 1,
      title,
      state: "open",
      head,
      base,
      htmlUrl: `https://github.com/${ref.owner}/${ref.name}/pull/${r.pulls.length + 1}`,
      createdAt: new Date().toISOString(),
    };
    r.pulls.unshift(pr);
    return pr;
  }

  async updatePullRequest(ref: GithubRepoRef, number: number, patch: Partial<{ title: string; body: string; state: string }>): Promise<GithubPullRequest> {
    const r = this.repo(ref);
    const pr = r.pulls.find((p) => p.number === number);
    if (!pr) throw new Error(`PR #${number} not found`);
    if (patch.title) pr.title = patch.title;
    if (patch.state) pr.state = patch.state;
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
    return issue;
  }

  async commentOnIssue(_ref: GithubRepoRef, _number: number, _body: string): Promise<void> {
    return;
  }

  async commentOnPullRequest(_ref: GithubRepoRef, _number: number, _body: string): Promise<void> {
    return;
  }
}
