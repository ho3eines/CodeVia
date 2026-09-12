import { getDb, nowIso } from "./client.js";
import type { Db } from "./client.js";
import { randomUUID } from "node:crypto";
import type { JobStatus } from "../types.js";
import type { Job } from "../domain/entities.js";
import { correlationId, currentCorrelationId } from "../correlation.js";

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
        correlation_id: opts.correlationId ?? currentCorrelationId() ?? correlationId(),
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

  /**
   * Recover execution rows owned by a worker process that disappeared.
   *
   * The current SQLite deployment runs one in-process worker. Consequently a
   * `running` row found before that worker starts cannot still have a live
   * owner. Leaving it untouched permanently wedges both the job and its task.
   * Count the interrupted attempt and put it back at the front of the normal
   * retry path (or dead-letter it when its retry budget is exhausted).
   *
   * Deliberately limited to agent/workflow execution: blindly replaying an
   * interrupted GitHub mutation or notification could duplicate an external
   * side effect whose acknowledgement was lost during shutdown.
   *
   * When `olderThanMs` is given, only rows whose claim is older than that lease
   * are recovered (used by `claim()` so a job being actively processed by a
   * live worker is never stolen, while a job abandoned by a dead one is).
   */
  recoverInterruptedExecutions(olderThanMs?: number): { retrying: Job[]; dead: Job[] } {
    return this.db.tx(() => {
      const cutoff = olderThanMs ? new Date(Date.now() - olderThanMs).toISOString() : undefined;
      const rows = this.db.all(
        cutoff
          ? `SELECT * FROM jobs
             WHERE status = 'running' AND type IN ('agent.run', 'workflow.run')
               AND (started_at IS NOT NULL AND started_at < :cutoff)
             ORDER BY created_at ASC`
          : `SELECT * FROM jobs
             WHERE status = 'running' AND type IN ('agent.run', 'workflow.run')
             ORDER BY created_at ASC`,
        cutoff ? { cutoff } : {},
      ) as Record<string, unknown>[];
      const retrying: Job[] = [];
      const dead: Job[] = [];
      const now = nowIso();
      for (const row of rows) {
        const attempts = Number(row.attempts) + 1;
        const maxAttempts = Number(row.max_attempts);
        const exhausted = attempts >= maxAttempts;
        const error = `Worker interrupted while processing attempt ${attempts}/${maxAttempts}`;
        this.db.run(
          `UPDATE jobs
           SET status = :status, attempts = :attempts, scheduled_at = NULL,
               started_at = NULL, finished_at = :finished_at, error = :error,
               updated_at = :now
           WHERE id = :id AND status = 'running'`,
          {
            id: String(row.id),
            status: exhausted ? "dead" : "pending",
            attempts,
            finished_at: exhausted ? now : null,
            error,
            now,
          },
        );
        const recovered = this.getById(String(row.id));
        if (recovered) (exhausted ? dead : retrying).push(recovered);
      }
      return { retrying, dead };
    });
  }

  /** A running execution job whose claim is this old has no live owner. */
  static readonly LEASE_TTL_MS = 10 * 60 * 1000;

  /** Claim a batch of pending jobs (oldest first by created_at). */
  claim(limit = 5): Job[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    // A worker/queue recreated after a crash must be able to reclaim execution
    // jobs a dead owner left in `running` (A12): recover expired leases first,
    // then claim normally. Age-gated so an in-flight job is never stolen.
    this.recoverInterruptedExecutions(JobQueue.LEASE_TTL_MS);
    const now = nowIso();
    // One UPDATE…RETURNING statement owns the claim. A SELECT followed by an
    // UPDATE can return another worker's already-running row after losing the race.
    const rows = this.db.all(
      `UPDATE jobs SET status = 'running', started_at = :now, updated_at = :now
       WHERE id IN (
         SELECT id FROM jobs
         WHERE status IN ('pending', 'retrying')
           AND (scheduled_at IS NULL OR scheduled_at <= :now)
         ORDER BY created_at ASC LIMIT :limit
       ) AND status IN ('pending', 'retrying')
       RETURNING *`,
      { now, limit: Math.min(100, Math.floor(limit)) },
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapJob(row)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** A cancelled execution may still be unwinding; do not overwrite its cancellation by retrying early. */
  hasRunningTask(taskId: string): boolean {
    const cutoff = new Date(Date.now() - JobQueue.LEASE_TTL_MS).toISOString();
    return !!this.db.get(
      `SELECT id FROM jobs WHERE status = 'running' AND type IN ('agent.run', 'workflow.run') AND json_extract(payload, '$.taskId') = :taskId AND (started_at IS NULL OR started_at >= :cutoff) LIMIT 1`,
      { taskId, cutoff },
    );
  }

  /**
   * True when a worker job for this task is actually live (enqueued and not yet
   * claimed, or being processed). Jobs that finished — including dead-lettered
   * ones (`status = 'dead'`) and `running` rows whose lease has expired — do
   * NOT count, so a task stranded as non-terminal by a job that died can be
   * re-run instead of being reported "in flight".
   */
  hasLiveJob(taskId: string): boolean {
    const cutoff = new Date(Date.now() - JobQueue.LEASE_TTL_MS).toISOString();
    return !!this.db.get(
      `SELECT id FROM jobs WHERE status IN ('pending', 'running') AND type IN ('agent.run', 'workflow.run') AND json_extract(payload, '$.taskId') = :taskId AND (status = 'pending' OR started_at IS NULL OR started_at >= :cutoff) LIMIT 1`,
      { taskId, cutoff },
    );
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
      const existing = this.db.get(`SELECT * FROM jobs WHERE correlation_id = :correlation_id AND type = :type`, {
        correlation_id: opts.correlationId,
        type,
      }) as Record<string, unknown> | undefined;
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

  /**
   * Operational metrics for the queue: backlog size, retry and dead-letter
   * counts, and the age of the oldest waiting/retrying job (queue lag). Used by
   * the SLO instrumentation and `/admin/queue`.
   */
  metrics(): {
    total: number;
    byStatus: Partial<Record<JobStatus, number>>;
    pending: number;
    retrying: number;
    deadLetter: number;
    oldestPendingAgeMs: number | null;
    oldestRetryingAgeMs: number | null;
  } {
    const rows = this.db.all(`SELECT status, COUNT(*) as n FROM jobs GROUP BY status`) as {
      status: string;
      n: number;
    }[];
    const byStatus: Partial<Record<JobStatus, number>> = {};
    let total = 0;
    for (const r of rows) {
      const n = Number(r.n);
      byStatus[r.status as JobStatus] = n;
      total += n;
    }
    const ageOf = (status: JobStatus): number | null => {
      const row = this.db.get(`SELECT created_at FROM jobs WHERE status = :status ORDER BY created_at ASC LIMIT 1`, {
        status,
      }) as { created_at: string } | undefined;
      return row ? Math.max(0, Date.now() - new Date(row.created_at).getTime()) : null;
    };
    return {
      total,
      byStatus,
      pending: byStatus.pending ?? 0,
      retrying: byStatus.retrying ?? 0,
      deadLetter: byStatus.dead ?? 0,
      oldestPendingAgeMs: ageOf("pending"),
      oldestRetryingAgeMs: ageOf("retrying"),
    };
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
