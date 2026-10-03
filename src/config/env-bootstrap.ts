import { defaultEnvFilePaths, loadEnvFiles } from "./env-file.js";

/* ------------------------------------------------------------------ *
 * Environment bootstrap — MUST be the first import of an entrypoint.
 *
 * `src/logger.ts` calls `getEnv()` at module scope, and `getEnv()` memoizes the
 * parsed contract for the whole process. If a `.env` file were read any later
 * than that, every restored API key in it would be invisible: the process would
 * keep the config it parsed before the file existed. That is exactly the
 * failure a backup restore must not have — a server that "restored" its keys
 * but cannot decrypt a single one of them.
 *
 * ESM evaluates imports in source order, so importing this module first makes
 * the file part of the environment before any other module is evaluated.
 * Platform-injected variables still win: `loadEnvFiles` only fills gaps.
 * ------------------------------------------------------------------ */

export const loadedEnv = loadEnvFiles(defaultEnvFilePaths(process.env.DATABASE_PATH));
