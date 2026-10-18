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
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type {
  Project,
  ProjectAnalysis,
  ProjectCapabilities,
  ProjectCommands,
  ProjectRepositoryLink,
  ProjectSettings,
} from "../domain/entities.js";
import type { ProjectRepository } from "../domain/repos.js";
import type { AuditRepository } from "../observability/repos.js";
import { generateCorrelationId } from "../events/bus.js";
import { hydrateProject, legacyFieldsFromCapabilities, normalizeCapabilities } from "../domain/project-options.js";
import { ProjectAnalyzerService } from "../analyzer/project-analyzer.js";
import type { Permission } from "../types.js";
import { FilesystemService, isSensitivePath } from "../filesystem/filesystem-service.js";
import type { LocalGitService } from "../github/local-git-service.js";
import {
  prepareProjectFiles,
  projectArchiveLimitsFromEnv,
  safeProjectArchivePath,
  type ProjectArchiveFile,
} from "./project-archive.js";

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

export interface LocalProjectRepository {
  repo: string;
  branch: string;
  defaultBranch?: string;
  private?: boolean;
  htmlUrl?: string;
}

export interface CreateLocalProjectInput {
  /** Folder on the server (must be inside the allowed roots). */
  rootPath: string;
  /** Create a copy in LOCAL_REPOS_DIR, git-init it, and register the local repository. */
  gitInit?: boolean;
  /** Platform user who will own the project. */
  ownerId?: string;
  overrides?: LocalProjectOverrides;
  repository?: LocalProjectRepository;
}

export interface CreateLocalGitProjectInput {
  files: readonly ProjectArchiveFile[];
  name: string;
  description?: string;
  slug?: string;
  ownerId?: string;
  overrides?: LocalProjectOverrides;
  omittedSensitive?: string[];
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

const OMIT_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".cache",
  ".aws",
  ".ssh",
  ".gnupg",
  ".kube",
]);

async function collectSafeFolderFiles(
  rootPath: string,
): Promise<{ files: ProjectArchiveFile[]; omittedSensitive: string[] }> {
  const limits = projectArchiveLimitsFromEnv();
  const root = await fsp.realpath(rootPath);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw httpError(400, "Project source must be a real directory");
  const queue = [root];
  const files: ProjectArchiveFile[] = [];
  const omittedSensitive: string[] = [];
  let seen = 0;
  let totalBytes = 0;
  while (queue.length) {
    const dir = queue.pop()!;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
      const safePath = safeProjectArchivePath(relativePath);
      const segments = safePath.split("/");
      if (segments.some((part) => OMIT_DIRECTORIES.has(part.toLowerCase()))) continue;
      const stat = await fsp.lstat(fullPath);
      if (stat.isSymbolicLink()) throw httpError(400, `Project source contains a symbolic link: ${safePath}`);
      if (stat.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!stat.isFile()) throw httpError(400, `Project source contains a special file: ${safePath}`);
      seen += 1;
      if (seen > limits.maxFiles) throw httpError(400, `Project source exceeds ${limits.maxFiles} files`);
      if (isSensitivePath(safePath)) {
        omittedSensitive.push(safePath);
        continue;
      }
      if (stat.size > limits.maxFileBytes)
        throw httpError(400, `Project source file exceeds the per-file limit: ${safePath}`);
      totalBytes += stat.size;
      if (totalBytes > limits.maxTotalBytes)
        throw httpError(400, `Project source exceeds ${limits.maxTotalBytes} bytes`);
      const realFile = await fsp.realpath(fullPath);
      const rel = path.relative(root, realFile);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
        throw httpError(400, `Project source escapes its root through a file path: ${safePath}`);
      files.push({ path: safePath, content: await fsp.readFile(fullPath) });
    }
  }
  return { files, omittedSensitive };
}

export class LocalProjectService {
  constructor(
    private readonly deps: {
      projectRepo: ProjectRepository;
      auditRepo: AuditRepository;
      analyzer: ProjectAnalyzerService;
      filesystem?: FilesystemService;
      localGit?: () => LocalGitService;
    },
  ) {}

  /**
   * Scan a server folder and create a project from it. Throws Errors with
   * `statusCode` (400/403/404/409) that routes map directly to HTTP.
   */
  async createProjectFromLocalFolder(input: CreateLocalProjectInput): Promise<Project> {
    const analysis = await this.deps.analyzer.scan(input.rootPath);
    if (!input.gitInit) return this.createFromAnalysis(analysis, input);
    const collected = await collectSafeFolderFiles(analysis.rootPath);
    return this.createProjectFromFiles({
      files: collected.files,
      name: input.overrides?.name ?? analysis.suggestions.name ?? analysis.name ?? path.basename(analysis.rootPath),
      description: input.overrides?.description ?? analysis.description ?? "",
      slug: input.overrides?.slug,
      ownerId: input.ownerId,
      overrides: input.overrides,
      omittedSensitive: collected.omittedSensitive,
    });
  }

  /** Create a local Git repository from safe in-memory files, then register it as a project. */
  async createProjectFromFiles(input: CreateLocalGitProjectInput): Promise<Project> {
    const overrides = input.overrides ?? {};
    const name = (overrides.name ?? input.name).trim();
    if (!name) throw httpError(400, "Project name is required");
    const slug = overrides.slug?.trim() || input.slug?.trim() || slugify(name);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug))
      throw httpError(400, "Project slug may contain only letters, digits and dashes");
    if (this.deps.projectRepo.findMany().some(({ data }) => data.slug === slug))
      throw httpError(409, `A project with slug "${slug}" already exists`);
    const prepared = prepareProjectFiles(input.files);
    const localGit = this.deps.localGit?.();
    if (!localGit) throw httpError(503, "Local Git project creation is not configured");
    const description = (overrides.description ?? input.description ?? "").trim();
    const imported = await localGit.createRepositoryFromFiles(
      { name: slug, description, autoInit: false },
      prepared.files,
    );
    const analysis = await new ProjectAnalyzerService({
      filesystem: new FilesystemService({
        allowedRoots: [imported.repoDir],
        maxFileSizeBytes: Math.min(16 * 1024 * 1024, projectArchiveLimitsFromEnv().maxFileBytes),
      }),
    }).scan(imported.repoDir);
    const omittedSensitive = [...new Set([...(input.omittedSensitive ?? []), ...prepared.omittedSensitive])];
    if (omittedSensitive.length)
      analysis.warnings = [
        ...analysis.warnings,
        `${omittedSensitive.length} secret-bearing file(s) were excluded from the initial commit`,
      ].slice(0, 20);
    const repoLink: LocalProjectRepository = {
      repo: imported.repository.fullName,
      branch: imported.repository.defaultBranch,
      defaultBranch: imported.repository.defaultBranch,
      private: imported.repository.private,
      htmlUrl: imported.repository.htmlUrl,
    };
    return this.createFromAnalysis(analysis, {
      rootPath: imported.repoDir,
      ownerId: input.ownerId,
      overrides: { ...overrides, name, slug, description },
      repository: repoLink,
    });
  }

  /** Second half of the flow, also usable with an already-produced analysis. */
  async createFromAnalysis(analysis: ProjectAnalysis, input: CreateLocalProjectInput): Promise<Project> {
    const o = input.overrides ?? {};
    const name = (o.name ?? analysis.suggestions.name ?? analysis.name ?? path.basename(analysis.rootPath)).trim();
    if (!name) throw httpError(400, "Project name is required (no override and nothing detectable in the folder)");

    const slug = o.slug?.trim() || slugify(name);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug))
      throw httpError(400, "Project slug may contain only letters, digits and dashes");

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
    const repository = input.repository;
    const repositories: ProjectRepositoryLink[] = repository
      ? [
          {
            repo: repository.repo,
            branch: repository.branch,
            role: "primary",
            isConfigRepo: true,
            private: repository.private,
            defaultBranch: repository.defaultBranch,
            htmlUrl: repository.htmlUrl,
            addedAt: now,
          },
        ]
      : [];
    const commands: ProjectCommands | undefined = analysis.commands ?? analysis.suggestions.commands;
    const project: Project = {
      id: `proj-${randomUUID().slice(0, 8)}`,
      ownerId: input.ownerId,
      slug,
      name,
      description: (o.description ?? analysis.description ?? "").trim(),
      // Local Git imports retain their primary repo link; server-folder-only projects remain repo-less.
      configRepo: repository?.repo ?? "",
      branch: repository?.branch ?? "",
      repositories,
      capabilities,
      commands,
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
}
