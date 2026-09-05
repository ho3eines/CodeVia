import { randomUUID } from "node:crypto";
import { DocumentRepository } from "../db/repository.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import type { KvStore } from "../db/kv.js";
import type { AuditRepository, NotificationRepository } from "../observability/repos.js";
import type { TaskRepository } from "../domain/repos.js";
import type { ID, ISODate } from "../types.js";
import { eventBus, generateCorrelationId } from "../events/bus.js";
import { live } from "../realtime/live.js";
import { logger } from "../logger.js";

/* ------------------------------------------------------------------ *
 * Human-in-the-loop approvals
 *
 * Dangerous / costly operations (merge PR, deploy, migrations, budget
 * overruns…) are gated behind an ApprovalRequest. The request is persisted,
 * surfaced as a notification + Telegram inline keyboard, and the calling
 * agent/workflow step blocks until a human decides (or the request expires).
 *
 * Policy (persisted in the KV store, configurable from Settings):
 *   autoApprove = true  → every request is granted immediately (dev / sim mode)
 *   autoApprove = false → requests wait for a human decision
 * ------------------------------------------------------------------ */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRequest {
  id: ID;
  action: string;
  detail: Record<string, unknown>;
  projectId?: ID;
  taskId?: ID;
  runId?: ID;
  workflowId?: ID;
  correlationId: string;
  status: ApprovalStatus;
  /** "auto" when granted by policy, otherwise who/where the decision came from. */
  decidedBy?: string;
  decisionSource?: "web" | "telegram" | "system" | "auto";
  note?: string;
  requestedAt: ISODate;
  decidedAt?: ISODate;
  expiresAt?: ISODate;
}

export interface ApprovalPolicy {
  autoApprove: boolean;
  /** How long a pending request blocks the caller before it is treated as rejected. */
  timeoutMs: number;
}

const POLICY_KEY = "approval.policy";
const DEFAULT_POLICY: ApprovalPolicy = { autoApprove: true, timeoutMs: 15 * 60 * 1000 };

export class ApprovalRepository extends DocumentRepository<ApprovalRequest> {
  constructor(db: Db = getDb()) {
    super("approval", db);
  }
  pending(projectId?: string): ApprovalRequest[] {
    return this.findMany(projectId ? { projectId } : {})
      .map((r) => r.data)
      .filter((a) => a.status === "pending");
  }
}

export function getApprovalRepo(): ApprovalRepository {
  return new ApprovalRepository();
}

export interface ApprovalServiceDeps {
  repo: ApprovalRepository;
  kv: KvStore;
  notificationRepo: NotificationRepository;
  auditRepo: AuditRepository;
  taskRepo?: TaskRepository;
  /** Fan-out hook (Telegram, email…) invoked when a request needs a human. */
  notify?: (request: ApprovalRequest) => Promise<void>;
}

interface Waiter {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalService {
  private readonly waiters = new Map<string, Waiter>();

  constructor(private readonly deps: ApprovalServiceDeps) {}

  /* ---------------- policy ---------------- */

  policy(): ApprovalPolicy {
    const stored = this.deps.kv.get<Partial<ApprovalPolicy>>(POLICY_KEY) ?? {};
    return { ...DEFAULT_POLICY, ...stored };
  }

  setPolicy(patch: Partial<ApprovalPolicy>): ApprovalPolicy {
    const next = { ...this.policy(), ...patch };
    if (!Number.isFinite(next.timeoutMs) || next.timeoutMs < 1000) next.timeoutMs = DEFAULT_POLICY.timeoutMs;
    this.deps.kv.set(POLICY_KEY, next);
    return next;
  }

  /* ---------------- queries ---------------- */

  list(filter: { projectId?: string; status?: ApprovalStatus } = {}): ApprovalRequest[] {
    let all = this.deps.repo.findMany(filter.projectId ? { projectId: filter.projectId } : {}).map((r) => r.data);
    if (filter.status) all = all.filter((a) => a.status === filter.status);
    return all.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
  }

  get(id: string): ApprovalRequest | undefined {
    return this.deps.repo.findById(id)?.data;
  }

  pendingCount(projectId?: string): number {
    return this.deps.repo.pending(projectId).length;
  }

  /* ---------------- request (the approval channel) ---------------- */

  /**
   * Ask for approval of `action`. Resolves `true` when approved. Under the
   * auto-approve policy this returns immediately (but still records the
   * request for the audit trail). Otherwise it blocks until a decision is
   * made through `decide()` (web UI / Telegram) or the policy timeout elapses.
   */
  async request(action: string, detail: Record<string, unknown> = {}): Promise<boolean> {
    const policy = this.policy();
    const now = new Date();
    const req: ApprovalRequest = {
      id: `apr-${randomUUID().slice(0, 8)}`,
      action,
      detail,
      projectId: strOrUndef(detail.projectId),
      taskId: strOrUndef(detail.taskId),
      runId: strOrUndef(detail.runId),
      workflowId: strOrUndef(detail.workflowId ?? detail.workflow),
      correlationId: strOrUndef(detail.correlationId) ?? generateCorrelationId(),
      status: "pending",
      requestedAt: now.toISOString(),
      expiresAt: policy.autoApprove ? undefined : new Date(now.getTime() + policy.timeoutMs).toISOString(),
    };

    if (policy.autoApprove) {
      req.status = "approved";
      req.decidedAt = req.requestedAt;
      req.decidedBy = "policy";
      req.decisionSource = "auto";
      this.deps.repo.upsert(req, { projectId: req.projectId, parentId: req.taskId });
      this.deps.auditRepo.record({
        action: "approval.auto_granted",
        projectId: req.projectId,
        result: "success",
        source: "system",
        correlationId: req.correlationId,
        metadata: { approvalId: req.id, action },
      });
      logger.info(`approval auto-granted: ${action}`, { approvalId: req.id, projectId: req.projectId });
      return true;
    }

    this.deps.repo.upsert(req, { projectId: req.projectId, parentId: req.taskId });
    this.deps.notificationRepo.create({
      severity: "warning",
      title: "Approval required",
      message: `${action} (${req.id})`,
      projectId: req.projectId,
    });
    this.deps.auditRepo.record({
      action: "approval.requested",
      projectId: req.projectId,
      result: "pending",
      source: "system",
      correlationId: req.correlationId,
      metadata: { approvalId: req.id, action, taskId: req.taskId, runId: req.runId },
    });
    this.setTaskStatus(req.taskId, "waiting_for_approval");
    live.emit({ type: "notification", data: { kind: "approval.required", approvalId: req.id, action, projectId: req.projectId } });
    void eventBus.publish("approval.required", { approvalId: req.id, action, projectId: req.projectId, taskId: req.taskId }, { correlationId: req.correlationId, projectId: req.projectId });
    if (this.deps.notify) {
      try {
        await this.deps.notify(req);
      } catch (err) {
        logger.warn("approval notify hook failed", { err: String(err), approvalId: req.id });
      }
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(req.id);
        const current = this.get(req.id);
        if (current && current.status === "pending") {
          this.finalize({ ...current, status: "expired", decidedAt: new Date().toISOString(), decidedBy: "timeout", decisionSource: "system" });
        }
        resolve(false);
      }, policy.timeoutMs);
      // Do not keep the process alive just for a pending approval.
      timer.unref?.();
      this.waiters.set(req.id, { resolve, timer });
    });
  }

  /* ---------------- decide ---------------- */

  decide(
    id: string,
    decision: "approve" | "reject",
    by: { user?: string; source: "web" | "telegram" | "system"; note?: string },
  ): ApprovalRequest {
    const current = this.get(id);
    if (!current) throw Object.assign(new Error(`approval ${id} not found`), { statusCode: 404 });
    if (current.status !== "pending") {
      throw Object.assign(new Error(`approval ${id} already ${current.status}`), { statusCode: 409 });
    }
    const approved = decision === "approve";
    const next: ApprovalRequest = {
      ...current,
      status: approved ? "approved" : "rejected",
      decidedAt: new Date().toISOString(),
      decidedBy: by.user ?? by.source,
      decisionSource: by.source,
      note: by.note,
    };
    this.finalize(next);
    const waiter = this.waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve(approved);
    }
    return next;
  }

  private finalize(next: ApprovalRequest): void {
    this.deps.repo.upsert(next, { projectId: next.projectId, parentId: next.taskId });
    const approved = next.status === "approved";
    this.deps.auditRepo.record({
      action: approved ? "approval.granted" : next.status === "expired" ? "approval.expired" : "approval.rejected",
      projectId: next.projectId,
      result: approved ? "success" : "denied",
      source: next.decisionSource === "auto" ? "system" : (next.decisionSource ?? "system"),
      correlationId: next.correlationId,
      metadata: { approvalId: next.id, action: next.action, by: next.decidedBy, note: next.note },
    });
    this.deps.notificationRepo.create({
      severity: approved ? "success" : "warning",
      title: approved ? "Approval granted" : next.status === "expired" ? "Approval expired" : "Approval rejected",
      message: `${next.action} (${next.id})`,
      projectId: next.projectId,
    });
    // The task resumes (approved) or the step is skipped (rejected/expired) — either
    // way it is no longer waiting on a human.
    this.setTaskStatus(next.taskId, "running");
    live.emit({ type: "notification", data: { kind: `approval.${next.status}`, approvalId: next.id, projectId: next.projectId } });
    void eventBus.publish(
      approved ? "approval.granted" : "approval.rejected",
      { approvalId: next.id, action: next.action, projectId: next.projectId, taskId: next.taskId, status: next.status },
      { correlationId: next.correlationId, projectId: next.projectId },
    );
  }

  private setTaskStatus(taskId: string | undefined, status: "waiting_for_approval" | "running"): void {
    if (!taskId || !this.deps.taskRepo) return;
    const rec = this.deps.taskRepo.findById(taskId);
    if (!rec) return;
    // Only flip a task that is actually in flight; never resurrect a finished one.
    if (status === "running" && rec.data.status !== "waiting_for_approval") return;
    this.deps.taskRepo.upsert(
      { ...rec.data, status, approvalRequired: status === "waiting_for_approval" ? true : rec.data.approvalRequired, updatedAt: new Date().toISOString() },
      { projectId: rec.data.projectId, parentId: rec.data.parentTaskId },
    );
    live.emit({ type: "task.updated", taskId, data: { status } });
  }
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
