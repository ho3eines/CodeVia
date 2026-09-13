import type { FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import type { Project } from "../domain/entities.js";
import { canAccessProject, DEMO_USER_ID, resolveRequestUser } from "./auth.js";

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

/**
 * Direct per-entity ownership gate (S01).
 *
 * By-id routes (`/tasks/:id`, `/runs/:id`, `/conversations/:id`, …) used to
 * rely solely on the global `registerProjectStateHook` preHandler, which can
 * only gate *indirectly*: it resolves the entity's `projectId` and applies
 * `canAccessProject`. An entity whose `projectId` is missing or empty slipped
 * past that hook entirely, so every by-id handler now calls this helper
 * itself — one rule, checked at the point of use:
 *
 *   - Entity has a project → the caller must be able to access that project
 *     (same rule as everywhere else: demo sees all, signed-in sees own).
 *   - Entity has NO project → governed by `opts.detached`:
 *       "demo-only" (default) — reachable only in demo/single-user mode; a
 *         signed-in account gets `false` (handlers answer 404, leaking
 *         neither existence nor ownership). For restored/legacy rows.
 *       "shared" — intentionally global by design (marketplace skill
 *         templates, platform-wide memory); visible to every caller.
 *
 * Handlers must call this AFTER confirming the entity exists and answer 404
 * for both "not found" and "not yours" so foreign ids stay indistinguishable.
 */
export function canAccessEntity(
  req: FastifyRequest,
  c: Container,
  entity: { projectId?: string } | undefined,
  opts: { detached?: "demo-only" | "shared" } = {},
): boolean {
  if (!entity) return false;
  const projectId = typeof entity.projectId === "string" ? entity.projectId.trim() : "";
  const { user } = resolveRequestUser(req, c);
  if (!projectId) {
    if (opts.detached === "shared") return true; // global template / platform memory
    // Detached entity: demo/single-user installs keep working; a signed-in
    // account can never prove the entity exists.
    return !user.id || user.id === DEMO_USER_ID;
  }
  const project = c.projectRepo.findById(projectId)?.data;
  if (!project) return false;
  return canAccessProject(user, project);
}
