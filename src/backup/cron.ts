/**
 * Minimal, dependency-free cron parser used by the admin-configured System
 * Backup scheduler. Supports the classic five-field POSIX cron syntax:
 *
 *   minute hour day-of-month month day-of-week
 *
 * Each field supports `*`, a step (`/n`), a range (`a-b`) and comma-separated
 * lists. Day-of-week accepts 0–7 (both 0 and 7 mean Sunday).
 */

export interface CronParts {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

const RANGES: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week
];

function normalizeDayOfWeek(value: number): number {
  // 7 is an alias for Sunday (0) in cron.
  return value === 7 ? 0 : value;
}

function parseField(expr: string, min: number, max: number): Set<number> | undefined {
  const out = new Set<number>();
  for (const rawPart of expr.split(",")) {
    const part = rawPart.trim();
    if (!part) return undefined;
    const stepMatch = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!stepMatch) return undefined;
    const [, startRaw, endRaw, stepRaw] = stepMatch;
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) return undefined;

    let start: number;
    let end: number;
    if (startRaw === undefined) {
      start = min;
      end = max;
    } else {
      start = Number(startRaw);
      end = endRaw !== undefined ? Number(endRaw) : start;
      if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
      if (end < start) return undefined;
      if (start < min || end > max) return undefined;
    }
    for (let v = start; v <= end; v += step) {
      out.add(v);
    }
  }
  return out;
}

/** Parse a five-field cron expression, or `undefined` when invalid. */
export function parseCron(expr: string): CronParts | undefined {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const fields = [];
  for (let i = 0; i < 5; i++) {
    const range = RANGES[i];
    const parsed = parseField(parts[i], range.min, range.max);
    if (!parsed) return undefined;
    fields.push(parsed);
  }
  const dayOfWeek = new Set<number>();
  for (const v of fields[4]) dayOfWeek.add(normalizeDayOfWeek(v));
  return {
    minute: fields[0],
    hour: fields[1],
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek,
  };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== undefined;
}

/** Does `date` match the cron expression? */
export function cronMatches(expr: string, date = new Date()): boolean {
  const parts = parseCron(expr);
  if (!parts) return false;
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();
  return (
    parts.minute.has(date.getMinutes()) &&
    parts.hour.has(date.getHours()) &&
    parts.dayOfMonth.has(day) &&
    parts.month.has(month) &&
    parts.dayOfWeek.has(dow)
  );
}

/**
 * Returns the next time (on a minute boundary, strictly after `from`) matching
 * the expression, or undefined when the expression is invalid or no such time
 * exists within a conservative search window (3 years).
 */
export function nextCronTime(expr: string, from = new Date()): Date | undefined {
  const parts = parseCron(expr);
  if (!parts) return undefined;
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = new Date(from);
  limit.setFullYear(limit.getFullYear() + 3);
  while (candidate <= limit) {
    const day = candidate.getDate();
    const month = candidate.getMonth() + 1;
    const dow = candidate.getDay();
    if (
      parts.minute.has(candidate.getMinutes()) &&
      parts.hour.has(candidate.getHours()) &&
      parts.dayOfMonth.has(day) &&
      parts.month.has(month) &&
      parts.dayOfWeek.has(dow)
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return undefined;
}

/**
 * True when the scheduler should run a backup at `now`: the current minute
 * matches the expression and we have not already run during this minute.
 */
export function cronIsDue(expr: string, now: Date, lastRunAt?: string): boolean {
  if (!cronMatches(expr, now)) return false;
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  return !Number.isNaN(last.getTime()) && (
    last.getFullYear() !== now.getFullYear() ||
    last.getMonth() !== now.getMonth() ||
    last.getDate() !== now.getDate() ||
    last.getHours() !== now.getHours() ||
    last.getMinutes() !== now.getMinutes()
  );
}
