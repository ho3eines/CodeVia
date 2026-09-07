import { spawn } from "node:child_process";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import type { MemoryRecord } from "../memory/store.js";

/** Coerce an input value to string. */
function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Run a shell command in the workspace root, capturing output. */
function runCommand(cmd: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout: "", stderr: String(err) }));
  });
}

export function toRepoRef(value: unknown): { owner: string; name: string } {
  const s = str(value);
  const [owner, ...rest] = s.split("/");
  return { owner, name: rest.join("/") };
}

export const listBranchesTool: ToolDefinition = {
  name: "list_branches",
  description: "List branches of the project repository.",
  dangerous: false,
  inputSchema: { type: "object", properties: { repo: { type: "string" } } },
  permissions: ["github.read"],
  timeoutMs: 15000,
  async execute(ctx: ToolContext, input) {
    const repo = toRepoRef(input.repo ?? ctx.project.configRepo);
    const branches = await ctx.github.listBranches(repo);
    return { ok: true, output: branches.map((b) => b.name).join("\n"), data: { branches } };
  },
};

export const listCommitsTool: ToolDefinition = {
  name: "list_commits",
  description: "List recent commits on a branch.",
  dangerous: false,
  inputSchema: { type: "object", properties: { repo: { type: "string" }, branch: { type: "string" } } },
  permissions: ["github.read"],
  timeoutMs: 15000,
  async execute(ctx: ToolContext, input) {
    const repo = toRepoRef(input.repo ?? ctx.project.configRepo);
    const branch = str(input.branch ?? ctx.project.branch);
    const commits = await ctx.github.listCommits(repo, branch);
    return {
      ok: true,
      output: commits.map((c) => `${c.sha.slice(0, 7)} ${c.message.split("\n")[0]}`).join("\n"),
      data: { commits },
    };
  },
};

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file from the repository. Plan/understand only.",
  dangerous: false,
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  permissions: ["github.read"],
  timeoutMs: 15000,
  async execute(ctx: ToolContext, input) {
    const repo = toRepoRef(ctx.project.configRepo);
    let path = str(input.path);
    if (!path) {
      // Default inspection (used by deterministic agent plans): prefer the
      // project's AI brief / docs so "inspect before changing" always reads
      // something meaningful instead of failing on a missing path.
      const candidates = ["Agent.md", "README.md", ".ai-engineering/project.yaml", "package.json"];
      for (const candidate of candidates) {
        const hit = await ctx.github.getFile(repo, candidate, ctx.project.branch).catch(() => undefined);
        if (hit) {
          return { ok: true, output: hit.content.slice(0, 8000), data: { path: candidate, sha: hit.sha } };
        }
      }
      const entries = await ctx.github.listFiles(repo, ctx.project.branch).catch(() => []);
      const first = entries.find((e) => e.type === "blob");
      if (!first) return { ok: true, output: "Repository is empty — nothing to read yet.", data: { empty: true } };
      path = first.path;
    }
    const file = await ctx.github.getFile(repo, path, ctx.project.branch);
    if (!file) return { ok: false, output: `File not found: ${path}` };
    return { ok: true, output: file.content.slice(0, 8000), data: { path, sha: file.sha } };
  },
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "Commit a file to the project repository on a branch.",
  dangerous: true,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" }, message: { type: "string" } },
  },
  permissions: ["github.write", "repository.write"],
  timeoutMs: 20000,
  async execute(ctx: ToolContext, input) {
    const repo = toRepoRef(ctx.project.configRepo);
    const branch = str(input.branch) || ctx.project.branch;
    const path = str(input.path) || `src/${ctx.agent.slug}.md`;
    const content = str(input.content) || `# ${ctx.agent.name} — ${new Date().toISOString()}\n\nGenerated change note.`;
    const message = str(input.message) || `[${ctx.agent.name}] update ${path}`;
    const commit = await ctx.github.commit(repo, branch, message, [{ path, content }]);
    ctx.logger.info("write_file committed", { path, sha: commit.sha, projectId: ctx.project.id });
    return { ok: true, output: `Committed ${commit.sha.slice(0, 7)} to ${branch}`, data: { sha: commit.sha } };
  },
};

export const createPullRequestTool: ToolDefinition = {
  name: "create_pull_request",
  description: "Create a pull request from a head branch to a base branch.",
  dangerous: true,
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" }, body: { type: "string" }, head: { type: "string" }, base: { type: "string" } },
  },
  permissions: ["github.write"],
  timeoutMs: 20000,
  async execute(ctx: ToolContext, input) {
    const repo = toRepoRef(ctx.project.configRepo);
    const title = str(input.title) || `[${ctx.agent.name}] ${str(input.taskTitle) || ctx.project.name}`;
    const body =
      str(input.body) ||
      buildPullRequestBody({
        agentName: ctx.agent.name,
        taskTitle: str(input.taskTitle) || title,
        taskDescription: str(input.taskDescription),
        changes: Array.isArray(input.changes) ? (input.changes as string[]) : undefined,
        tests: Array.isArray(input.tests) ? (input.tests as string[]) : undefined,
        risks: Array.isArray(input.risks) ? (input.risks as string[]) : undefined,
        breaking: Array.isArray(input.breaking) ? (input.breaking as string[]) : undefined,
        correlationId: ctx.correlationId,
      });
    const head = str(input.head) || `agent-${ctx.agent.slug}`;
    const base = str(input.base) || ctx.project.branch;
    const pr = await ctx.github.createPullRequest(repo, title, body, head, base);
    ctx.logger.info("PR created", { number: pr.number, projectId: ctx.project.id });
    return { ok: true, output: `PR #${pr.number} created`, data: { number: pr.number, url: pr.htmlUrl } };
  },
};

export const runTestsTool: ToolDefinition = {
  name: "run_tests",
  description: "Run the project test command in the isolated workspace.",
  dangerous: false,
  inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } } },
  permissions: ["github.read"],
  timeoutMs: 120000,
  async execute(ctx: ToolContext, input) {
    const cmd = str(input.command ?? "npm test");
    const cwd = str(input.cwd ?? ctx.workspaceRoot);
    const res = await runCommand(cmd, cwd || undefined);
    return {
      ok: res.code === 0,
      output: `${res.stdout}\n${res.stderr}`.trim(),
      data: { code: res.code },
    };
  },
};

export const runBuildTool: ToolDefinition = {
  name: "run_build",
  description: "Run the project build command in the isolated workspace.",
  dangerous: false,
  inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } } },
  permissions: ["github.read"],
  timeoutMs: 120000,
  async execute(ctx: ToolContext, input) {
    const cmd = str(input.command ?? "npm run build");
    const cwd = str(input.cwd ?? ctx.workspaceRoot);
    const res = await runCommand(cmd, cwd || undefined);
    return { ok: res.code === 0, output: `${res.stdout}\n${res.stderr}`.trim(), data: { code: res.code } };
  },
};

export const searchTool: ToolDefinition = {
  name: "search",
  description: "Search project memory/knowledge and repository file paths by keyword.",
  dangerous: false,
  inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
  permissions: ["memory.read", "github.read"],
  timeoutMs: 15000,
  async execute(ctx: ToolContext, input) {
    const query = str(input.query).trim();
    if (!query) return { ok: false, output: "search: query is required" };
    const limit = Math.max(1, Math.min(50, Number(input.limit ?? 10)));
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    const data: Record<string, unknown> = {};

    // 1. Project memory (decisions, bugs, architecture, lessons…).
    if (ctx.memory) {
      try {
        const hits = await ctx.memory.search(query);
        data.memory = hits.slice(0, limit).map((h) => ({ type: h.type, key: h.key, snippet: h.content.slice(0, 200) }));
        for (const h of hits.slice(0, limit)) lines.push(`[memory:${h.type}] ${h.key} — ${h.content.replace(/\s+/g, " ").slice(0, 160)}`);
      } catch (err) {
        ctx.logger.warn("memory search failed", { err: String(err) });
      }
    }

    // 2. Repository paths whose name matches any term.
    try {
      const repo = toRepoRef(ctx.project.configRepo);
      const entries = await ctx.github.listFiles(repo, ctx.project.branch);
      const files = entries
        .map((e) => e.path)
        .filter((p) => terms.some((t) => p.toLowerCase().includes(t)))
        .slice(0, limit);
      data.files = files;
      for (const f of files) lines.push(`[file] ${f}`);
    } catch (err) {
      ctx.logger.warn("repository search failed", { err: String(err) });
    }

    return { ok: true, output: lines.length ? lines.join("\n") : `No matches for "${query}"`, data };
  },
};

export const saveMemoryTool: ToolDefinition = {
  name: "save_memory",
  description: "Persist a finding/decision/lesson into project memory (GitHub-backed, versioned).",
  dangerous: false,
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["architecture", "business", "technical", "decision", "bug", "knowledge", "lesson", "conversation"] },
      key: { type: "string" },
      content: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["key", "content"],
  },
  permissions: ["memory.write"],
  timeoutMs: 20000,
  async execute(ctx: ToolContext, input) {
    if (!ctx.memory) return { ok: false, output: "No memory store attached to this run" };
    const key = str(input.key) || `${ctx.agent.slug}-${Date.now()}`;
    const content = str(input.content);
    if (!content) return { ok: false, output: "save_memory: content is required" };
    const type = (str(input.type) || "knowledge") as MemoryRecord["type"];
    const path = await ctx.memory.append({
      type,
      key,
      content: `${content}\n\n_— ${ctx.agent.name}, ${new Date().toISOString()}, correlation ${ctx.correlationId}_`,
      tags: Array.isArray(input.tags) ? (input.tags as string[]) : [ctx.agent.type],
      refs: [ctx.correlationId],
      scope: "project",
    });
    return { ok: true, output: `Saved ${type}/${key} → ${path}`, data: { type, key, path } };
  },
};

export const createBranchTool: ToolDefinition = {
  name: "create_branch",
  description: "Create a working branch from the project's base branch (agents never commit to the base branch directly).",
  dangerous: false,
  inputSchema: { type: "object", properties: { name: { type: "string" }, from: { type: "string" } } },
  permissions: ["github.write", "repository.write"],
  timeoutMs: 20000,
  async execute(ctx: ToolContext, input) {
    const repo = toRepoRef(ctx.project.configRepo);
    const from = str(input.from) || ctx.project.branch;
    const name = str(input.name) || `agent/${ctx.agent.slug}/${ctx.correlationId.replace(/[^a-z0-9]/gi, "").slice(-8)}`;
    const branches = await ctx.github.listBranches(repo);
    const base = branches.find((b) => b.name === from) ?? branches[0];
    if (!base) return { ok: false, output: `Base branch ${from} not found` };
    const created = await ctx.github.createBranch(repo, name, base.sha);
    return { ok: true, output: `Branch ${created.name} created from ${base.name}`, data: { branch: created.name, sha: created.sha } };
  },
};

export const mergePullRequestTool: ToolDefinition = {
  name: "merge_pull_request",
  description: "Merge a pull request into its base branch. Dangerous — always requires human approval.",
  dangerous: true,
  inputSchema: { type: "object", properties: { number: { type: "number" }, method: { type: "string", enum: ["merge", "squash", "rebase"] } }, required: ["number"] },
  permissions: ["github.write", "deployment.write"],
  timeoutMs: 30000,
  async execute(ctx: ToolContext, input) {
    const repo = toRepoRef(ctx.project.configRepo);
    const number = Number(input.number);
    if (!Number.isFinite(number) || number <= 0) return { ok: false, output: "merge_pull_request: number is required" };
    const method = (["merge", "squash", "rebase"].includes(str(input.method)) ? str(input.method) : "squash") as "merge" | "squash" | "rebase";
    const res = await ctx.github.mergePullRequest(repo, number, { method, commitTitle: `[${ctx.agent.name}] merge PR #${number}` });
    ctx.logger.info("PR merge attempted", { number, merged: res.merged, projectId: ctx.project.id, correlationId: ctx.correlationId });
    return { ok: res.merged, output: res.merged ? `PR #${number} merged (${method})` : `PR #${number} not merged: ${res.message ?? "unknown"}`, data: { number, ...res } };
  },
};

/**
 * Agent-generated PR description: Summary / Changes / Tests / Risks / Breaking
 * Changes. Filled from what the run actually did (steps + tool results) so the
 * description is grounded, not hallucinated.
 */
export function buildPullRequestBody(opts: {
  agentName: string;
  taskTitle: string;
  taskDescription?: string;
  changes?: string[];
  tests?: string[];
  risks?: string[];
  breaking?: string[];
  correlationId?: string;
}): string {
  const list = (items: string[] | undefined, empty: string) => (items && items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`);
  return [
    `## Summary`,
    opts.taskDescription?.trim() || opts.taskTitle,
    ``,
    `## Changes`,
    list(opts.changes, "See commits on this branch."),
    ``,
    `## Tests`,
    list(opts.tests, "No automated test run recorded for this change."),
    ``,
    `## Risks`,
    list(opts.risks, "Low — scoped change, reviewed by the agent before opening this PR."),
    ``,
    `## Breaking Changes`,
    list(opts.breaking, "None."),
    ``,
    `---`,
    `_Generated by the **${opts.agentName}** agent on CodeVia${opts.correlationId ? ` · correlation \`${opts.correlationId}\`` : ""}._`,
  ].join("\n");
}

export const requestApprovalTool: ToolDefinition = {
  name: "request_approval",
  description: "Request human approval before a dangerous action.",
  dangerous: true,
  inputSchema: { type: "object", properties: { action: { type: "string" }, detail: { type: "object" } } },
  permissions: ["github.write", "deployment.write"],
  timeoutMs: 60000,
  async execute(ctx: ToolContext, input) {
    if (!ctx.requestApproval) return { ok: false, output: "No approval channel configured" };
    const approved = await ctx.requestApproval(str(input.action), (input.detail as Record<string, unknown>) ?? {});
    return { ok: approved, output: approved ? "Approved" : "Rejected", requiresApproval: false, data: { approved } };
  },
};

export const CORE_TOOLS: ToolDefinition[] = [
  listBranchesTool,
  listCommitsTool,
  readFileTool,
  writeFileTool,
  createPullRequestTool,
  runTestsTool,
  runBuildTool,
  searchTool,
  saveMemoryTool,
  createBranchTool,
  mergePullRequestTool,
  requestApprovalTool,
];
