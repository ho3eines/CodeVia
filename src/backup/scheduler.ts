import type { KvStore } from "../db/kv.js";
import type { BackupService } from "./service.js";
import { getBackupSettings } from "./settings.js";
import { cronIsDue, cronMatches } from "./cron.js";
import type { Logger } from "../logger.js";

export interface BackupSchedulerDeps {
  kv: KvStore;
  backup: BackupService;
  logger: Logger;
}

/**
 * Polls the admin backup configuration every few seconds and runs a full GitHub
 * backup whenever the cron expression matches the current minute. It is kept
 * simple and stateless: `lastRunAt` in the kv settings prevents double-running
 * the same minute, and `BackupService` refuses overlapping runs.
 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private lastCheckedMinute = -1;

  constructor(private readonly deps: BackupSchedulerDeps) {}

  start(pollMs = 15_000): () => void {
    if (this.timer) return () => undefined;
    this.timer = setInterval(() => {
      void this.tick();
    }, pollMs);
    this.deps.logger.info(`system backup scheduler started (poll ${pollMs}ms)`);
    return () => {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(now = new Date()): Promise<void> {
    const settings = getBackupSettings(this.deps.kv);
    if (!settings.enabled || !settings.schedule || !settings.repo) return;
    if (this.lastCheckedMinute === minuteKey(now)) return;
    this.lastCheckedMinute = minuteKey(now);

    if (!cronMatches(settings.schedule, now)) return;
    if (!cronIsDue(settings.schedule, now, settings.lastRunAt)) return;

    this.deps.logger.info("system backup scheduler is due", { schedule: settings.schedule });
    const result = await this.deps.backup.runNow();
    if (result.ok) {
      this.deps.logger.info("scheduled system backup completed", { commit: result.commit, files: result.files, warning: result.warning });
    } else {
      this.deps.logger.warn("scheduled system backup failed", { error: result.error, warning: result.warning });
    }
  }
}

function minuteKey(d: Date): number {
  return d.getFullYear() * 100000000 + (d.getMonth() + 1) * 1000000 + d.getDate() * 10000 + d.getHours() * 100 + d.getMinutes();
}
