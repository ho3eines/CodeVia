import { DocumentRepository } from "../db/repository.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import type { AuditLog, CostRecord, Notification, Run } from "../domain/entities.js";
import { randomUUID } from "node:crypto";

export class RunRepository extends DocumentRepository<Run> {
  constructor(db: Db = getDb()) {
    super("run", db);
  }
  byProject(projectId: string): Run[] {
    return this.findMany({ projectId }).map((r) => r.data);
  }
  byTask(taskId: string): Run[] {
    return this.findMany({ parentId: taskId }).map((r) => r.data);
  }
  create(data: Omit<Run, "id" | "createdAt" | "updatedAt">): Run {
    const now = new Date().toISOString();
    const run: Run = { ...data, id: randomUUID(), createdAt: now, updatedAt: now };
    this.upsert(run, { projectId: run.projectId, parentId: run.taskId });
    return run;
  }
}

export class CostRepository extends DocumentRepository<CostRecord> {
  constructor(db: Db = getDb()) {
    super("cost", db);
  }
  create(data: Omit<CostRecord, "id" | "createdAt">): CostRecord {
    const rec: CostRecord = { ...data, id: randomUUID(), createdAt: new Date().toISOString() };
    this.upsert(rec, { projectId: rec.projectId, parentId: rec.agentId });
    return rec;
  }
  totals(filter: { projectId?: string; agentId?: string } = {}): { tokens: number; costUsd: number; runs: number; calls: number } {
    const records = this.findMany({
      projectId: filter.projectId,
      parentId: filter.agentId,
    });
    let tokens = 0;
    let costUsd = 0;
    for (const r of records) {
      tokens += r.data.totalTokens;
      costUsd += r.data.estimatedCostUsd;
    }
    return { tokens, costUsd, runs: records.length, calls: records.length };
  }
}

export class AuditRepository extends DocumentRepository<AuditLog> {
  constructor(db: Db = getDb()) {
    super("audit", db);
  }
  record(data: Omit<AuditLog, "id" | "createdAt">): AuditLog {
    const log: AuditLog = { ...data, id: randomUUID(), createdAt: new Date().toISOString() };
    this.upsert(log);
    return log;
  }
}

export class NotificationRepository extends DocumentRepository<Notification> {
  constructor(db: Db = getDb()) {
    super("notification", db);
  }
  create(data: Omit<Notification, "id" | "createdAt" | "read">): Notification {
    const n: Notification = { ...data, id: randomUUID(), read: false, createdAt: new Date().toISOString() };
    this.upsert(n, { projectId: data.projectId });
    return n;
  }
  markRead(id: string): void {
    const rec = this.findById(id);
    if (rec) this.upsert({ ...rec.data, read: true });
  }
}

export function getRunRepo(): RunRepository {
  return new RunRepository();
}
export function getCostRepo(): CostRepository {
  return new CostRepository();
}
export function getAuditRepo(): AuditRepository {
  return new AuditRepository();
}
export function getNotificationRepo(): NotificationRepository {
  return new NotificationRepository();
}
