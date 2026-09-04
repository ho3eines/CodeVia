import { getContainer } from "./app/container.js";
import { buildServer } from "./http/app.js";
import { getEnv } from "./config/env.js";
import { checkStoragePath, StoragePreflightError } from "./app/storage-preflight.js";
import { getEffectiveGitHubLoginSettings } from "./auth/admin-settings.js";
import { getLocalhostCallbackWarning } from "./auth/github-oauth.js";
import { logger } from "./logger.js";

async function main() {
  const env = getEnv();

  // Fail fast — and loudly — when the runtime store path is unusable. Opening
  // the DB is the first thing the container does, and node:sqlite reports a
  // non-writable volume as a bare `unable to open database file`, which made
  // Railway crash-loops unreadable.
  const storage = checkStoragePath(env.DATABASE_PATH);
  if (!storage.writable) {
    throw new StoragePreflightError(storage);
  }

  const container = getContainer();
  await container.ensureSeed();

  // Bring up the Telegram receive path: register the webhook when a public
  // HTTPS URL exists, otherwise long-poll `getUpdates` so a token-only setup
  // still works (no tunnel, no ngrok). Mock/off modes no-op with a log line.
  await container.startTelegram().catch((err) => {
    logger.warn("telegram receive path could not start", { err: String(err) });
  });

  // Startup guard: a local-address OAuth callback in production means the login
  // flow can never complete (the browser cannot be redirected back to localhost).
  // Log loudly instead of failing silently with 401s after "successful" login.
  if (env.NODE_ENV === "production") {
    try {
      const eff = getEffectiveGitHubLoginSettings(container.kv);
      const warning = eff.configured ? getLocalhostCallbackWarning(eff.redirectUri) : undefined;
      if (warning) logger.warn(warning);
    } catch {
      /* diagnostics only — never block startup */
    }
  }

  const { app, io } = await buildServer(container);

  // Start the background worker so job enqueues are consumed off the UI thread.
  const stopWorker = await container.worker.start(1000);

  // Start the admin-configured system backup scheduler (reads settings from the
  // kv store; runs a full GitHub snapshot whenever the cron expression matches).
  const stopBackupScheduler = container.backupScheduler.start();

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info(`CodeVia platform listening on http://${env.HOST}:${env.PORT} (env=${env.NODE_ENV})`);

  const shutdown = async (signal: string) => {
    logger.warn(`received ${signal}, shutting down`);
    await container.stopTelegram().catch(() => undefined);
    stopBackupScheduler();
    stopWorker();
    io.close();
    await app.close();
    container.db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  const detail = err instanceof Error ? (err.stack || `${err.name}: ${err.message}`) : String(err);
  // A storage failure has an actionable hint; surface it in the message too, not
  // just in the metadata (platform log viewers often show only the message).
  const headline = err instanceof StoragePreflightError ? `unusable storage path: ${err.message}` : detail.split("\n")[0];
  const errno = (err as NodeJS.ErrnoException | null)?.code;
  logger.fatal(`fatal startup error: ${headline}`, { error: detail, code: errno });
  // Railway's log viewer may display only the structured message and hide
  // metadata fields, so print the underlying startup failure verbatim as well.
  console.error(`fatal startup error: ${detail}`);
  process.exit(1);
});
