export interface GithubRepoRef {
  owner: string;
  name: string;
}

/** A repository as listed for a connected account (superset of GithubRepoRef). */
export interface GithubRepository extends GithubRepoRef {
  /** `owner/name` */
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description?: string;
  htmlUrl?: string;
  language?: string;
  updatedAt?: string;
  archived?: boolean;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}

export interface ListRepositoriesOptions {
  /** Case-insensitive substring filter on `owner/name`. */
  query?: string;
  /** Maximum number of repositories to return (default 300). */
  limit?: number;
}

/** The authenticated identity behind a GitHub connection. */
export interface GithubViewer {
  login: string;
  name?: string;
  /** OAuth scopes granted to the token (empty for installation tokens / mock). */
  scopes: string[];
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

/** Lightweight file-system entry returned by the repository tree API. */
export interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

export interface CreateRepositoryOptions {
  name: string;
  owner?: string;
  description?: string;
  private?: boolean;
  autoInit?: boolean;
  defaultBranch?: string;
}

/**
 * GitHub abstraction. Agents and platform services depend only on this interface,
 * not on a vendor SDK. Implementations: RealGitHubService (REST) and
 * MockGitHubService (in-memory, for dev/test/Simulation Mode).
 */
export interface IGitHubService {
  readonly kind: "real" | "mock";
  listRepositories(opts?: ListRepositoriesOptions): Promise<GithubRepository[]>;
  createRepository(opts: CreateRepositoryOptions): Promise<GithubRepository>;
  listFiles(repo: GithubRepoRef, branch?: string, path?: string): Promise<GithubTreeEntry[]>;
  getViewer(): Promise<GithubViewer>;
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
  /** Merge a pull request (dangerous — always approval-gated by the tool layer). */
  mergePullRequest(repo: GithubRepoRef, number: number, opts?: { method?: "merge" | "squash" | "rebase"; commitTitle?: string }): Promise<{ merged: boolean; sha?: string; message?: string }>;
}

/** Verified webhook payload + headers passed to the platform. */
export interface GithubWebhookEnvelope {
  event: string;
  /** HMAC-SHA256 signature header. */
  signature: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Parse `owner/name` into a repo ref (undefined when malformed). */
export function parseRepoFullName(fullName: string | undefined | null): GithubRepoRef | undefined {
  if (!fullName) return undefined;
  const trimmed = String(fullName).trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (!m) return undefined;
  return { owner: m[1], name: m[2] };
}
