import * as path from "node:path";
import type { Project } from "../domain/entities.js";
import type { LocalProjectService, LocalProjectOverrides } from "./local-project-service.js";
import { extractProjectZip, projectArchiveLimitsFromEnv, type ProjectArchiveFile } from "./project-archive.js";
import { extractProjectRar } from "./rar-archive.js";

export interface ImportProjectArchiveInput {
  filename: string;
  buffer: Buffer;
  ownerId?: string;
  name?: string;
  description?: string;
  slug?: string;
  overrides?: LocalProjectOverrides;
}

export interface CreateNewLocalProjectInput {
  name: string;
  description?: string;
  slug?: string;
  ownerId?: string;
}

function normalizeProjectName(value: string): string {
  const name = value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200);
  return name || "Imported Project";
}

function archiveProjectFiles(files: readonly ProjectArchiveFile[]): ProjectArchiveFile[] {
  // GitHub-generated source archives usually have a single <repo>-main wrapper
  // directory. Strip it only when that directory contains a recognizable
  // project-root manifest, so monorepos such as `packages/*` remain intact.
  const firstSegments = new Set(files.map((file) => file.path.split("/")[0]));
  if (firstSegments.size !== 1) return [...files];
  const wrapper = [...firstSegments][0];
  const prefix = `${wrapper}/`;
  const nested = files.filter((file) => file.path.startsWith(prefix));
  if (nested.length !== files.length) return [...files];
  const markers = new Set([
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "Cargo.toml",
    "composer.json",
    "Dockerfile",
    "README.md",
  ]);
  const hasProjectRootMarker = nested.some((file) => markers.has(file.path.slice(prefix.length)));
  if (!hasProjectRootMarker) return [...files];
  return nested.map((file) => ({ path: file.path.slice(prefix.length), content: file.content }));
}

export class ProjectImportService {
  constructor(private readonly localProjects: LocalProjectService) {}

  async importArchive(input: ImportProjectArchiveInput): Promise<Project> {
    const limits = projectArchiveLimitsFromEnv();
    if (!Buffer.isBuffer(input.buffer) || input.buffer.length > limits.maxUploadBytes)
      throw Object.assign(new Error(`Compressed archive exceeds ${limits.maxUploadBytes} bytes`), { statusCode: 400 });
    const ext = path.extname(path.basename(input.filename)).toLowerCase();
    let files: ProjectArchiveFile[];
    if (ext === ".zip") files = extractProjectZip(input.buffer, limits);
    else if (ext === ".rar") files = await extractProjectRar(input.buffer, { limits });
    else throw Object.assign(new Error("Only .zip and .rar project archives are supported"), { statusCode: 400 });
    const filenameName = path.basename(input.filename, ext).replace(/[-_](?:main|master)$/i, "");
    const name = normalizeProjectName(input.name?.trim() || filenameName);
    const filesAtProjectRoot = archiveProjectFiles(files);
    return this.localProjects.createProjectFromFiles({
      files: filesAtProjectRoot,
      name,
      description: input.description ?? input.overrides?.description ?? "Imported from archive",
      slug: input.slug,
      ownerId: input.ownerId,
      overrides: {
        ...input.overrides,
        name,
        description: input.description ?? input.overrides?.description ?? "Imported from archive",
      },
    });
  }

  async createNewLocalProject(input: CreateNewLocalProjectInput): Promise<Project> {
    const name = normalizeProjectName(input.name);
    const description = input.description?.trim() ?? "";
    const readme = `# ${name}\n\nA new project created with CodeVia.\n`;
    return this.localProjects.createProjectFromFiles({
      name,
      description,
      slug: input.slug,
      ownerId: input.ownerId,
      files: [{ path: "README.md", content: Buffer.from(readme, "utf8") }],
    });
  }
}
