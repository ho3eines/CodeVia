import { getEnv } from "./config/env.js";
import type { LogLevel } from "./types.js";

type LogFn = (msg: string, meta?: Record<string, unknown>) => void;

export interface Logger {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child: (bindings: Record<string, unknown>) => Logger;
}

const LEVELS: Record<LogLevel | "trace" | "debug" | "info" | "warn" | "error" | "fatal", number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const COLORS: Record<string, string> = {
  trace: "\x1b[90m",
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[41m\x1b[37m",
};
const RESET = "\x1b[0m";

/**
 * Minimal structured logger (JSON in production, human-readable in dev).
 * Swappable — Fastify/pino can replace this without touching call sites.
 */
export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  let levelName: LogLevel = "info";
  try {
    levelName = getEnv().LOG_LEVEL;
  } catch {
    /* ignore */
  }
  const threshold = LEVELS[levelName] ?? LEVELS.info;

  function write(level: keyof typeof LEVELS, msg: string, meta?: Record<string, unknown>) {
    if (LEVELS[level] < threshold) return;
    const ts = new Date().toISOString();
    const all = { ...bindings, ...(meta ?? {}) };
    const isProd = process.env.NODE_ENV === "production";
    const line = isProd
      ? JSON.stringify({ ts, level, msg, ...all })
      : `${COLORS[level] ?? ""}[${ts}] ${level.toUpperCase().padEnd(5)}${RESET} ${msg} ${
          Object.keys(all).length ? JSON.stringify(all) : ""
        }`;
    // eslint-disable-next-line no-console
    (level === "error" || level === "fatal" ? console.error : console.log)(line);
  }

  return {
    trace: (m, meta) => write("trace", m, meta),
    debug: (m, meta) => write("debug", m, meta),
    info: (m, meta) => write("info", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    error: (m, meta) => write("error", m, meta),
    fatal: (m, meta) => write("fatal", m, meta),
    child: (b) => createLogger({ ...bindings, ...b }),
  };
}

export const logger = createLogger({ component: "app" });
