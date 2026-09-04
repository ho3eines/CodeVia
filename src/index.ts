import { getContainer } from "./app/container.js";
import { buildServer } from "./http/app.js";
import { getEnv } from "./config/env.js";
import { getEffectiveGitHubLoginSettings } from "./auth/admin-settings.js";
import { getLocalhostCallbackWarning } from "./auth/github-oauth.js";
import { logger } from "./logger.js";

async function main() {
  const env = getEnv();
  const container = getContainer();
  await container.ensureSeed();

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

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info(`CodeVia platform listening on http://${env.HOST}:${env.PORT} (env=${env.NODE_ENV})`);

  const shutdown = async (signal: string) => {
    logger.warn(`received ${signal}, shutting down`);
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
  logger.fatal("fatal startup error", { error: detail });
  // Railway's log viewer may display only the structured message and hide
  // metadata fields. Print the actual startup failure as a separate line so
  // volume/permission, SQLite, and environment errors are actionable.
  console.error(`fatal startup error: ${detail}`);
  process.exit(1);
});
