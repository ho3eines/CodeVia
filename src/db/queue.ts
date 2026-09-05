import { getDb, nowIso } from "./client.js";
import type { Db } from "./client.js";
import { randomUUID } from "node:crypto";
import type { JobStatus } from "../types.js";
import type { Job } from "../domain/entities.js";

export type JobType = "agent.run" | "telegram.send" | "webhook" | "github.op" | "notify" | "workflow.run";

export interface EnqueueOptions {
  maxAttempts?: number;
  scheduledAt?: string;
  correlationId?: string;
}

/**
 * Backing store for the worker queue. Idempotency is supported via a dedupe key
 * (jobs carry an id derived from the producer's correlation id + type).
 */
export class JobQueue {
  constructor(private db: Db = getDb()) {}

  enqueue(type: JobType, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Job {
    const id = randomUUID();
    this.db.run(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, correlation_id, scheduled_at, created_at, updated_at)
       VALUES (:id, :type, 'pending', :payload, 0, :max_attempts, :correlation_id, :scheduled_at, :created_at, :updated_at)`,
      {
        id,
        type,
        payload: JSON.stringify(payload),
        max_attempts: opts.maxAttempts ?? 3,
        correlation_id: opts.correlationId ?? null,
        scheduled_at: opts.scheduledAt ?? null,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    );
    return this.getById(id)!;
  }

  getById(id: string): Job | undefined {
    const row = this.db.get(`SELECT * FROM jobs WHERE id = :id`, { id }) as Record<string, unknown> | undefined;
    return row ? this.mapJob(row) : undefined;
  }

  /** Claim a batch of pending jobs (oldest first by created_at). */
  claim(limit = 5): Job[] {
    // Select the due jobs first, then flip exactly those ids to running. Only the
    // freshly-claimed rows are returned — a job that is still running from a
    // previous poll (e.g. blocked on a human approval) must never be handed out
    // again, otherwise the worker would start it twice.
    const now = nowIso();
    const due = this.db.all(
      `SELECT id FROM jobs
       WHERE (status = 'pending' OR (status = 'retrying' AND scheduled_at <= :now))
         AND (scheduled_at IS NULL OR scheduled_at <= :now)
       ORDER BY created_at ASC
       LIMIT :limit`,
      { now, limit },
    ) as Array<{ id: string }>;
    const claimed: Job[] = [];
    for (const { id } of due) {
      this.db.run(
        `UPDATE jobs SET status = 'running', started_at = :started_at, updated_at = :updated_at
         WHERE id = :id AND status IN ('pending', 'retrying')`,
        { started_at: now, updated_at: now, id },
      );
      const job = this.getById(id);
      if (job && job.status === "running") claimed.push(job);
    }
    return claimed;
  }

  update(id: string, patch: Partial<Pick<Job, "status" | "attempts" | "error" | "finishedAt">>): Job | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;
    const next: Job = {
      ...existing,
      status: patch.status ?? existing.status,
      attempts: patch.attempts ?? existing.attempts,
      error: patch.error ?? existing.error,
      finishedAt: patch.finishedAt ?? existing.finishedAt,
    };
    this.db.run(
      `UPDATE jobs SET status = :status, attempts = :attempts, error = :error, finished_at = :finished_at, updated_at = :updated_at
       WHERE id = :id`,
      {
        id,
        status: next.status,
        attempts: next.attempts,
        error: next.error ?? null,
        finished_at: next.finishedAt ?? null,
        updated_at: nowIso(),
      },
    );
    return this.getById(id);
  }

  /** Idempotent enqueue: if a job with the same correlation id + type exists, return it. */
  enqueueIdempotent(type: JobType, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Job {
    if (opts.correlationId) {
      const existing = this.db.get(
        `SELECT * FROM jobs WHERE correlation_id = :correlation_id AND type = :type`,
        { correlation_id: opts.correlationId, type },
      ) as Record<string, unknown> | undefined;
      if (existing) return this.mapJob(existing);
    }
    return this.enqueue(type, payload, opts);
  }

  stats(): Record<string, number> {
    const rows = this.db.all(`SELECT status, COUNT(*) as n FROM jobs GROUP BY status`) as {
      status: JobStatus;
      n: number;
    }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  private mapJob(row: Record<string, unknown>): Job {
    return {
      id: row.id as string,
      type: row.type as string,
      status: row.status as JobStatus,
      payload: JSON.parse(row.payload as string),
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      correlationId: (row.correlation_id as string) ?? undefined,
      scheduledAt: (row.scheduled_at as string) ?? undefined,
      startedAt: (row.started_at as string) ?? undefined,
      finishedAt: (row.finished_at as string) ?? undefined,
      error: (row.error as string) ?? undefined,
      createdAt: row.created_at as string,
    };
  }
}

export function getQueue(): JobQueue {
  return new JobQueue();
}
