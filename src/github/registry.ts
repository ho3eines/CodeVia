import { MockGitHubService } from "./mock-service.js";
import { RealGitHubService } from "./real-service.js";
import type { IGitHubService } from "./types.js";
import { getEnv } from "../config/env.js";
import { logger } from "../logger.js";

/** A configured GitHub connection bound to a project. */
export interface GithubConnection {
  id: string;
  projectId?: string;
  provider: "github-app" | "oauth" | "token";
  owner: string;
  /** The token is always a secret reference, never stored literally. */
  secretRef: string;
}

/**
 * Resolves the GitHub service. Uses the real REST adapter when a token is
 * configured (production), otherwise the mock for dev/test/Simulation Mode.
 */
export function resolveGitHubService(): IGitHubService {
  const env = getEnv();
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_CLIENT_SECRET;
  // Use the real REST adapter in production (or when explicitly enabled) with a
  // token. Local dev/test defaults to the mock so the platform never requires
  // GitHub credentials to boot — a project can still connect to real GitHub via
  // the integration settings in production.
  const enabled = env.NODE_ENV === "production" || process.env.GITHUB_ENABLED === "true";
  if (token && enabled) {
    logger.info("Using RealGitHubService");
    return new RealGitHubService();
  }
  logger.info("Using MockGitHubService (no active GitHub token config)");
  return new MockGitHubService();
}

export function createMockGitHubService(): MockGitHubService {
  return new MockGitHubService();
}

export type { IGitHubService, GithubRepoRef } from "./types.js";
