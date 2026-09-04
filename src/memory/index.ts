import { LocalFileMemoryStore } from "./file-store.js";
import { GitHubMemoryStore } from "./github-store.js";
import type { IMemoryStore } from "./store.js";
import type { IGitHubService, GithubRepoRef } from "../github/types.js";
import { resolveGitHubService } from "../github/registry.js";
import { getEnv } from "../config/env.js";
import { logger } from "../logger.js";

export type MemoryStoreKind = "github" | "local";

export interface MemoryResolverConfig {
  repo?: GithubRepoRef;
  branch?: string;
  /** Local root path for the fallback store (dev/test/simulation). */
  localRoot?: string;
  force?: MemoryStoreKind;
}

/**
 * Resolves the memory store for a project. Prefers the GitHub-backed store (the
 * project repository is the source of truth); falls back to a local file store
 * when the project is not yet connected to a repository (e.g. Simulation Mode).
 */
export class MemoryResolver {
  resolve(config: MemoryResolverConfig = {}): IMemoryStore {
    const force = config.force ?? (getEnv().ENABLE_SIMULATION_MODE ? undefined : undefined);
    const github: IGitHubService = resolveGitHubService();
    if (config.repo && github.kind === "real" && force !== "local") {
      logger.debug(`memory store: github (${config.repo.owner}/${config.repo.name})`);
      return new GitHubMemoryStore(github, config.repo, config.branch ?? "main");
    }
    const root = config.localRoot ?? "./data/memory";
    logger.debug(`memory store: local (${root})`);
    return new LocalFileMemoryStore(root);
  }
}

export const memoryResolver = new MemoryResolver();
