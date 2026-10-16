/**
 * Server-filesystem browsing endpoints (local-folder project support).
 *
 *   GET /fs/list?path=…[&limit=…]   — list a directory (or the allowed roots
 *                                      when no path is given)
 *   GET /fs/stat?path=…             — typed metadata for one path
 *
 * Every path goes through `FilesystemService.assertSafePath` (allowed roots +
 * symlink containment). Sensitive files are described (name/size/mtime) but
 * never opened. Gated behind the `project.write` permission because these
 * endpoints expose the *server's* filesystem, not just project data.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Container } from "../../app/container.js";
import { z } from "zod";
import { isFilesystemError } from "../../filesystem/filesystem-error.js";
import { ROLE_PERMISSIONS } from "../auth.js";
import type { Permission } from "../../types.js";

function requirePermission(req: FastifyRequest, reply: FastifyReply, permission: Permission): boolean {
  const allowed = ROLE_PERMISSIONS[req.user.role] ?? [];
  if (!allowed.includes(permission)) {
    reply.code(403);
    return false;
  }
  return true;
}

const listQuerySchema = z.object({
  path: z.string().trim().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

const statQuerySchema = z.object({
  path: z.string().trim().min(1, "path is required"),
});

function failFilesystem(reply: FastifyReply, err: unknown): unknown {
  if (isFilesystemError(err)) {
    reply.code(err.statusCode);
    return err.toJSON();
  }
  const e = err as { statusCode?: number };
  const status = typeof e?.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
  reply.code(status);
  return { error: err instanceof Error ? err.message : String(err) };
}

export function registerFilesystemRoutes(app: FastifyInstance, container: Container): void {
  app.get("/fs/list", { schema: { tags: ["filesystem"] } }, async (req, reply) => {
    if (!requirePermission(req, reply, "project.write")) return { error: "Forbidden" };
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid query",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      };
    }
    const { path: target, limit } = parsed.data;
    try {
      if (!target) {
        // No path → surface the allowed roots so the client can start browsing.
        const roots = container.filesystem.listRoots();
        const entries = await Promise.all(
          roots.map(async (root) => {
            try {
              const stat = await container.filesystem.statPath(root);
              return {
                name: root,
                kind: stat.kind,
                size: stat.size,
                modifiedAt: stat.modifiedAt,
                hidden: false,
                sensitive: false,
              };
            } catch {
              return { name: root, kind: "other" as const, hidden: false, sensitive: false };
            }
          }),
        );
        return { path: null, entries, truncated: false, total: entries.length };
      }
      return await container.filesystem.listDirectory(target, { limit });
    } catch (err) {
      return failFilesystem(reply, err);
    }
  });

  app.get("/fs/stat", { schema: { tags: ["filesystem"] } }, async (req, reply) => {
    if (!requirePermission(req, reply, "project.write")) return { error: "Forbidden" };
    const parsed = statQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "path is required" };
    }
    try {
      return await container.filesystem.statPath(parsed.data.path);
    } catch (err) {
      return failFilesystem(reply, err);
    }
  });
}
