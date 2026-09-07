import type { FastifyReply, FastifyRequest } from "fastify";
import type { User, Project } from "../domain/entities.js";
import type { UserRole, Permission } from "../types.js";
import type { Container } from "../app/container.js";
import { extractSessionToken, verifySession } from "../auth/github-oauth.js";
import { getEnv } from "../config/env.js";

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: ["project.read", "project.write", "agent.read", "agent.write", "workflow.read", "workflow.write", "model.read", "model.write", "provider.read", "provider.write", "skill.read", "skill.write", "memory.read", "memory.write", "repository.read", "repository.write", "deployment.read", "deployment.write", "secret.read", "secret.write", "telegram.read", "telegram.write", "admin.read", "admin.write"],
  admin: ["project.read", "project.write", "agent.read", "agent.write", "workflow.read", "workflow.write", "model.read", "model.write", "provider.read", "provider.write", "skill.read", "skill.write", "memory.read", "memory.write", "repository.read", "repository.write", "deployment.read", "telegram.read", "telegram.write", "admin.read"],
  developer: ["project.read", "project.write", "agent.read", "workflow.read", "workflow.write", "model.read", "provider.read", "skill.read", "skill.write", "memory.read", "memory.write", "repository.read", "repository.write", "telegram.read", "telegram.write"],
  reviewer: ["project.read", "agent.read", "workflow.read", "model.read", "provider.read", "skill.read", "memory.read", "memory.write", "repository.read", "deployment.read"],
  viewer: ["project.read", "agent.read", "workflow.read", "model.read", "provider.read", "skill.read", "memory.read", "repository.read"],
};

/** A demo/default owner so local (unauthenticated) usage works out of the box. */
export const DEMO_USER: User = {
  id: "user-demo",
  externalId: "demo",
  email: "demo@codevia.local",
  name: "Demo Owner",
  role: "owner",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

declare module "fastify" {
  interface FastifyRequest {
    user: User;
    /** True when the request carries a valid GitHub-login session. */
    authenticated: boolean;
  }
}

/**
 * Resolve the current user for a request.
 *
 * Only proof of identity is a valid signed session (`Authorization: Bearer
 * <session>` / `cv_session` cookie from GitHub login). Without one the caller
 * is the demo owner — allowed only while strict auth is off (see below).
 *
 * (A01) There is deliberately NO caller-supplied identity override: a client
 * header like `x-user-id` is not evidence of identity, so accepting it let any
 * caller bypass strict authentication with an owner-role identity. Tests that
 * need a specific user mint a real signed session (`signSession`) instead.
 */
export function resolveRequestUser(req: FastifyRequest, container?: Container): { user: User; authenticated: boolean } {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  try {
    const token = extractSessionToken(headers);
    const payload = verifySession(token);
    if (payload && container) {
      const found = container.userRepo.findById(payload.sub)?.data;
      if (found) return { user: found, authenticated: true };
    } else if (payload && !container) {
      // No container available (shouldn't happen in routes) — treat as auth'd demo.
      return { user: { ...DEMO_USER, id: payload.sub }, authenticated: true };
    }
  } catch {
    // Invalid/expired session -> fall through to demo user.
  }
  return { user: DEMO_USER, authenticated: false };
}

/**
 * Can this user see and drive this project? Rules, shared with the Socket.io
 * handshake/room authorization so HTTP and realtime enforce the same rule:
 *   1. `ownerId` empty or `user-demo` means "shared/legacy" — pre-login rows
 *      and single-user installs stay visible to every account, and any
 *      connected user may adopt them (see adoptStrandedProjects /
 *      adoptProjectConnection).
 *   2. The unauthenticated demo user sees everything: in demo/simulation
 *      mode there is no real multi-user isolation, so nothing disappears.
 *      (Strict auth 401s before routes when login is configured, so this
 *      clause only ever applies when auth is off.)
 *   3. Otherwise only the owner may access their own project.
 */
export function canAccessProject(user: User, project: Pick<Project, "ownerId">): boolean {
  const ownerId = project.ownerId;
  if (!ownerId || ownerId === "user-demo") return true; // shared / legacy, adoptable
  if (user.id === "user-demo") return true; // demo/single-user mode sees everything
  return ownerId === user.id;
}

export function authMiddleware(opts: { container: Container; can?: Permission }) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { user, authenticated } = resolveRequestUser(req, opts.container);
    req.user = user;
    req.authenticated = authenticated;
    if (opts.can) {
      const allowed = ROLE_PERMISSIONS[user.role];
      if (allowed && !allowed.includes(opts.can)) {
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
      }
    }
    // Optional strict mode: the Admin panel toggle overrides REQUIRE_AUTH env.
    // When on, API callers must present a valid GitHub-login session instead
    // of silently using the demo user.
    let requireAuth = getEnv().REQUIRE_AUTH;
    try {
      const { getEffectiveRequireAuth } = await import("../auth/admin-settings.js");
      requireAuth = getEffectiveRequireAuth(opts.container.kv);
    } catch {
      // kv unavailable (tests) — fall back to the env flag.
    }
    if (requireAuth && !authenticated) {
      // Strict mode must never lock everyone out: while GitHub login is not
      // configured there is no way to obtain a session, so enforcing 401 here
      // would brick the whole UI (including the Admin page needed to fix it).
      // Log loudly and fall back to demo mode until OAuth is set up.
      let loginConfigured = true;
      try {
        const { getEffectiveOAuthConfig } = await import("../auth/admin-settings.js");
        loginConfigured = !!getEffectiveOAuthConfig(opts.container.kv);
      } catch {
        // kv unavailable — assume configured so the env flag still applies.
      }
      if (loginConfigured) {
        reply.code(401);
        throw Object.assign(new Error("Authentication required (GitHub login)"), { statusCode: 401 });
      }
      warnStrictModeWithoutLogin();
    }
  };
}

let warnedStrictModeWithoutLogin = false;
function warnStrictModeWithoutLogin(): void {
  if (warnedStrictModeWithoutLogin) return;
  warnedStrictModeWithoutLogin = true;
  // Lazy import keeps this module free of a hard logger dependency for tests.
  void import("../logger.js").then(({ logger }) =>
    logger.warn(
      "REQUIRE_AUTH is on but GitHub login is not configured (missing Client ID and/or GITHUB_CLIENT_SECRET). " +
        "Falling back to demo mode so the platform stays reachable — configure GitHub login to enforce strict auth.",
    ),
  );
}
