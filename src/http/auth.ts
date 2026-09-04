import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "../domain/entities.js";
import type { UserRole, Permission } from "../types.js";
import type { Container } from "../app/container.js";
import { extractSessionToken, verifySession } from "../auth/github-oauth.js";

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
 * Priority: `Authorization: Bearer <session>` / `cv_session` cookie (GitHub
 * login) -> `x-user-id` override (tests) -> demo owner (local dev).
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
  const overridden = req.headers["x-user-id"];
  if (overridden) {
    return { user: { ...DEMO_USER, id: String(overridden) }, authenticated: false };
  }
  return { user: DEMO_USER, authenticated: false };
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
    // Optional strict mode: when REQUIRE_AUTH=true, API callers must present a
    // valid GitHub-login session instead of silently using the demo user.
    const requireAuth = process.env.REQUIRE_AUTH === "true";
    if (requireAuth && !authenticated && !req.headers["x-user-id"]) {
      reply.code(401);
      throw Object.assign(new Error("Authentication required (GitHub login)"), { statusCode: 401 });
    }
  };
}
