import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";
import type { IGitHubService } from "../github/types.js";
import type { Project } from "../domain/entities.js";

/* ------------------------------------------------------------------ *
 * Project chat send (POST /conversations/:id/messages).
 *
 * Regression: projects created before multi-repository support have
 * `configRepo`/`branch` but no `repositories` array. Every list/detail
 * endpoint hydrates the record (hydrateProject rebuilds `repositories`
 * from the connected repository), so the UI kept working — but the chat
 * send handler read the raw record and built its system prompt with
 * `project.repositories.map(...)`, which made every send fail with
 * `Cannot read properties of undefined (reading 'map')` (surfaced in the
 * UI as a "Send failed" toast).
 * ------------------------------------------------------------------ */

let cleanup: (() => void) | undefined;
let app: FastifyInstance;
let container: Container;

beforeAll(async () => {
  delete process.env.REQUIRE_AUTH;
  getEnvFresh();
  cleanup = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  // Present as a *real* GitHub connection (kind !== "mock") backed by the
  // in-memory service, so the mock-only code paths stay out of the way.
  const gh = container.github as unknown as IGitHubService & {
    seedRepo(owner: string, name: string, opts?: { files?: Array<{ path: string; content: string }>; branch?: string }): unknown;
  };
  Object.defineProperty(gh, "kind", { value: "real", configurable: true });
  gh.seedRepo("acme", "legacy", { files: [{ path: "README.md", content: "# legacy\n" }], branch: "main" });
  gh.seedRepo("acme", "legacy2", { files: [{ path: "README.md", content: "# legacy2\n" }], branch: "main" });
  gh.seedRepo("acme", "modern", { files: [{ path: "README.md", content: "# modern\n" }], branch: "main" });
  app = (await buildServer(container)).app;
}, 30000);

afterAll(async () => {
  await app?.close();
  cleanup?.();
});

/** A project exactly as an older version stored it: no `repositories` array. */
function legacyProject(id: string, slug: string, configRepo: string): Project {
  const now = new Date().toISOString();
  return {
    id,
    slug,
    name: "Legacy project",
    description: "created before multi-repository support",
    configRepo,
    branch: "main",
    capabilities: {
      platforms: [], languages: [], frameworks: [], databases: [],
      deploymentTargets: [], features: [], integrations: [], agentTypes: [],
    },
    githubConnection: { kind: "server-token" },
    settings: {
      environment: "development",
      notifications: [],
      rules: [],
      skills: [],
      generatedSkills: [],
      workflows: [],
      budget: { maxTokensPerRun: 20000, maxCallsPerRun: 20, maxCostUsdPerRun: 5, maxDurationMs: 600000 },
      permissions: {},
      metadata: {},
    },
    active: true,
    createdAt: now,
    updatedAt: now,
    repositoryState: { version: 2, generation: "imported", initializedAt: now },
  } as unknown as Project;
}

/** The same project as the current version stores it: with `repositories`. */
function modernProject(id: string, slug: string, configRepo: string): Project {
  const legacy = legacyProject(id, slug, configRepo) as unknown as Record<string, unknown>;
  return { ...legacy, repositories: [{ repo: configRepo, branch: "main", role: "primary", isConfigRepo: true, htmlUrl: `https://github.com/${configRepo}`, addedAt: new Date().toISOString() }] } as unknown as Project;
}

describe("project chat send", () => {
  it("sends on a legacy project that has no repositories array", async () => {
    const project = legacyProject("proj-legacy1", "legacy1", "acme/legacy");
    container.projectRepo.upsert(project, { key: project.slug });

    const created = await app.inject({ method: "POST", url: "/conversations", payload: { projectId: project.id, title: "Project Chat", userId: "local-user" } });
    expect(created.statusCode, created.body).toBe(200);
    const conv = created.json();

    const res = await app.inject({ method: "POST", url: `/conversations/${conv.id}/messages`, payload: { role: "user", content: "سلام" } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    expect(body.messages.at(-1).role).toBe("assistant");
    expect(body.messages.at(-1).content).toBeTruthy();
  }, 30000);

  it("does not 500 when attachments arrive as a non-array", async () => {
    const project = legacyProject("proj-legacy2", "legacy2", "acme/legacy2");
    container.projectRepo.upsert(project, { key: project.slug });
    const conv = (await app.inject({ method: "POST", url: "/conversations", payload: { projectId: project.id, title: "Project Chat", userId: "local-user" } })).json();
    const res = await app.inject({ method: "POST", url: `/conversations/${conv.id}/messages`, payload: { role: "user", content: "سلام", attachments: { name: "x" } } });
    expect(res.statusCode, res.body).toBe(200);
  }, 30000);

  it("still sends for a normal project and dispatches non-chat modes", async () => {
    const p = modernProject("proj-modern1", "modern1", "acme/modern");
    container.projectRepo.upsert(p, { key: p.slug });
    const conv = (await app.inject({ method: "POST", url: "/conversations", payload: { projectId: p!.id, title: "Project Chat", userId: "local-user" } })).json();
    const chat = await app.inject({ method: "POST", url: `/conversations/${conv.id}/messages`, payload: { role: "user", content: "سلام" } });
    expect(chat.statusCode, chat.body).toBe(200);
    expect(chat.json().messages.at(-1).role).toBe("assistant");

    const dispatched = await app.inject({ method: "POST", url: `/conversations/${conv.id}/messages`, payload: { role: "user", content: "یک کار انجام بده", executionMode: "agent" } });
    expect(dispatched.statusCode, dispatched.body).toBe(200);
    expect(dispatched.json().messages.at(-1).metadata?.dispatchedTaskId).toBeTruthy();
  }, 30000);
});
