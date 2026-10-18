/**
 * Local-folder project endpoints (no GitHub required).
 *
 *   POST /projects/scan            — body { path } → ProjectAnalysis
 *   POST /projects/from-local      — body { path, gitInit?, overrides? } → creates a
 *                                     local project, optionally copying it into LOCAL_REPOS_DIR
 *   POST /projects/import          — multipart ZIP/RAR import with bounded parsing
 *   POST /projects/new-local       — create a local Git project with an initial README commit
 *   GET  /projects/:id/analysis    — stored analysis for a local project
 *
 * `POST /projects` (GitHub / local-git import) is untouched and remains the
 * default flow — this route file only *adds* the folder-based source.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Container } from "../../app/container.js";
import { z } from "zod";
import { isFilesystemError } from "../../filesystem/filesystem-error.js";
import { ROLE_PERMISSIONS, canAccessProject, resolveRequestUser } from "../auth.js";
import { hydrateProject } from "../../domain/project-options.js";
import type { Permission } from "../../types.js";

function requirePermission(req: FastifyRequest, reply: FastifyReply, permission: Permission): boolean {
  const allowed = ROLE_PERMISSIONS[req.user.role] ?? [];
  if (!allowed.includes(permission)) {
    reply.code(403);
    return false;
  }
  return true;
}

function errStatus(err: unknown): number {
  const s = (err as { statusCode?: number } | undefined)?.statusCode;
  return typeof s === "number" && s >= 400 && s < 600 ? s : 500;
}

const projectCommandsSchema = z
  .object({
    install: z.string().trim().max(500).optional(),
    build: z.string().trim().max(500).optional(),
    test: z.string().trim().max(500).optional(),
    lint: z.string().trim().max(500).optional(),
    start: z.string().trim().max(500).optional(),
  })
  .strict();

const overridesSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i, "slug may contain letters, digits and dashes")
      .optional(),
    defaultModelId: z.string().trim().optional(),
    commands: projectCommandsSchema.optional(),
    capabilities: z
      .object({
        platforms: z.array(z.string()).optional(),
        languages: z.array(z.string()).optional(),
        frameworks: z.array(z.string()).optional(),
        databases: z.array(z.string()).optional(),
        deploymentTargets: z.array(z.string()).optional(),
        features: z.array(z.string()).optional(),
        integrations: z.array(z.string()).optional(),
        agentTypes: z.array(z.string()).optional(),
      })
      .optional(),
    settings: z
      .object({
        environment: z.enum(["development", "staging", "production"]).optional(),
        notifications: z.array(z.string()).optional(),
        rules: z.array(z.string()).optional(),
        skills: z.array(z.string()).optional(),
        trustedForExecution: z.boolean().optional(),
        sandboxNetworkAccess: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

const scanSchema = z
  .object({
    path: z.string().trim().min(1, "path is required"),
    maxFiles: z.coerce.number().int().positive().max(50000).optional(),
    maxDepth: z.coerce.number().int().positive().max(32).optional(),
  })
  .strict();

const fromLocalSchema = z
  .object({
    path: z.string().trim().min(1, "path is required"),
    gitInit: z.boolean().optional(),
    overrides: overridesSchema.optional(),
  })
  .strict();

const newLocalSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
      .optional(),
  })
  .strict();

function invalidBody(reply: FastifyReply, issues: z.ZodError): unknown {
  reply.code(400);
  return {
    error: "Invalid request body",
    issues: issues.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}

export function registerLocalProjectRoutes(app: FastifyInstance, container: Container): void {
  app.post("/projects/scan", { schema: { tags: ["projects"] } }, async (req, reply) => {
    if (!requirePermission(req, reply, "project.write")) return { error: "Forbidden" };
    const parsed = scanSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error);
    try {
      const analysis = await container.projectAnalyzer.scan(parsed.data.path, {
        maxFiles: parsed.data.maxFiles,
        maxDepth: parsed.data.maxDepth,
      });
      return { analysis };
    } catch (err) {
      if (isFilesystemError(err)) {
        reply.code(err.statusCode);
        return err.toJSON();
      }
      reply.code(errStatus(err));
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post("/projects/from-local", { schema: { tags: ["projects"] } }, async (req, reply) => {
    if (!requirePermission(req, reply, "project.write")) return { error: "Forbidden" };
    const parsed = fromLocalSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const { user } = resolveRequestUser(req, container);
    try {
      const project = await container.localProjects.createProjectFromLocalFolder({
        rootPath: parsed.data.path,
        gitInit: parsed.data.gitInit,
        ownerId: user.id,
        overrides: parsed.data.overrides,
      });
      reply.code(201);
      return project;
    } catch (err) {
      if (isFilesystemError(err)) {
        reply.code(err.statusCode);
        return err.toJSON();
      }
      reply.code(errStatus(err));
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post("/projects/new-local", { schema: { tags: ["projects"] } }, async (req, reply) => {
    if (!requirePermission(req, reply, "project.write")) return { error: "Forbidden" };
    const parsed = newLocalSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const { user } = resolveRequestUser(req, container);
    try {
      const project = await container.projectImports.createNewLocalProject({ ...parsed.data, ownerId: user.id });
      reply.code(201);
      return project;
    } catch (err) {
      reply.code(errStatus(err));
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post("/projects/import", { schema: { tags: ["projects"] } }, async (req, reply) => {
    if (!requirePermission(req, reply, "project.write")) return { error: "Forbidden" };
    if (!req.isMultipart()) {
      reply.code(400);
      return { error: "Expected multipart/form-data with one .zip or .rar archive" };
    }
    const fields: Record<string, string> = {};
    let upload: { filename: string; buffer: Buffer } | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (upload) {
            part.file.resume();
            reply.code(400);
            return { error: "Exactly one archive file is allowed" };
          }
          upload = { filename: part.filename, buffer: await part.toBuffer() };
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
    } catch (err) {
      reply.code(errStatus(err));
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (!upload) {
      reply.code(400);
      return { error: "Archive file is required" };
    }
    const fieldSchema = z
      .object({
        name: z.string().trim().max(200).optional(),
        description: z.string().max(2000).optional(),
        slug: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
          .optional(),
      })
      .strict();
    const parsedFields = fieldSchema.safeParse(fields);
    if (!parsedFields.success) return invalidBody(reply, parsedFields.error);
    const { user } = resolveRequestUser(req, container);
    try {
      const project = await container.projectImports.importArchive({
        ...parsedFields.data,
        ownerId: user.id,
        filename: upload.filename,
        buffer: upload.buffer,
      });
      reply.code(201);
      return project;
    } catch (err) {
      reply.code(errStatus(err));
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get("/projects/:id/analysis", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = container.projectRepo.findById(id);
    if (!rec) {
      reply.code(404);
      return { error: "project not found" };
    }
    const project = hydrateProject(rec.data);
    const { user } = resolveRequestUser(req, container);
    if (!canAccessProject(user, project)) {
      reply.code(404);
      return { error: "project not found" };
    }
    if (!project.analysis) {
      reply.code(404);
      return { error: "this project has no folder analysis (it was not created from a local folder)" };
    }
    return { analysis: project.analysis };
  });
}
