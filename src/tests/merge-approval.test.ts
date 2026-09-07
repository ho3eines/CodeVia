import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Container } from "../app/container.js";
import { Worker } from "../workers/worker.js";
import { logger } from "../logger.js";
import { freshDb } from "./test-helpers.js";
import type { IGitHubService } from "../github/types.js";
import type { ApprovalRequest } from "../approvals/service.js";

/* ------------------------------------------------------------------ *
 * Regression tests for PIPELINE_AUDIT.md A04: a worker `github.op`
 * merge_pr job must only merge when it is backed by a genuine approval
 * request that exists, is approved, belongs to the same project, and
 * records this exact pull request (and repository, when the project has
 * several). The merge must also go through the project's own GitHub
 * connection, not an unscoped platform default.
 * ------------------------------------------------------------------ */

interface MergeCall {
  repo: string;
  number: number;
  viaProjectConnection: boolean;
}

let cleanup: (() => void) | undefined;
let container: Container;
let merges: MergeCall[] = [];

function fakeGithub(recorder: MergeCall[], viaProjectConnection: boolean): IGitHubService {
  return {
    mergePullRequest: async (repo: { owner: string; name: string }, number: number) => {
      recorder.push({ repo: `${repo.owner}/${repo.name}`, number, viaProjectConnection });
      return { merged: true, sha: "abc123", message: "ok" };
    },
  } as unknown as IGitHubService;
}

function buildWorker(opts: { withProjectConnection?: boolean } = {}): Worker {
  merges = [];
  return new Worker({
    queue: container.queue,
    agentManager: container.agentManager,
    agentRunner: container.agentRunner,
    workflowRepo: container.workflowRepo,
    projectRepo: container.projectRepo,
    taskRepo: container.taskRepo,
    approvalRepo: container.approvalRepo,
    github: fakeGithub(merges, false),
    githubForProject: opts.withProjectConnection === false ? undefined : (project) => fakeGithub(merges, true),
    telegram: container.telegram,
    notificationRepo: container.notificationRepo,
    logger,
  });
}

function makeApproval(projectId: string, detail: Record<string, unknown>, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const request: ApprovalRequest = {
    id: `apr-${Math.random().toString(36).slice(2, 10)}`,
    action: "Merge pull request",
    detail: { projectId, ...detail },
    projectId,
    correlationId: "corr-merge-test",
    status: "approved",
    requestedAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    decidedBy: "tester",
    decisionSource: "web",
    ...overrides,
  };
  container.approvalRepo.upsert(request, { projectId });
  return request;
}

async function runMergeJob(worker: Worker, payload: Record<string, unknown>): Promise<string | undefined> {
  const job = container.queue.enqueue("github.op", payload);
  await worker.process(job.id);
  return container.queue.getById(job.id)?.status;
}

beforeEach(async () => {
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
});

afterEach(() => {
  container?.githubAutomation.stop();
  cleanup?.();
});

describe("worker merge_pr — approval-backed merges only (A04)", () => {
  it("rejects a merge job whose approvalId does not exist", async () => {
    const worker = buildWorker();
    const project = await container.agentManager.createProject({ name: "Ops", description: "x", configRepo: "acme/ops" });
    const status = await runMergeJob(worker, { op: "merge_pr", projectId: project.id, repo: "acme/ops", number: 7, approvalId: "apr-does-not-exist" });
    expect(merges).toHaveLength(0);
    expect(status).not.toBe("succeeded");
  });

  it("rejects a merge job with no approvalId at all", async () => {
    const worker = buildWorker();
    const project = await container.agentManager.createProject({ name: "Ops2", description: "x", configRepo: "acme/ops2" });
    const status = await runMergeJob(worker, { op: "merge_pr", projectId: project.id, repo: "acme/ops2", number: 7 });
    expect(merges).toHaveLength(0);
    expect(status).not.toBe("succeeded");
  });

  it("rejects an approval that is only pending", async () => {
    const worker = buildWorker();
    const project = await container.agentManager.createProject({ name: "Gate", description: "x", configRepo: "acme/gate" });
    const approval = makeApproval(project.id, { tool: "merge_pull_request", number: 7, repo: "acme/gate" }, { status: "pending" });
    const status = await runMergeJob(worker, { op: "merge_pr", projectId: project.id, repo: "acme/gate", number: 7, approvalId: approval.id });
    expect(merges).toHaveLength(0);
    expect(status).not.toBe("succeeded");
  });

  it("rejects an approval belonging to another project", async () => {
    const worker = buildWorker();
    const here = await container.agentManager.createProject({ name: "Here", description: "x", configRepo: "acme/here" });
    const there = await container.agentManager.createProject({ name: "There", description: "x", configRepo: "acme/there" });
    const approval = makeApproval(there.id, { tool: "merge_pull_request", number: 7, repo: "acme/there" });
    const status = await runMergeJob(worker, { op: "merge_pr", projectId: here.id, repo: "acme/here", number: 7, approvalId: approval.id });
    expect(merges).toHaveLength(0);
    expect(status).not.toBe("succeeded");
  });

  it("rejects an approval that does not record the pull request number", async () => {
    const worker = buildWorker();
    const project = await container.agentManager.createProject({ name: "Vague", description: "x", configRepo: "acme/vague" });
    const approval = makeApproval(project.id, { tool: "merge_pull_request", repo: "acme/vague" });
    const status = await runMergeJob(worker, { op: "merge_pr", projectId: project.id, repo: "acme/vague", number: 7, approvalId: approval.id });
    expect(merges).toHaveLength(0);
    expect(status).not.toBe("succeeded");
  });

  it("rejects when the recorded pull request number differs", async () => {
    const worker = buildWorker();
    const project = await container.agentManager.createProject({ name: "Wrong", description: "x", configRepo: "acme/wrong" });
    const approval = makeApproval(project.id, { tool: "merge_pull_request", number: 12, repo: "acme/wrong" });
    const status = await runMergeJob(worker, { op: "merge_pr", projectId: project.id, repo: "acme/wrong", number: 13, approvalId: approval.id });
    expect(merges).toHaveLength(0);
    expect(status).not.toBe("succeeded");
  });

  it("rejects when the recorded repository differs on a multi-repo project", async () => {
    const worker = buildWorker();
    const project = await container.agentManager.createProject({
      name: "Multi",
      description: "x",
      configRepo: "acme/one",
      repositories: [
        { repo: "acme/one", branch: "main", role: "primary", isConfigRepo: true },
        { repo: "acme/two", branch: "main", role: "backend" },
      ],
    });
    const approval = makeApproval(project.id, { tool: "merge_pull_request", number: 7, repo: "acme/one" });
    // Approved for acme/one — must not authorize merging into acme/two.
    const status = await runMergeJob(worker, { op: "merge_pr", projectId: project.id, repo: "acme/two", number: 7, approvalId: approval.id });
    expect(merges).toHaveLength(0);
    expect(status).not.toBe("succeeded");
  });

  it("rejects a repo-less approval on a multi-repo project", async () => {
    const worker = buildWorker();
    const project = await container.agentManager.createProject({
      name: "Multi2",
      description: "x",
      configRepo: "acme/one",
      repositories: [
        { repo: "acme/one", branch: "main", role: "primary", isConfigRepo: true },
        { repo: "acme/two", branch: "main", role: "backend" },
      ],
    });
    const approval = makeApproval(project.id, { tool: "merge_pull_request", number: 7 }); // no repo recorded
    const status = await runMergeJob(worker, { op: "merge_pr", projectId: project.id, repo: "acme/two", number: 7, approvalId: approval.id });
    expect(merges).toHaveLength(0);
    expect(status).not.toBe("succeeded");
  });

  it("merges with a genuine approved approval for the same project and PR, via the project connection", async () => {
    const worker = buildWorker();
    const project = await container.agentManager.createProject({ name: "Legit", description: "x", configRepo: "acme/legit" });
    const approval = makeApproval(project.id, { tool: "merge_pull_request", number: 12, repo: "acme/legit" });
    const status = await runMergeJob(worker, { op: "merge_pr", projectId: project.id, repo: "acme/legit", number: 12, approvalId: approval.id, method: "squash" });
    expect(status).toBe("succeeded");
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ repo: "acme/legit", number: 12, viaProjectConnection: true });
  });

  it("accepts a repo-less approval on a single-repo project (project + PR already unambiguous)", async () => {
    const worker = buildWorker();
    const project = await container.agentManager.createProject({ name: "Solo", description: "x", configRepo: "acme/solo" });
    const approval = makeApproval(project.id, { tool: "merge_pull_request", number: 3 });
    const status = await runMergeJob(worker, { op: "merge_pr", projectId: project.id, repo: "acme/solo", number: 3, approvalId: approval.id });
    expect(status).toBe("succeeded");
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ repo: "acme/solo", number: 3 });
  });

  it("falls back to the platform GitHub connection when no project resolver is configured", async () => {
    const worker = buildWorker({ withProjectConnection: false });
    const project = await container.agentManager.createProject({ name: "Plain", description: "x", configRepo: "acme/plain" });
    const approval = makeApproval(project.id, { tool: "merge_pull_request", number: 5, repo: "acme/plain" });
    const status = await runMergeJob(worker, { op: "merge_pr", projectId: project.id, repo: "acme/plain", number: 5, approvalId: approval.id });
    expect(status).toBe("succeeded");
    expect(merges).toHaveLength(1);
    expect(merges[0].viaProjectConnection).toBe(false);
  });
});
