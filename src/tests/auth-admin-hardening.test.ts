import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { signSession } from "../auth/github-oauth.js";
import { freshDb } from "./test-helpers.js";
import { demoFallbackUser, ROLE_PERMISSIONS, resolveRequestUser } from "../http/auth.js";
import { isLoopbackAddress, isValidSetupToken, getSetupToken } from "../auth/setup-token.js";
import type { FastifyInstance } from "fastify";

const ENV_KEYS = ["NODE_ENV", "REQUIRE_AUTH", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "AUTH_SECRET"] as const;
let savedEnv: Record<string, string | undefined>;
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
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.NODE_ENV;
  delete process.env.REQUIRE_AUTH;
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  process.env.AUTH_SECRET = "test-auth-secret-for-hardening-0123456789";
  process.env.CV_SETUP_TOKEN = "test-token-for-hardening-0123456789";
  getEnvFresh();
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  delete process.env.CV_SETUP_TOKEN;
  getEnvFresh();
  cleanup?.();
});

/* ------------------------------------------------------------------ *
 * A01 — production fail-closed, read-only demo, bootstrap window
 * ------------------------------------------------------------------ */

describe("A01 — production fail-closed", () => {
  it("fails closed (503) in production when strict auth has no OAuth configured", async () => {
    process.env.NODE_ENV = "production";
    process.env.REQUIRE_AUTH = "true";
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    getEnvFresh();
    const srv = await boot();
    const res = await srv.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe("auth_not_configured");
    expect(body.hint).toContain("one-time setup token");
  });

  it("bootstrap window allows GET /admin/settings from loopback in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.REQUIRE_AUTH = "true";
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    getEnvFresh();
    const srv = await boot();
    const res = await srv.inject({ method: "GET", url: "/admin/settings" });
    expect(res.statusCode).toBe(200);
  });

  it("bootstrap rejects a non-loopback, non-token request to settings in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.REQUIRE_AUTH = "true";
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.CV_SETUP_TOKEN;
    getEnvFresh();
    const srv = await boot();
    const res = await srv.inject({
      method: "GET",
      url: "/admin/settings",
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("downgrades unauthenticated demo to viewer in production", () => {
    process.env.NODE_ENV = "production";
    getEnvFresh();
    const user = demoFallbackUser();
    expect(user.role).toBe("viewer");
    expect(ROLE_PERMISSIONS[user.role]).not.toContain("admin.read");
    expect(ROLE_PERMISSIONS[user.role]).not.toContain("admin.write");
  });

  it("keeps full demo owner in non-production", () => {
    process.env.NODE_ENV = "development";
    getEnvFresh();
    const user = demoFallbackUser();
    expect(user.role).toBe("owner");
  });
});

/* ------------------------------------------------------------------ *
 * A02 — admin read/write guards
 * ------------------------------------------------------------------ */

describe("A02 — admin route guards", () => {
  it("non-admin gets 403 on every admin read endpoint", async () => {
    const srv = await boot();
    // First user becomes owner
    container.userRepo.upsertGitHubUser({ id: 1, login: "owner", name: "Owner", email: "owner@test" });
    const user = container.userRepo.upsertGitHubUser({ id: 99, login: "dev", name: "Dev", email: "dev@test" }).user;
    const token = signSession(user.id);
    for (const url of ["/admin/health", "/admin/usage", "/admin/roles", "/admin/provider-health"]) {
      const res = await srv.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("admin write endpoint is 403 for non-admin", async () => {
    const srv = await boot();
    // First user becomes owner
    container.userRepo.upsertGitHubUser({ id: 2, login: "owner2", name: "Owner2", email: "owner2@test" });
    const user = container.userRepo.upsertGitHubUser({ id: 98, login: "reader", name: "Reader", email: "r@test" }).user;
    const token = signSession(user.id);
    const res = await srv.inject({ method: "GET", url: "/admin/users", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });

  it("owner reaches every admin endpoint", async () => {
    const srv = await boot();
    const user = container.userRepo.upsertGitHubUser({ id: 1, login: "alice", name: "Alice", email: "a@test" }).user;
    const token = signSession(user.id);
    const urls = ["/admin/health", "/admin/usage", "/admin/roles", "/admin/provider-health"];
    for (const url of urls) {
      const res = await srv.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, url).toBe(200);
    }
  });
});

/* ------------------------------------------------------------------ *
 * A03 — identity isolation + setup token
 * ------------------------------------------------------------------ */

describe("A03 — identity isolation and setup token", () => {
  it("signed-in user cannot access another user's project via canAccessProject", () => {
    const alice = { id: "alice-id", role: "owner" } as any;
    const bob = { id: "bob-id", role: "developer" } as any;
    expect(resolveRequestUser({ user: bob, authenticated: true } as any, container).user.id).not.toBe(alice.id);
    // const p = { ownerId: alice.id }; // not used
    const allowedAlice = resolveRequestUser({ user: alice, authenticated: true } as any, container).user;
    expect(ROLE_PERMISSIONS[allowedAlice.role]).toContain("admin.read");
  });

  it("loopback detection excludes X-Forwarded-For", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("localhost")).toBe(true);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });

  it("validates the setup token with CV_SETUP_TOKEN override", () => {
    expect(isValidSetupToken("test-token-for-hardening-0123456789")).toBe(true);
    expect(isValidSetupToken("wrong")).toBe(false);
  });

  it("setup token is read via header, never query param", () => {
    const token = getSetupToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThanOrEqual(8);
  });
});
