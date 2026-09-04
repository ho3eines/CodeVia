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
import { getEnv } from "../config/env.js";
import { logger } from "../logger.js";

/**
 * GitHub REST API adapter. Requires a GitHub token from the environment (via the
 * secret manager). All operations are performed through `fetch` against the REST
 * API, keeping the platform free of SDK coupling. A GitHub App installation could
 * supply an installation token via the same interface.
 */
export class RealGitHubService implements IGitHubService {
  readonly kind = "real" as const;
  private base = "https://api.github.com";

  private getToken(): string {
    const token = process.env.GITHUB_TOKEN ?? process.env.GITHUB_CLIENT_SECRET;
    if (!token) throw new Error("GitHub token not configured (GITHUB_TOKEN)");
    return token;
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.getToken()}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await fetch(url, { ...init, headers: { ...this.headers(), ...(init?.headers ?? {}) } });
    if (!res.ok) throw new Error(`GitHub ${res.status} ${url}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  async listRepositories(): Promise<GithubRepoRef[]> {
    const res = await this.json<Array<{ full_name: string }>>("/user/repos?per_page=100");
    return res.map((r) => {
      const [owner, name] = r.full_name.split("/");
      return { owner, name };
    });
  }

  async listBranches(repo: GithubRepoRef): Promise<GithubBranch[]> {
    const res = await this.json<Array<{ name: string; commit: { sha: string } }>>(
      `/repos/${repo.owner}/${repo.name}/branches?per_page=100`,
    );
    return res.map((b) => ({ name: b.name, sha: b.commit.sha }));
  }

  async listCommits(repo: GithubRepoRef, branch?: string): Promise<GithubCommit[]> {
    const q = branch ? `?sha=${branch}&per_page=30` : "?per_page=30";
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
      Array<{ number: number; title: string; state: string; html_url: string }>
    >(`/repos/${repo.owner}/${repo.name}/issues?state=open&per_page=50`);
    return res.map((i) => ({ number: i.number, title: i.title, state: i.state, htmlUrl: i.html_url }));
  }

  async listReleases(repo: GithubRepoRef): Promise<GithubRelease[]> {
    const res = await this.json<
      Array<{ tag_name: string; name: string; body: string; created_at: string }>
    >(`/repos/${repo.owner}/${repo.name}/releases?per_page=20`);
    return res.map((r) => ({ tag: r.tag_name, name: r.name, body: r.body ?? "", createdAt: r.created_at }));
  }

  async getFile(repo: GithubRepoRef, path: string, branch?: string): Promise<GithubFile | undefined> {
    try {
      const q = branch ? `?ref=${branch}` : "";
      const res = await this.json<{ content: string; sha: string }>(`/repos/${repo.owner}/${repo.name}/contents/${path}${q}`);
      return { path, content: Buffer.from(res.content, "base64").toString("utf8"), sha: res.sha };
    } catch (err) {
      logger.debug(`GitHub getFile missing: ${path}`, { err: String(err) });
      return undefined;
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
      `/repos/${repo.owner}/${repo.name}/branches/${branch}`,
    )) as { commit: { sha: string } } | undefined;
    const sha = parentSha ?? branchData?.commit.sha;
    if (!sha) throw new Error("Cannot commit: branch has no HEAD sha");

    const tree = files.map((f) => ({
      path: f.path,
      mode: "100644",
      type: "blob",
      content: f.content,
    }));
    const treeRes = await this.json<{ sha: string }>(`/repos/${repo.owner}/${repo.name}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: sha, tree }),
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

  async createPullRequest(repo: GithubRepoRef, title: string, body: string, head: string, base: string): Promise<GithubPullRequest> {
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
      body: JSON.stringify({ title, body, head, base }),
    });
    return {
      number: res.number,
      title: res.title,
      state: res.state,
      head: res.head.ref,
      base: res.base.ref,
      htmlUrl: res.html_url,
      createdAt: res.created_at,
    };
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
