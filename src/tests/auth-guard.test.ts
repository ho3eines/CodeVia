import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnvFresh, parseEnvBoolean } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { saveGitHubAdminSettings } from "../auth/admin-settings.js";
import { signSession } from "../auth/github-oauth.js";
import { freshDb } from "./test-helpers.js";
import type { FastifyInstance } from "fastify";

/* ------------------------------------------------------------------ *
 * Regression tests for the "everything is 401" production lockout:
 *   - REQUIRE_AUTH=false was coerced to true (Boolean("false") === true)
 *   - the SPA shell (/app.js, /app.css) was gated behind auth -> blank page
 *   - strict mode with no way to log in bricked the Admin page needed to fix it
 * ------------------------------------------------------------------ */

const ENV_KEYS = [
  "REQUIRE_AUTH",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "AUTH_SECRET",
  "GITHUB_OAUTH_SCOPE",
] as const;

let savedEnv: Record<string, string | undefined>;
let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  getEnvFresh();
}

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
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_SECRET = "test-auth-secret-for-guard-tests-0123456789";
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
  getEnvFresh();
  cleanup?.();
});

describe("environment boolean parsing", () => {
  it("understands the usual truthy/falsy spellings", () => {
    for (const v of ["true", "TRUE", " True ", "1", "yes", "on"]) expect(parseEnvBoolean(v)).toBe(true);
    for (const v of ["false", "FALSE", "0", "no", "off"]) expect(parseEnvBoolean(v)).toBe(false);
    expect(parseEnvBoolean("")).toBeUndefined();
    expect(parseEnvBoolean(undefined)).toBeUndefined();
  });

  it("REQUIRE_AUTH=false is false (regression: Boolean('false') === true)", () => {
    setEnv("REQUIRE_AUTH", "false");
    expect(getEnvFresh().REQUIRE_AUTH).toBe(false);
    setEnv("REQUIRE_AUTH", "0");
    expect(getEnvFresh().REQUIRE_AUTH).toBe(false);
    setEnv("REQUIRE_AUTH", "true");
    expect(getEnvFresh().REQUIRE_AUTH).toBe(true);
    setEnv("REQUIRE_AUTH", undefined);
    expect(getEnvFresh().REQUIRE_AUTH).toBe(false);
  });

  it("rejects garbage instead of silently enabling a flag", () => {
    process.env.REQUIRE_AUTH = "maybe";
    expect(() => getEnvFresh()).toThrow(/REQUIRE_AUTH/);
    delete process.env.REQUIRE_AUTH;
    getEnvFresh();
  });
});

describe("auth guard — demo mode (REQUIRE_AUTH unset)", () => {
  it("serves the SPA shell and the API without a session", async () => {
    const srv = await boot();
    for (const url of ["/", "/app.js", "/app.css", "/auth/me", "/dashboard", "/projects"]) {
      const res = await srv.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
    const me = (await srv.inject({ method: "GET", url: "/auth/me" })).json();
    expect(me.authenticated).toBe(false);
    expect(me.user.externalId).toBe("demo");
  });
});

describe("auth guard — strict mode with GitHub login configured", () => {
  beforeEach(() => {
    setEnv("REQUIRE_AUTH", "true");
    setEnv("GITHUB_CLIENT_ID", "Ov23liTESTCLIENTID");
    setEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
  });

  it("rejects API calls without a session", async () => {
    const srv = await boot();
    for (const url of ["/auth/me", "/dashboard", "/projects", "/admin/settings", "/integrations/github/status"]) {
      const res = await srv.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().message).toMatch(/Authentication required/);
    }
  });

  it("keeps the SPA shell, static assets, socket.io and the OAuth handshake public", async () => {
    const srv = await boot();
    for (const url of ["/", "/app.js", "/app.css", "/index.html", "/health", "/ready", "/auth/github/status"]) {
      const res = await srv.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
    const js = await srv.inject({ method: "GET", url: "/app.js" });
    expect(js.headers["content-type"]).toMatch(/javascript/);
    const login = await srv.inject({ method: "GET", url: "/auth/github/login" });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    // Socket.io handshake must not be blocked (it only carries observable status events).
    const sio = await srv.inject({ method: "GET", url: "/socket.io/?EIO=4&transport=polling" });
    expect(sio.statusCode).toBe(200);
  });

  it("serves index.html for browser navigations to unknown hash-less paths", async () => {
    const srv = await boot();
    const res = await srv.inject({ method: "GET", url: "/some/deep/link", headers: { accept: "text/html,*/*" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    // …but JSON/fetch clients hitting unknown URLs are still gated.
    const api = await srv.inject({ method: "GET", url: "/some/deep/link", headers: { accept: "application/json" } });
    expect(api.statusCode).toBe(401);
  });

  it("accepts a valid session (Bearer or cookie)", async () => {
    const srv = await boot();
    const { user } = container.userRepo.upsertGitHubUser({ id: 42, login: "octocat", name: "Octo", email: "o@x.test" });
    const token = signSession(user.id);
    const bearer = await srv.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(bearer.statusCode).toBe(200);
    expect(bearer.json().authenticated).toBe(true);
    expect(bearer.json().user.role).toBe("owner");
    const cookie = await srv.inject({ method: "GET", url: "/projects", headers: { cookie: `cv_session=${encodeURIComponent(token)}` } });
    expect(cookie.statusCode).toBe(200);
  });

  it("login?next= only round-trips safe in-app hash routes", async () => {
    const srv = await boot();
    const ok = (await srv.inject({ method: "GET", url: "/auth/github/login?format=json&next=%23%2Fadmin" })).json();
    const { readOAuthState } = await import("../auth/github-oauth.js");
    expect(readOAuthState(ok.state)?.next).toBe("#/admin");
    const bad = (await srv.inject({ method: "GET", url: "/auth/github/login?format=json&next=https%3A%2F%2Fevil.example" })).json();
    expect(readOAuthState(bad.state)?.next).toBeUndefined();
  });
});

describe("auth guard — strict mode WITHOUT GitHub login configured", () => {
  it("falls back to demo mode instead of locking everyone out", async () => {
    setEnv("REQUIRE_AUTH", "true");
    const srv = await boot();
    for (const url of ["/", "/app.js", "/auth/me", "/dashboard", "/admin/settings"]) {
      const res = await srv.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
    const status = (await srv.inject({ method: "GET", url: "/auth/github/status" })).json();
    expect(status.configured).toBe(false);
  });

  it("admin toggle can enable strict mode once login is configured", async () => {
    setEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
    const srv = await boot();
    // Not yet: no client id anywhere.
    expect((await srv.inject({ method: "GET", url: "/dashboard" })).statusCode).toBe(200);
    // Admin sets client id + requireAuth (this is what the #/admin page does).
    saveGitHubAdminSettings(container.kv, { clientId: "Ov23liADMINSET", requireAuth: true }, "user-demo");
    expect((await srv.inject({ method: "GET", url: "/dashboard" })).statusCode).toBe(401);
    // SPA shell still loads so the login button is reachable.
    expect((await srv.inject({ method: "GET", url: "/app.js" })).statusCode).toBe(200);
    // Admin turns it back off.
    saveGitHubAdminSettings(container.kv, { requireAuth: false }, "user-demo");
    expect((await srv.inject({ method: "GET", url: "/dashboard" })).statusCode).toBe(200);
  });
});
