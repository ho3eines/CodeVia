import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import {
  ADMIN_GITHUB_SETTINGS_KEY,
  getGitHubAdminSettings,
  saveGitHubAdminSettings,
} from "../auth/admin-settings.js";
import { freshDb } from "./test-helpers.js";
import type { FastifyInstance } from "fastify";

/* ------------------------------------------------------------------ *\
 * Regression tests for "I have to re-enter the GitHub settings after
 * every deploy": the admin settings live in the (ephemeral) runtime DB,
 * so the platform offers (1) backup/restore of the non-secret login
 * settings and (2) storage diagnostics that flag ephemeral databases.
 * ------------------------------------------------------------------ */

let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;

async function boot(): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  const built = await buildServer(container);
  app = built.app;
  await app.ready();
  return app;
}

beforeEach(() => {
  process.env.AUTH_SECRET = "test-auth-secret-for-settings-tests-0123456";
  getEnvFresh();
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  getEnvFresh();
  cleanup?.();
});

describe("settings backup/restore (ephemeral-DB fallback)", () => {
  it("backup includes the admin GitHub login settings", async () => {
    const srv = await boot();
    saveGitHubAdminSettings(container.kv, {
      clientId: "Ov23liBACKUPTEST123",
      callbackUrl: "https://x.example/auth/github/callback",
      scope: "read:user user:email",
      requireAuth: true,
    });
    const res = await srv.inject({ method: "GET", url: "/settings/backup" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.adminSettings).toMatchObject({ clientId: "Ov23liBACKUPTEST123", requireAuth: true });
    expect(body.secretsIncluded).toBe(false);
  });

  it("restore puts wiped settings back (simulated deploy wipe)", async () => {
    const srv = await boot();
    saveGitHubAdminSettings(container.kv, { clientId: "Ov23liBACKUPTEST123", requireAuth: true });
    const backup = (await srv.inject({ method: "GET", url: "/settings/backup" })).json();

    // Simulate the Railway ephemeral-storage wipe: the kv row disappears.
    container.kv.delete(ADMIN_GITHUB_SETTINGS_KEY);
    expect(getGitHubAdminSettings(container.kv)).toEqual({});

    const res = await srv.inject({
      method: "POST",
      url: "/settings/restore",
      headers: { "content-type": "application/json" },
      payload: { adminSettings: backup.adminSettings },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(getGitHubAdminSettings(container.kv)).toMatchObject({
      clientId: "Ov23liBACKUPTEST123",
      requireAuth: true,
    });
  });

  it("rejects restore payloads without adminSettings or with invalid values", async () => {
    const srv = await boot();
    const missing = await srv.inject({
      method: "POST",
      url: "/settings/restore",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const bad = await srv.inject({
      method: "POST",
      url: "/settings/restore",
      headers: { "content-type": "application/json" },
      payload: { adminSettings: { clientId: "bad id with spaces" } },
    });
    expect(bad.statusCode).toBe(400);
    expect(getGitHubAdminSettings(container.kv)).toEqual({});
  });
});

describe("admin health storage diagnostics", () => {
  it("reports the database path, platform and persistence state", async () => {
    const srv = await boot();
    const res = await srv.inject({ method: "GET", url: "/admin/health" });
    expect(res.statusCode).toBe(200);
    const storage = res.json().storage;
    expect(storage).toBeDefined();
    expect(typeof storage.path).toBe("string");
    expect(typeof storage.dir).toBe("string");
    expect(["railway", "docker", "host"]).toContain(storage.platform);
  });
});
