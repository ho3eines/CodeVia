import type { FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import type { Project } from "../domain/entities.js";
import { canAccessProject, resolveRequestUser } from "./auth.js";

/**
 * Per-account project isolation for the definition sub-resources
 * (workflows, tasks, agents, memory, skills, conversations).
 *
 * The primary routes (`/projects`) already gate every call through
 * `canAccessProject`, so a signed-in account only sees and drives its own
 * projects (plus genuinely shared/unowned ones). The sub-resource routes below
 * historically only checked that a project *existed*, which let one account
 * list, read, edit, run or delete another account's definitions by guessing the
 * id — a cross-account leak. These helpers close that gap using the SAME rule
 * as the rest of the platform, so behavior is consistent everywhere:
 *
 *   - The unauthenticated demo user (auth off / single-user) sees everything.
 *   - A project with no `ownerId` (or `user-demo`) is shared/adoptable and
 *     stays visible to every account.
 *   - Otherwise only the owning account may reach its project's definitions.
 */

/** Resolve the project a request targets, but only if the caller may access it. */
export function resolveProjectForRequest(
  req: FastifyRequest,
  c: Container,
  projectId: string | undefined,
): Project | undefined {
  if (!projectId) return undefined;
  const p = c.projectRepo.findById(projectId)?.data;
  if (!p) return undefined;
  const { user } = resolveRequestUser(req, c);
  return canAccessProject(user, p) ? p : undefined;
}

/** The project ids an account may reach, for scoping "list everything" endpoints. */
export function accessibleProjectIds(req: FastifyRequest, c: Container): Set<string> {
  const { user } = resolveRequestUser(req, c);
  return new Set(
    c.projectRepo
      .findMany()
      .map((r) => r.data)
      .filter((p) => canAccessProject(user, p))
      .map((p) => p.id),
  );
}

/** Load an entity's project via its `projectId` field and enforce access. */
export function projectOfEntity(req: FastifyRequest, c: Container, projectId: string | undefined): Project | undefined {
  return resolveProjectForRequest(req, c, projectId);
}
