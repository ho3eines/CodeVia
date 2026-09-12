import type { IGitHubService, GithubRepoRef } from "../github/types.js";
import type { Project } from "../domain/entities.js";
import { CodeViaMemoryStore } from "./codevia-store.js";
import { ProjectFilesService } from "../github/project-files.js";
import { localId } from "../github/state-codec.js";

/** Compatibility adapter. New memory ALWAYS uses CodeVia/memory.md. */
export class GitHubMemoryStore extends CodeViaMemoryStore {
  constructor(github: IGitHubService, repo: GithubRepoRef, branch = "main", project?: Project) {
    const now = new Date().toISOString();
    const fullName = `${repo.owner}/${repo.name}`;
    super(
      new ProjectFilesService({ github }),
      project ?? {
        id: localId(fullName, "project", branch),
        slug: repo.name,
        name: repo.name,
        description: "",
        configRepo: fullName,
        branch,
        capabilities: {
          platforms: [],
          languages: [],
          frameworks: [],
          databases: [],
          deploymentTargets: [],
          integrations: [],
          features: [],
          agentTypes: [],
        },
        repositories: [{ repo: fullName, branch, role: "primary", isConfigRepo: true }],
        settings: {
          environment: "development",
          notifications: [],
          rules: [],
          skills: [],
          workflows: [],
          budget: { maxTokensPerRun: 0, maxCallsPerRun: 0, maxCostUsdPerRun: 0, maxDurationMs: 0 },
          permissions: {} as Project["settings"]["permissions"],
          metadata: {},
        },
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    );
  }
}
