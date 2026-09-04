import { describe, it, expect } from "vitest";
import { parseCron, isValidCron, cronMatches, nextCronTime, cronIsDue } from "./cron.js";

describe("backup cron parser", () => {
  it("accepts simple five-field expressions", () => {
    expect(isValidCron("0 * * * *")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("30 3 * * *")).toBe(true);
    expect(isValidCron("0 0 * * 1")).toBe(true);
    expect(parseCron("0 * * * *")).toBeDefined();
  });

  it("rejects malformed schedules", () => {
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("0 * * *")).toBe(false); // four fields
    expect(isValidCron("60 * * * *")).toBe(false); // minute out of range
    expect(isValidCron("0 24 * * *")).toBe(false); // hour out of range
    expect(isValidCron("0 * * * 8")).toBe(false); // weekday out of range
    expect(isValidCron("a * * * *")).toBe(false);
  });

  it("matches against a clock", () => {
    const date = new Date("2026-09-04T03:30:00.000Z");
    expect(cronMatches("30 3 * * *", date)).toBe(true);
    expect(cronMatches("0 3 * * *", date)).toBe(false);
    expect(cronMatches("30 2 * * *", date)).toBe(false);
  });

  it("computes the next run after a given time", () => {
    const from = new Date("2026-09-04T03:30:00.000Z");
    const next = nextCronTime("0 4 * * *", from);
    expect(next?.toISOString()).toBe("2026-09-04T04:00:00.000Z");
  });

  it("does not run twice in the same minute", () => {
    const now = new Date("2026-09-04T03:30:00.000Z");
    expect(cronIsDue("30 * * * *", now, undefined)).toBe(true);
    expect(cronIsDue("30 * * * *", now, "2026-09-04T03:30:01.000Z")).toBe(false);
    expect(cronIsDue("30 * * * *", now, "2026-09-04T03:29:59.000Z")).toBe(true);
  });
});
