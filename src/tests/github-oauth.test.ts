import { describe, it, expect } from "vitest";
import {
  buildAuthorizeUrl,
  createOAuthState,
  verifyOAuthState,
  signSession,
  verifySession,
  extractSessionToken,
  buildSessionCookie,
  b64urlEncode,
  b64urlDecode,
} from "../auth/github-oauth.js";
import { UserRepository } from "../auth/users.js";
import { freshDb } from "./test-helpers.js";

const SECRET = "test-auth-secret-0123456789abcdef";

describe("GitHub OAuth authorize URL", () => {
  it("builds a valid github.com authorize URL", () => {
    const url = buildAuthorizeUrl({
      clientId: "Iv1.test",
      redirectUri: "http://localhost:8080/auth/github/callback",
      scope: "read:user user:email",
      state: "s123",
    });
    expect(url.startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
    const u = new URL(url);
    expect(u.searchParams.get("client_id")).toBe("Iv1.test");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:8080/auth/github/callback");
    expect(u.searchParams.get("state")).toBe("s123");
    expect(u.searchParams.get("scope")).toContain("read:user");
  });
});

describe("OAuth state (CSRF)", () => {
  it("round-trips a fresh state", () => {
    const state = createOAuthState(SECRET);
    expect(verifyOAuthState(state, SECRET)).toBe(true);
  });

  it("rejects tampered state", () => {
    const state = createOAuthState(SECRET);
    const tampered = state.slice(0, -2) + (state.endsWith("AA") ? "BB" : "AA");
    expect(verifyOAuthState(tampered, SECRET)).toBe(false);
  });

  it("rejects state signed with another secret", () => {
    const state = createOAuthState("other-secret");
    expect(verifyOAuthState(state, SECRET)).toBe(false);
  });

  it("rejects expired state", () => {
    const state = createOAuthState(SECRET);
    expect(verifyOAuthState(state, SECRET, Date.now() + 60 * 60 * 1000)).toBe(false);
  });

  it("rejects missing state", () => {
    expect(verifyOAuthState(undefined, SECRET)).toBe(false);
    expect(verifyOAuthState("", SECRET)).toBe(false);
  });
});

describe("session tokens", () => {
  it("round-trips a session", () => {
    const token = signSession("user-1", { secret: SECRET });
    const payload = verifySession(token, { secret: SECRET });
    expect(payload?.sub).toBe("user-1");
  });

  it("rejects tampered sessions", () => {
    const token = signSession("user-1", { secret: SECRET });
    const [p] = token.split(".");
    const fakePayload = b64urlEncode(JSON.stringify({ sub: "user-admin", iat: 1, exp: Date.now() + 99999 }));
    expect(verifySession(`${fakePayload}.${token.split(".")[1]}`, { secret: SECRET })).toBeUndefined();
    expect(p.length).toBeGreaterThan(0);
  });

  it("rejects expired sessions", () => {
    const token = signSession("user-1", { secret: SECRET, ttlMs: 1000, now: 1000 });
    expect(verifySession(token, { secret: SECRET, now: 5000 })).toBeUndefined();
  });

  it("rejects sessions from another secret", () => {
    const token = signSession("user-1", { secret: "other" });
    expect(verifySession(token, { secret: SECRET })).toBeUndefined();
  });
});

describe("session extraction", () => {
  it("reads Bearer tokens", () => {
    expect(extractSessionToken({ authorization: "Bearer abc.def" })).toBe("abc.def");
  });

  it("reads the cv_session cookie", () => {
    expect(extractSessionToken({ cookie: "a=1; cv_session=tok123; b=2" })).toBe("tok123");
  });

  it("prefers Authorization header over cookie", () => {
    expect(
      extractSessionToken({ authorization: "Bearer head", cookie: "cv_session=cook" }),
    ).toBe("head");
  });

  it("builds a clearable HttpOnly cookie", () => {
    const c = buildSessionCookie("tok", { maxAgeMs: 1000 });
    expect(c).toContain("cv_session=");
    expect(c).toContain("HttpOnly");
  });
});

describe("base64url helpers", () => {
  it("round-trips", () => {
    expect(b64urlDecode(b64urlEncode("hello world")).toString("utf8")).toBe("hello world");
  });
});

describe("UserRepository GitHub upsert", () => {
  it("first GitHub user becomes owner, next becomes developer, roles stick on re-login", () => {
    const { cleanup } = freshDb();
    try {
      const repo = new UserRepository();
      const first = repo.upsertGitHubUser({
        id: 111,
        login: "alice",
        name: "Alice",
        email: "alice@example.com",
      });
      expect(first.created).toBe(true);
      expect(first.user.role).toBe("owner");
      expect(first.user.externalId).toBe("github:111");

      const second = repo.upsertGitHubUser({
        id: 222,
        login: "bob",
        name: "Bob",
        email: "bob@example.com",
      });
      expect(second.user.role).toBe("developer");

      // Re-login keeps the existing role even if it was changed.
      const again = repo.upsertGitHubUser({
        id: 222,
        login: "bob",
        name: "Bobby",
        email: "bob2@example.com",
      });
      expect(again.created).toBe(false);
      expect(again.user.role).toBe("developer");
      expect(again.user.name).toBe("Bobby");
      expect(repo.findByExternalId("github:111")?.email).toBe("alice@example.com");
    } finally {
      cleanup();
    }
  });
});
