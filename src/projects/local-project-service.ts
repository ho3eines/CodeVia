/**
 * LocalProjectService — create CodeVia projects from folders on the server
 * filesystem, with no GitHub (or any git) involvement.
 *
 * Flow: scan the folder (`ProjectAnalyzerService`), merge user overrides,
 * persist a Project document with `sourceType: "local"`, `localPath` and the
 * full `analysis` JSON. The project carries no repository — `configRepo`
 * stays empty until one is linked explicitly — so the platform's repo-backed
 * features degrade gracefully (health banner) instead of failing creation.
 *
 * GitHub import remains fully available: the existing `POST /projects` flow
 * is untouched; legacy rows simply have no `sourceType`.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Project, ProjectAnalysis, ProjectCapabilities, ProjectSettings } from "../domain/entities.js";
import type { ProjectRepository } from "../domain/repos.js";
import type { AuditRepository } from "../observability/repos.js";
import { generateCorrelationId } from "../events/bus.js";
import { hydrateProject, legacyFieldsFromCapabilities, normalizeCapabilities } from "../domain/project-options.js";
import type { ProjectAnalyzerService } from "../analyzer/project-analyzer.js";
import type { Permission } from "../types.js";

/** Every permission granted by default, mirroring the GitHub-flow default. */
const ALL_PERMISSIONS: Permission[] = [
  "project.read",
  "project.write",
  "agent.read",
  "agent.write",
  "workflow.read",
  "workflow.write",
  "model.read",
  "model.write",
  "provider.read",
  "provider.write",
  "skill.read",
  "skill.write",
  "memory.read",
  "memory.write",
  "repository.read",
  "repository.write",
  "deployment.read",
  "deployment.write",
  "secret.read",
  "secret.write",
  "telegram.read",
  "telegram.write",
  "admin.read",
  "admin.write",
];

export interface LocalProjectOverrides {
  name?: string;
  description?: string;
  slug?: string;
  defaultModelId?: string;
  /** String-array form of ProjectCapabilities (validated/normalized downstream). */
  capabilities?: {
    platforms?: string[];
    languages?: string[];
    frameworks?: string[];
    databases?: string[];
    deploymentTargets?: string[];
    features?: string[];
    integrations?: string[];
    agentTypes?: string[];
  };
  settings?: Partial<ProjectSettings>;
}

export interface CreateLocalProjectInput {
  /** Folder on the server (must be inside the allowed roots). */
  rootPath: string;
  /** Platform user who will own the project. */
  ownerId?: string;
  overrides?: LocalProjectOverrides;
}

function defaultPermissions(): Record<Permission, boolean> {
  const out = {} as Record<Permission, boolean>;
  for (const p of ALL_PERMISSIONS) out[p] = true;
  return out;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || `project-${Date.now()}`
  );
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

export class LocalProjectService {
  constructor(
    private readonly deps: {
      projectRepo: ProjectRepository;
      auditRepo: AuditRepository;
      analyzer: ProjectAnalyzerService;
    },
  ) {}

  /**
   * Scan a server folder and create a project from it. Throws Errors with
   * `statusCode` (400/403/404/409) that routes map directly to HTTP.
   */
  async createProjectFromLocalFolder(input: CreateLocalProjectInput): Promise<Project> {
    const analysis = await this.deps.analyzer.scan(input.rootPath);
    return this.createFromAnalysis(analysis, input);
  }

  /** Second half of the flow, also usable with an already-produced analysis. */
  async createFromAnalysis(analysis: ProjectAnalysis, input: CreateLocalProjectInput): Promise<Project> {
    const o = input.overrides ?? {};
    const name = (o.name ?? analysis.suggestions.name ?? analysis.name ?? path.basename(analysis.rootPath)).trim();
    if (!name) throw httpError(400, "Project name is required (no override and nothing detectable in the folder)");

    const slug = o.slug?.trim() || slugify(name);

    // Conflicts — folder first (more specific), then slug.
    const existing = this.deps.projectRepo.findMany().map((r) => r.data);
    const resolvedRoot = path.resolve(analysis.rootPath);
    const sameFolder = existing.find(
      (p) => p.sourceType === "local" && p.localPath && path.resolve(p.localPath) === resolvedRoot,
    );
    if (sameFolder) {
      throw httpError(409, `This folder is already linked to project "${sameFolder.slug}"`);
    }
    if (existing.some((p) => p.slug === slug)) {
      throw httpError(409, `A project with slug "${slug}" already exists`);
    }

    // Capabilities: analysis first, user overrides on top.
    const derived: Partial<ProjectCapabilities> = {
      languages: analysis.languages,
      frameworks: analysis.frameworks,
      platforms: [],
      databases: [],
      deploymentTargets: analysis.docker ? ["docker"] : [],
      features: [],
      integrations: [],
      agentTypes: [],
    };
    const capabilities = normalizeCapabilities(
      { ...derived, ...o.capabilities } as unknown as Record<string, unknown>,
      {},
    );
    const legacy = legacyFieldsFromCapabilities(capabilities);

    const now = new Date().toISOString();
    const project: Project = {
      id: `proj-${randomUUID().slice(0, 8)}`,
      ownerId: input.ownerId,
      slug,
      name,
      description: (o.description ?? analysis.description ?? "").trim(),
      // No repository: empty strings keep every tolerant reader (`if (!p.configRepo)`)
      // on its graceful path; `repositories: []` is stable under hydrateProject.
      configRepo: "",
      branch: "",
      repositories: [],
      capabilities,
      primaryLanguage: legacy.primaryLanguage,
      framework: legacy.framework,
      database: legacy.database,
      deploymentTarget: legacy.deploymentTarget,
      defaultModelId: o.defaultModelId,
      sourceType: "local",
      localPath: resolvedRoot,
      analysis,
      settings: {
        environment: "development",
        notifications: [],
        rules: [],
        skills: [],
        workflows: [],
        budget: { maxTokensPerRun: 20000, maxCallsPerRun: 20, maxCostUsdPerRun: 5, maxDurationMs: 600000 },
        permissions: defaultPermissions(),
        metadata: {},
        ...o.settings,
      },
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.projectRepo.upsert(project, { key: project.slug });

    await this.deps.auditRepo.record({
      action: "project.created",
      projectId: project.id,
      result: "success",
      source: "web",
      correlationId: generateCorrelationId(),
      metadata: { name: project.name, sourceType: "local", localPath: project.localPath },
    });
    return hydrateProject(project);
  }

  /** Stored analysis for `GET /projects/:id/analysis`. */
  analysisFor(project: Project): ProjectAnalysis | undefined {
    return project.analysis;
  }
}
