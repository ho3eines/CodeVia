export interface GithubRepoRef {
  owner: string;
  name: string;
}

export interface GithubBranch {
  name: string;
  sha: string;
}

export interface GithubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface GithubPullRequest {
  number: number;
  title: string;
  state: string;
  head: string;
  base: string;
  htmlUrl: string;
  createdAt: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
}

export interface GithubRelease {
  tag: string;
  name: string;
  body: string;
  createdAt: string;
}

export interface GithubFile {
  path: string;
  content: string;
  sha?: string;
}

/**
 * GitHub abstraction. Agents and platform services depend only on this interface,
 * not on a vendor SDK. Implementations: RealGitHubService (REST) and
 * MockGitHubService (in-memory, for dev/test/Simulation Mode).
 */
export interface IGitHubService {
  readonly kind: "real" | "mock";
  listRepositories(): Promise<GithubRepoRef[]>;
  listBranches(repo: GithubRepoRef): Promise<GithubBranch[]>;
  listCommits(repo: GithubRepoRef, branch?: string): Promise<GithubCommit[]>;
  listPullRequests(repo: GithubRepoRef): Promise<GithubPullRequest[]>;
  listIssues(repo: GithubRepoRef): Promise<GithubIssue[]>;
  listReleases(repo: GithubRepoRef): Promise<GithubRelease[]>;
  getFile(repo: GithubRepoRef, path: string, branch?: string): Promise<GithubFile | undefined>;
  createBranch(repo: GithubRepoRef, name: string, baseSha: string): Promise<GithubBranch>;
  commit(
    repo: GithubRepoRef,
    branch: string,
    message: string,
    files: GithubFile[],
    parentSha?: string,
  ): Promise<GithubCommit>;
  createPullRequest(repo: GithubRepoRef, title: string, body: string, head: string, base: string): Promise<GithubPullRequest>;
  updatePullRequest(repo: GithubRepoRef, number: number, patch: Partial<{ title: string; body: string; state: string }>): Promise<GithubPullRequest>;
  createIssue(repo: GithubRepoRef, title: string, body: string): Promise<GithubIssue>;
  commentOnIssue(repo: GithubRepoRef, number: number, body: string): Promise<void>;
  commentOnPullRequest(repo: GithubRepoRef, number: number, body: string): Promise<void>;
}

/** Verified webhook payload + headers passed to the platform. */
export interface GithubWebhookEnvelope {
  event: string;
  /** HMAC-SHA256 signature header. */
  signature: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
