/**
 * In-memory GitHub REST double for end-to-end tests of the REAL adapter
 * (`RealGitHubService`). It models branches → commits → trees, pull requests,
 * CI checks, merges and issues, and records which bearer token performed
 * every request so tests can assert "the site token never wrote anything".
 */
export interface FakeGitHubCall {
  method: string;
  path: string;
  token: string;
}

export interface FakeGitHubAccount {
  login: string;
  scopes: string[];
  /** Repositories this account may push to (`owner/name`). Others are read-only (public) or hidden. */
  push: string[];
}

interface Commit {
  sha: string;
  tree: Map<string, string>;
  message: string;
}
interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  branches: Map<string, string>;
  pulls: Array<{ number: number; title: string; state: string; head: string; base: string; draft: boolean }>;
  issues: Array<{ number: number; title: string; state: string; comments: string[] }>;
}

export interface FakeGitHub {
  fetch: typeof fetch;
  calls: FakeGitHubCall[];
  repos: Map<string, Repo>;
  /** CI result reported for a commit (`none` = no checks at all). Default: success. */
  setChecks(sha: string, status: "success" | "failure" | "pending" | "none"): void;
  headOf(repo: string, branch: string): string | undefined;
  fileAt(repo: string, branch: string, path: string): string | undefined;
  writes(): FakeGitHubCall[];
  /** Commit `files` onto `branch` directly (test setup, not recorded as a call). */
  seed(repo: string, files: Record<string, string>, branch?: string): void;
}

export function createFakeGitHub(opts: {
  accounts: Record<string, FakeGitHubAccount>;
  repos: Array<{ fullName: string; private?: boolean; files?: Record<string, string> }>;
}): FakeGitHub {
  const calls: FakeGitHubCall[] = [];
  const commits = new Map<string, Commit>();
  const trees = new Map<string, Map<string, string>>();
  const checks = new Map<string, "success" | "failure" | "pending" | "none">();
  const repos = new Map<string, Repo>();
  let seq = 0;
  const sha = (label: string) => `${label}${(++seq).toString(16)}`.padEnd(40, "0").slice(0, 40);
  const newCommit = (tree: Map<string, string>, message: string): string => {
    const s = sha("c");
    commits.set(s, { sha: s, tree, message });
    return s;
  };
  for (const r of opts.repos) {
    const root = newCommit(new Map(Object.entries(r.files ?? { "README.md": `# ${r.fullName}\n` })), "init");
    repos.set(r.fullName.toLowerCase(), {
      fullName: r.fullName,
      private: r.private ?? true,
      defaultBranch: "main",
      branches: new Map([["main", root]]),
      pulls: [],
      issues: [],
    });
  }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const notFound = () => json({ message: "Not Found" }, 404);

  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    calls.push({ method, path: url.pathname + url.search, token });
    const account = opts.accounts[token];
    if (!account) return json({ message: "Bad credentials" }, 401);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const p = url.pathname;

    if (p === "/user" && method === "GET")
      return json({ login: account.login, name: account.login }, 200, { "x-oauth-scopes": account.scopes.join(", ") });

    const m = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return notFound();
    const full = `${m[1]}/${m[2]}`;
    const repo = repos.get(full.toLowerCase());
    const rest = m[3] ?? "";
    const hasRepoScope = account.scopes.includes("repo");
    const visible = repo && (!repo.private || hasRepoScope);
    if (!repo || !visible) return notFound();
    const canPush =
      account.push.some((r) => r.toLowerCase() === full.toLowerCase()) &&
      (hasRepoScope || (account.scopes.includes("public_repo") && !repo.private));
    const write = method !== "GET";
    if (write && !canPush) return json({ message: canPush ? "" : "Resource not accessible" }, repo.private ? 404 : 403);

    const commitOf = (ref: string) => commits.get(repo.branches.get(ref) ?? ref);

    if (!rest && method === "GET")
      return json({
        full_name: repo.fullName,
        name: m[2],
        owner: { login: m[1] },
        private: repo.private,
        default_branch: repo.defaultBranch,
        permissions: { admin: canPush, push: canPush, pull: true },
      });
    if (rest === "/branches" && method === "GET")
      return json([...repo.branches].map(([name, s]) => ({ name, commit: { sha: s } })));
    let r2 = rest.match(/^\/branches\/(.+)$/);
    if (r2 && method === "GET") {
      const s = repo.branches.get(decodeURIComponent(r2[1]));
      return s ? json({ name: decodeURIComponent(r2[1]), commit: { sha: s } }) : notFound();
    }
    if (rest === "/commits" && method === "GET") {
      const s = repo.branches.get(url.searchParams.get("sha") ?? repo.defaultBranch);
      const c = s ? commits.get(s) : undefined;
      return json(c ? [{ sha: c.sha, commit: { message: c.message, author: { name: "x", date: "2026-01-01" } } }] : []);
    }
    r2 = rest.match(/^\/git\/trees\/(.+)$/);
    if (r2 && method === "GET") {
      const c = commitOf(decodeURIComponent(r2[1]));
      if (!c) return notFound();
      return json({ tree: [...c.tree.keys()].map((path) => ({ path, type: "blob", size: c.tree.get(path)!.length })) });
    }
    r2 = rest.match(/^\/contents\/?(.*)$/);
    if (r2 && method === "GET") {
      const c = commitOf(url.searchParams.get("ref") ?? repo.defaultBranch);
      const path = decodeURIComponent(r2[1]).replace(/\/$/, "");
      if (!c) return notFound();
      if (c.tree.has(path)) return json({ content: Buffer.from(c.tree.get(path)!).toString("base64"), sha: "blob" });
      const prefix = path ? `${path}/` : "";
      const names = new Map<string, "file" | "dir">();
      for (const k of c.tree.keys()) {
        if (!k.startsWith(prefix)) continue;
        const seg = k.slice(prefix.length).split("/");
        names.set(prefix + seg[0], seg.length > 1 ? "dir" : "file");
      }
      if (!names.size) return notFound();
      return json([...names].map(([pth, type]) => ({ path: pth, type })));
    }
    if (rest === "/git/refs" && method === "POST") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (repo.branches.has(name)) return json({ message: "Reference already exists" }, 422);
      repo.branches.set(name, String(body.sha));
      return json({ ref: body.ref }, 201);
    }
    r2 = rest.match(/^\/git\/commits\/(.+)$/);
    if (r2 && method === "GET") {
      const c = commits.get(r2[1]);
      if (!c) return notFound();
      const t = sha("t");
      trees.set(t, c.tree);
      return json({ sha: c.sha, tree: { sha: t } });
    }
    if (rest === "/git/trees" && method === "POST") {
      const next = new Map(trees.get(String(body.base_tree)) ?? []);
      for (const e of (body.tree as Array<{ path: string; content?: string; sha?: null }>) ?? []) {
        if (e.sha === null) next.delete(e.path);
        else if (typeof e.content === "string") next.set(e.path, e.content);
      }
      const t = sha("t");
      trees.set(t, next);
      return json({ sha: t }, 201);
    }
    if (rest === "/git/commits" && method === "POST") {
      const tree = trees.get(String(body.tree));
      if (!tree) return json({ message: "tree not found" }, 422);
      return json({ sha: newCommit(tree, String(body.message ?? "")) }, 201);
    }
    r2 = rest.match(/^\/git\/refs\/heads\/(.+)$/);
    if (r2 && method === "PATCH") {
      repo.branches.set(decodeURIComponent(r2[1]), String(body.sha));
      return json({ object: { sha: body.sha } });
    }
    const prJson = (pr: Repo["pulls"][number]) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      head: { ref: pr.head, sha: repo.branches.get(pr.head) },
      base: { ref: pr.base },
      html_url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
      created_at: "2026-01-01T00:00:00Z",
    });
    if (rest === "/pulls" && method === "POST") {
      if (!repo.branches.has(String(body.head))) return json({ message: "head not found" }, 422);
      const pr = {
        number: repo.pulls.length + repo.issues.length + 1,
        title: String(body.title),
        state: "open",
        head: String(body.head),
        base: String(body.base),
        draft: body.draft === true,
      };
      repo.pulls.push(pr);
      return json(prJson(pr), 201);
    }
    if (rest === "/pulls" && method === "GET") return json(repo.pulls.filter((x) => x.state === "open").map(prJson));
    r2 = rest.match(/^\/pulls\/(\d+)$/);
    if (r2 && method === "GET") {
      const pr = repo.pulls.find((x) => x.number === Number(r2![1]));
      return pr ? json(prJson(pr)) : notFound();
    }
    r2 = rest.match(/^\/pulls\/(\d+)\/merge$/);
    if (r2 && method === "PUT") {
      const pr = repo.pulls.find((x) => x.number === Number(r2![1]));
      if (!pr || pr.state !== "open") return json({ message: "Pull Request is not mergeable" }, 405);
      const head = repo.branches.get(pr.head)!;
      if (body.sha && body.sha !== head) return json({ message: "Head branch was modified" }, 409);
      const base = commits.get(repo.branches.get(pr.base)!)!;
      const merged = new Map(base.tree);
      for (const [k, v] of commits.get(head)!.tree) merged.set(k, v);
      const s = newCommit(merged, `merge #${pr.number}`);
      repo.branches.set(pr.base, s);
      pr.state = "closed";
      return json({ merged: true, sha: s, message: "Pull Request successfully merged" });
    }
    r2 = rest.match(/^\/commits\/([^/]+)\/(check-runs|status)$/);
    if (r2 && method === "GET") {
      const st = checks.get(decodeURIComponent(r2[1])) ?? "success";
      if (r2[2] === "status") return json({ total_count: 0, statuses: [] });
      if (st === "none") return json({ total_count: 0, check_runs: [] });
      return json({
        total_count: 1,
        check_runs: [
          {
            name: "ci/test",
            status: st === "pending" ? "in_progress" : "completed",
            conclusion: st === "pending" ? undefined : st,
            html_url: "https://ci.example/run",
          },
        ],
      });
    }
    if (rest === "/issues" && method === "POST") {
      const issue = {
        number: repo.pulls.length + repo.issues.length + 1,
        title: String(body.title),
        state: "open",
        comments: [],
      };
      repo.issues.push(issue);
      return json({ ...issue, html_url: `https://github.com/${repo.fullName}/issues/${issue.number}` }, 201);
    }
    if (rest === "/issues" && method === "GET") return json(repo.issues.map((i) => ({ ...i, html_url: "" })));
    r2 = rest.match(/^\/issues\/(\d+)\/comments$/);
    if (r2 && method === "POST") return json({ id: 1 }, 201);
    if (rest.startsWith("/releases")) return json([]);
    return notFound();
  };

  return {
    fetch: impl as typeof fetch,
    calls,
    repos,
    setChecks: (s, status) => void checks.set(s, status),
    headOf: (r, b) => repos.get(r.toLowerCase())?.branches.get(b),
    fileAt: (r, b, path) => {
      const s = repos.get(r.toLowerCase())?.branches.get(b);
      return s ? commits.get(s)?.tree.get(path) : undefined;
    },
    writes: () => calls.filter((c) => c.method !== "GET"),
    seed: (r, files, branch = "main") => {
      const repo = repos.get(r.toLowerCase());
      if (!repo) throw new Error(`unknown repo ${r}`);
      const base = commits.get(repo.branches.get(branch)!)!;
      const tree = new Map(base.tree);
      for (const [k, v] of Object.entries(files)) tree.set(k, v);
      repo.branches.set(branch, newCommit(tree, "seed"));
    },
  };
}
