import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnvFresh } from "../config/env.js";
import { KvStore } from "../db/kv.js";
import {
  getEffectiveGitHubLoginSettings,
  getEffectiveOAuthConfig,
  getGitHubAdminSettings,
  saveGitHubAdminSettings,
} from "../auth/admin-settings.js";
import { freshDb } from "./test-helpers.js";

const ENV_KEYS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_OAUTH_SCOPE",
  "GITHUB_OAUTH_CALLBACK_URL",
  "REQUIRE_AUTH",
  "GITHUB_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "AUTH_SECRET",
] as const;

let savedEnv: Record<string, string | undefined>;
let cleanup: (() => void) | undefined;

/** getEnv() caches — refresh it after every env mutation. */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  getEnvFresh();
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GITHUB_OAUTH_SCOPE = "read:user user:email";
  getEnvFresh();
  const { cleanup: c } = freshDb();
  cleanup = c;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  getEnvFresh();
  cleanup?.();
});

function kv(): KvStore {
  return new KvStore();
}

describe("admin GitHub settings storage", () => {
  it("starts empty and saves valid values", () => {
    expect(getGitHubAdminSettings(kv())).toEqual({});
    const s = saveGitHubAdminSettings(kv(), {
      clientId: "Ov23.test123",
      callbackUrl: "https://app.example.com/auth/github/callback",
      scope: "read:user",
      requireAuth: true,
    }, "user-1");
    expect(s.clientId).toBe("Ov23.test123");
    expect(s.updatedBy).toBe("user-1");
    expect(getGitHubAdminSettings(kv()).requireAuth).toBe(true);
  });

  it("empty strings clear fields back to env/default", () => {
    saveGitHubAdminSettings(kv(), { clientId: "Ov23.test123", scope: "read:user" });
    const s = saveGitHubAdminSettings(kv(), { clientId: "  ", scope: "" });
    expect(s.clientId).toBeUndefined();
    expect(s.scope).toBeUndefined();
  });

  it("rejects invalid client id, callback url and long scope", () => {
    expect(() => saveGitHubAdminSettings(kv(), { clientId: "!!!" })).toThrow();
    expect(() => saveGitHubAdminSettings(kv(), { callbackUrl: "not-a-url" })).toThrow();
    expect(() => saveGitHubAdminSettings(kv(), { callbackUrl: "ftp://x.test/cb" })).toThrow();
    expect(() => saveGitHubAdminSettings(kv(), { scope: "x".repeat(201) })).toThrow();
  });
});

describe("effective GitHub login settings (env > admin > default)", () => {
  it("unconfigured without client id + secret", () => {
    const eff = getEffectiveGitHubLoginSettings(kv());
    expect(eff.configured).toBe(false);
    expect(eff.setupHint).toBeTruthy();
    expect(getEffectiveOAuthConfig(kv())).toBeUndefined();
  });

  it("admin client id + env secret = configured", () => {
    setEnv("GITHUB_CLIENT_SECRET", "s3cret");
    saveGitHubAdminSettings(kv(), { clientId: "Ov23.admin1" });
    const eff = getEffectiveGitHubLoginSettings(kv());
    expect(eff.configured).toBe(true);
    expect(eff.clientId).toBe("Ov23.admin1");
    expect(eff.clientIdSource).toBe("admin");
    expect(eff.clientSecretConfigured).toBe(true);
    const cfg = getEffectiveOAuthConfig(kv())!;
    expect(cfg.clientId).toBe("Ov23.admin1");
    expect(cfg.clientSecret).toBe("s3cret");
  });

  it("env client id wins over admin value", () => {
    setEnv("GITHUB_CLIENT_ID", "Iv1.fromenv");
    setEnv("GITHUB_CLIENT_SECRET", "s3cret");
    saveGitHubAdminSettings(kv(), { clientId: "Ov23.admin1" });
    const eff = getEffectiveGitHubLoginSettings(kv());
    expect(eff.clientId).toBe("Iv1.fromenv");
    expect(eff.clientIdSource).toBe("env");
  });

  it("admin requireAuth overrides env", () => {
    setEnv("GITHUB_CLIENT_SECRET", "s3cret");
    saveGitHubAdminSettings(kv(), { clientId: "Ov23.x", requireAuth: true });
    expect(getEffectiveGitHubLoginSettings(kv()).requireAuth).toBe(true);
    expect(getEffectiveGitHubLoginSettings(kv()).requireAuthSource).toBe("admin");
  });

  it("admin callback url and scope are used when env is silent", () => {
    saveGitHubAdminSettings(kv(), {
      callbackUrl: "https://admin.example.com/auth/github/callback",
      scope: "read:user user:email repo",
    });
    const eff = getEffectiveGitHubLoginSettings(kv());
    expect(eff.redirectUri).toBe("https://admin.example.com/auth/github/callback");
    expect(eff.redirectUriSource).toBe("admin");
    expect(eff.scope).toBe("read:user user:email repo");
    expect(eff.scopeSource).toBe("admin");
  });

  it("secret presence flags never expose values", () => {
    setEnv("GITHUB_TOKEN", "tok");
    const eff = getEffectiveGitHubLoginSettings(kv());
    expect(eff.secrets.githubToken).toBe(true);
    expect(JSON.stringify(eff)).not.toContain("tok");
  });
});
