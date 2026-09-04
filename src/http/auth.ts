import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "../domain/entities.js";
import type { UserRole, Permission } from "../types.js";
import type { Container } from "../app/container.js";

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
  }
}

export function authMiddleware(opts: { container: Container; can?: Permission }) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    // Resolve current user: default owner; allow override via x-user-id (useful
    // for tests). In production this is replaced by session/JWT handling.
    const overridden = req.headers["x-user-id"];
    const user: User = overridden ? { ...DEMO_USER, id: String(overridden) } : DEMO_USER;
    req.user = user;
    if (opts.can) {
      const allowed = ROLE_PERMISSIONS[user.role];
      if (allowed && !allowed.includes(opts.can)) {
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
      }
    }
  };
}
