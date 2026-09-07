import type {
  IGitHubService,
  GithubRepoRef,
  GithubRepository,
  GithubViewer,
  GithubBranch,
  GithubCommit,
  GithubCheck,
  GithubPullRequest,
  GithubIssue,
  GithubRelease,
  GithubFile,
  GithubTreeEntry,
  ListRepositoriesOptions,
  CreateRepositoryOptions,
} from "./types.js";
import { logger } from "../logger.js";

export interface RealGitHubServiceOptions {
  /**
   * Token resolver. Defaults to `GITHUB_TOKEN` from the environment. A
   * per-user adapter passes the user's OAuth access token instead so the
   * repository list reflects *their* GitHub account.
   */
  token?: string | (() => string | undefined);
  /** Override the API base (GitHub Enterprise). */
  baseUrl?: string;
  /** Label used in errors/logs ("server token" vs. "user session"). */
  label?: string;
  /** Injectable fetch (tests / proxies). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Thrown when GitHub rejects the credential (401/403) — callers map this to actionable UI hints. */
export class GitHubAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

const MAX_PAGE = 100;

/**
 * GitHub REST API adapter. Requires a GitHub token (server `GITHUB_TOKEN` via the
 * secret manager, or a user OAuth token). All operations are performed through
 * `fetch` against the REST API, keeping the platform free of SDK coupling. A
 * GitHub App installation could supply an installation token via the same
 * interface.
 */
export class RealGitHubService implements IGitHubService {
  readonly kind = "real" as const;
  private base: string;
  private readonly tokenSource: () => string | undefined;
  private readonly label: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RealGitHubServiceOptions = {}) {
    this.base = (opts.baseUrl ?? process.env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/$/, "");
    const t = opts.token;
    // NOTE: GITHUB_CLIENT_SECRET is an OAuth *app secret*, never an API token —
    // only GITHUB_TOKEN (PAT / OAuth user token / App installation token) works here.
    this.tokenSource = typeof t === "function" ? t : t ? () => t : () => process.env.GITHUB_TOKEN;
    this.label = opts.label ?? "GITHUB_TOKEN";
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private getToken(): string {
    const token = this.tokenSource();
    if (!token) throw new GitHubAuthError(`GitHub token not configured (${this.label})`, 401);
    return token;
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.getToken()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "codevia-platform",
    };
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.base}${path}`;
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      if (res.status === 401 || res.status === 403) {
        throw new GitHubAuthError(`GitHub ${res.status} (${this.label}) ${url}: ${text}`, res.status);
      }
      throw Object.assign(new Error(`GitHub ${res.status} ${url}: ${text}`), { status: res.status });
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    return (await res.json()) as T;
  }

  /** Follow `Link: <…>; rel="next"` pagination up to `limit` items. */
  private async paginate<T>(path: string, limit: number): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    while (next && out.length < limit) {
      const res: Response = await this.request(next);
      const page = (await res.json()) as T[];
      out.push(...page);
      next = parseNextLink(res.headers.get("link"));
    }
    return out.slice(0, limit);
  }

  async getViewer(): Promise<GithubViewer> {
    const res = await this.request("/user");
    const u = (await res.json()) as { login: string; name?: string | null };
    const scopes = (res.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { login: u.login, name: u.name ?? undefined, scopes };
  }

  async listRepositories(opts: ListRepositoriesOptions = {}): Promise<GithubRepository[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 300, 1000));
    // `affiliation=owner,collaborator,organization_member` returns every repo
    // the token can see (private ones require the `repo` scope). Sorted by
    // most recently pushed so the relevant repos surface first.
    const raw = await this.paginate<RawRepo>(
      `/user/repos?per_page=${MAX_PAGE}&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member`,
      limit,
    );
    const q = (opts.query ?? "").trim().toLowerCase();
    return raw
      .map(toRepository)
      .filter((r) => !q || r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q));
  }

  async createRepository(opts: CreateRepositoryOptions): Promise<GithubRepository> {
    const name = opts.name.trim();
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Invalid repository name "${name}"`);
    const payload: Record<string, unknown> = {
      name,
      description: opts.description ?? "",
      private: !!opts.private,
      auto_init: opts.autoInit !== false,
      default_branch: opts.defaultBranch ?? "main",
    };
    if (opts.owner) payload.owner = opts.owner;
    const raw = await this.json<RawRepo>(`/user/repos`, { method: "POST", body: JSON.stringify(payload) });
    return toRepository(raw);
  }

  /** Recursively list repository files under `path` (default root) via the contents API. */
  async listFiles(repo: GithubRepoRef, branch?: string, path?: string): Promise<GithubTreeEntry[]> {
    const out: GithubTreeEntry[] = [];
    const seen = new Set<string>();
    const q = branch ? `?ref=${encodeURIComponent(branch)}` : "";
    const walk = async (dir: string): Promise<void> => {
      const urlPath = dir ? dir.replace(/^\/+|\/+$/g, "") : "";
      const res = await this.request(`/repos/${repo.owner}/${repo.name}/contents/${urlPath.split("/").map(encodeURIComponent).join("/")}${q}`);
      const body = (await res.json()) as Array<{ path: string; type: string; size?: number }>;
      if (!Array.isArray(body)) throw new Error("GitHub did not return a directory listing");
      if (body.length >= 1000) throw new Error("GitHub Contents API directory limit reached; refusing an incomplete listing");
      for (const item of body) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        const directory = item.type === "dir" || item.type === "tree";
        out.push({ path: item.path, type: directory ? "tree" : "blob", size: item.size });
        if (directory && out.length < 8000) await walk(item.path);
        if (out.length >= 8000) return;
      }
    };
    await walk(path ?? "");
    if (out.length >= 8000) throw new Error("GitHub tree limit reached; refusing a truncated listing");
    return out;
  }

  async listBranches(repo: GithubRepoRef): Promise<GithubBranch[]> {
    const res = await this.paginate<{ name: string; commit: { sha: string } }>(
      `/repos/${repo.owner}/${repo.name}/branches?per_page=${MAX_PAGE}`,
      500,
    );
    return res.map((b) => ({ name: b.name, sha: b.commit.sha }));
  }

  async listCommits(repo: GithubRepoRef, branch?: string): Promise<GithubCommit[]> {
    const q = branch ? `?sha=${encodeURIComponent(branch)}&per_page=30` : "?per_page=30";
    const res = await this.json<
      Array<{
        sha: string;
        commit: { message: string; author: { name: string; date: string } };
      }>
    >(`/repos/${repo.owner}/${repo.name}/commits${q}`);
    return res.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name ?? "unknown",
      date: c.commit.author?.date ?? "",
    }));
  }

  async listPullRequests(repo: GithubRepoRef): Promise<GithubPullRequest[]> {
    const res = await this.json<
      Array<{
        number: number;
        title: string;
        state: string;
        head: { ref: string };
        base: { ref: string };
        html_url: string;
        created_at: string;
      }>
    >(`/repos/${repo.owner}/${repo.name}/pulls?state=open&per_page=50`);
    return res.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      head: p.head.ref,
      base: p.base.ref,
      htmlUrl: p.html_url,
      createdAt: p.created_at,
    }));
  }

  async listIssues(repo: GithubRepoRef): Promise<GithubIssue[]> {
    const res = await this.json<
      Array<{ number: number; title: string; state: string; html_url: string; pull_request?: unknown }>
    >(`/repos/${repo.owner}/${repo.name}/issues?state=open&per_page=50`);
    // The issues endpoint also returns PRs — keep only real issues.
    return res
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, title: i.title, state: i.state, htmlUrl: i.html_url }));
  }

  async listReleases(repo: GithubRepoRef): Promise<GithubRelease[]> {
    const res = await this.json<
      Array<{ tag_name: string; name: string; body: string; created_at: string }>
    >(`/repos/${repo.owner}/${repo.name}/releases?per_page=20`);
    return res.map((r) => ({ tag: r.tag_name, name: r.name, body: r.body ?? "", createdAt: r.created_at }));
  }

  async getFile(repo: GithubRepoRef, path: string, branch?: string): Promise<GithubFile | undefined> {
    try {
      const q = branch ? `?ref=${encodeURIComponent(branch)}` : "";
      const res = await this.json<{ content: string; sha: string }>(`/repos/${repo.owner}/${repo.name}/contents/${path.split("/").map(encodeURIComponent).join("/")}${q}`);
      return { path, content: Buffer.from(res.content, "base64").toString("utf8"), sha: res.sha };
    } catch (err) {
      if ((err as { status?: number }).status === 404) return undefined;
      throw err;
    }
  }

  async createBranch(repo: GithubRepoRef, name: string, baseSha: string): Promise<GithubBranch> {
    await this.json(`/repos/${repo.owner}/${repo.name}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${name}`, sha: baseSha }),
    });
    return { name, sha: baseSha };
  }

  async commit(
    repo: GithubRepoRef,
    branch: string,
    message: string,
    files: GithubFile[],
    parentSha?: string,
  ): Promise<GithubCommit> {
    const branchData = (await this.json<{ commit: { sha: string } }>(
      `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(branch)}`,
    )) as { commit: { sha: string } } | undefined;
    const sha = branchData?.commit.sha;
    if (!sha) throw new Error("Cannot commit: branch has no HEAD sha");
    if (parentSha && parentSha !== sha) throw new Error("Repository changed after inspection; refusing to overwrite newer work. Retry with fresh context.");
    const parent = await this.json<{ tree: { sha: string } }>(`/repos/${repo.owner}/${repo.name}/git/commits/${sha}`);

    const tree = files.map((f) => ({
      path: f.path,
      mode: "100644",
      type: "blob",
      content: f.content,
    }));
    const treeRes = await this.json<{ sha: string }>(`/repos/${repo.owner}/${repo.name}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
    });
    const commitRes = await this.json<{ sha: string }>(`/repos/${repo.owner}/${repo.name}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message, tree: treeRes.sha, parents: [sha] }),
    });
    await this.json(`/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commitRes.sha, force: false }),
    });
    return { sha: commitRes.sha, message, author: "codevia-agent", date: new Date().toISOString() };
  }

  async createPullRequest(repo: GithubRepoRef, title: string, body: string, head: string, base: string, opts: { draft?: boolean } = {}): Promise<GithubPullRequest> {
    const res = await this.json<{
      number: number;
      title: string;
      state: string;
      head: { ref: string };
      base: { ref: string };
      html_url: string;
      created_at: string;
    }>(`/repos/${repo.owner}/${repo.name}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, body, head, base, draft: opts.draft ?? false }),
    });
    return {
      number: res.number,
      draft: opts.draft ?? false,
      title: res.title,
      state: res.state,
      head: res.head.ref,
      base: res.base.ref,
      htmlUrl: res.html_url,
      createdAt: res.created_at,
    };
  }

  async getChecks(repo: GithubRepoRef, sha: string): Promise<GithubCheck[]> {
    const prefix = `/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(sha)}`;
    const [checks, statuses] = await Promise.all([
      this.json<{ total_count: number; check_runs: Array<{ name: string; status: string; conclusion?: string; html_url?: string; output?: { title?: string; summary?: string } }> }>(`${prefix}/check-runs?per_page=100&filter=latest`),
      this.json<{ total_count: number; statuses: Array<{ context: string; state: string; description?: string; target_url?: string }> }>(`${prefix}/status?per_page=100`),
    ]);
    if (checks.total_count > 100 || statuses.total_count > 100) throw new Error("CI check list is incomplete (more than 100 checks); refusing partial verification");
    return [
      ...checks.check_runs.map((c): GithubCheck => ({
        name: c.name,
        status: c.status !== "completed" ? "pending" : c.conclusion === "success" ? "success" : ["skipped", "neutral"].includes(c.conclusion ?? "") ? "skipped" : "failure",
        detail: [c.output?.title, c.output?.summary].filter(Boolean).join("\n").slice(0, 4000),
        url: c.html_url,
      })),
      ...statuses.statuses.map((c): GithubCheck => ({ name: c.context, status: c.state === "success" ? "success" : c.state === "pending" ? "pending" : "failure", detail: c.description, url: c.target_url })),
    ];
  }

  async mergePullRequest(repo: GithubRepoRef, number: number, opts: { method?: "merge" | "squash" | "rebase"; commitTitle?: string } = {}): Promise<{ merged: boolean; sha?: string; message?: string }> {
    const res = await this.request(`/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`, {
      method: "PUT",
      body: JSON.stringify({ merge_method: opts.method ?? "squash", commit_title: opts.commitTitle }),
    });
    const body = (await res.json().catch(() => ({}))) as { merged?: boolean; sha?: string; message?: string };
    return { merged: Boolean(body.merged), sha: body.sha, message: body.message };
  }

  async updatePullRequest(repo: GithubRepoRef, number: number, patch: Partial<{ title: string; body: string; state: string }>): Promise<GithubPullRequest> {
    const res = await this.json<{ number: number; title: string; state: string }>(
      `/repos/${repo.owner}/${repo.name}/pulls/${number}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    return {
      number: res.number,
      title: res.title,
      state: res.state,
      head: "",
      base: "",
      htmlUrl: "",
      createdAt: "",
    };
  }

  async createIssue(repo: GithubRepoRef, title: string, body: string): Promise<GithubIssue> {
    const res = await this.json<{ number: number; title: string; state: string; html_url: string }>(
      `/repos/${repo.owner}/${repo.name}/issues`,
      { method: "POST", body: JSON.stringify({ title, body }) },
    );
    return { number: res.number, title: res.title, state: res.state, htmlUrl: res.html_url };
  }

  async commentOnIssue(repo: GithubRepoRef, number: number, body: string): Promise<void> {
    await this.json(`/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async commentOnPullRequest(repo: GithubRepoRef, number: number, body: string): Promise<void> {
    await this.json(`/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }
}

interface RawRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  description?: string | null;
  html_url?: string;
  language?: string | null;
  pushed_at?: string;
  updated_at?: string;
  archived?: boolean;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}

function toRepository(r: RawRepo): GithubRepository {
  return {
    owner: r.owner?.login ?? r.full_name.split("/")[0],
    name: r.name ?? r.full_name.split("/")[1],
    fullName: r.full_name,
    private: !!r.private,
    defaultBranch: r.default_branch || "main",
    description: r.description ?? undefined,
    htmlUrl: r.html_url,
    language: r.language ?? undefined,
    updatedAt: r.pushed_at ?? r.updated_at,
    archived: !!r.archived,
    permissions: r.permissions,
  };
}

/** Extract the `rel="next"` URL from a GitHub `Link` header. */
export function parseNextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1];
  }
  return undefined;
}
