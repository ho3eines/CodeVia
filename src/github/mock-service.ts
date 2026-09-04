import type {
  IGitHubService,
  GithubRepoRef,
  GithubBranch,
  GithubCommit,
  GithubPullRequest,
  GithubIssue,
  GithubRelease,
  GithubFile,
} from "./types.js";

interface MockRepo {
  ref: GithubRepoRef;
  branches: Map<string, string>; // branch -> head sha
  files: Map<string, GithubFile>;
  commits: GithubCommit[];
  pulls: GithubPullRequest[];
  issues: GithubIssue[];
  releases: GithubRelease[];
}

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

  seedRepo(owner: string, name: string, opts?: { files?: GithubFile[]; branch?: string }): GithubRepoRef {
    const key = `${owner}/${name}`;
    const branch = opts?.branch ?? "main";
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
    };
    this.repos.set(key, repo);
    return { owner, name };
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

  async listRepositories(): Promise<GithubRepoRef[]> {
    return [...this.repos.values()].map((r) => r.ref);
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
