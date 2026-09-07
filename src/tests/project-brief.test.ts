import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { AgentGenerator } from "../agents/generator.js";
import { ContextEngine } from "../ai/context-engine.js";
import { projectBrief, projectBriefLines } from "../domain/project-brief.js";
import type { Project } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * The project definition selections (platforms, languages, frameworks,
 * databases, deployment targets, features, integrations, roster, repos)
 * must reach the agents: system prompts, run context, and AI prompts all
 * render from the same project brief.
 * ------------------------------------------------------------------ */

function richProject(): Project {
  const now = new Date().toISOString();
  return {
    id: "p1",
    slug: "shop",
    name: "Shop",
    description: "Persian online store",
    configRepo: "acme/shop",
    branch: "main",
    repositories: [{ repo: "acme/shop", branch: "main", role: "primary", isConfigRepo: true }],
    capabilities: {
      platforms: ["web", "mobile"],
      languages: ["csharp", "typescript"],
      frameworks: ["dotnet", "react"],
      databases: ["sqlserver"],
      deploymentTargets: ["docker", "azure"],
      features: ["auth", "payments"],
      integrations: ["telegram", "zarinpal"],
      agentTypes: [],
    },
    settings: { environment: "development", notifications: [], rules: [], skills: [], workflows: [], budget: { maxTokensPerRun: 0, maxCallsPerRun: 0, maxCostUsdPerRun: 0, maxDurationMs: 0 }, permissions: {} as never, metadata: {} },
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

describe("projectBrief", () => {
  it("renders every definition selection as prompt lines", () => {
    const lines = projectBriefLines(richProject());
    const text = lines.join("\n");
    expect(text).toContain("Platforms: web, mobile");
    expect(text).toContain("Languages: csharp, typescript");
    expect(text).toContain("Frameworks: dotnet, react");
    expect(text).toContain("Databases: sqlserver");
    expect(text).toContain("Deployment: docker, azure");
    expect(text).toContain("Key features: auth, payments");
    expect(text).toContain("Integrations: telegram, zarinpal");
    expect(text).toContain("Repositories: acme/shop@main (primary)");
  });

  it("skips empty dimensions and falls back for legacy projects", () => {
    const p = richProject();
    p.capabilities.features = [];
    p.capabilities.integrations = [];
    const text = projectBriefLines(p).join("\n");
    expect(text).not.toContain("Key features");
    expect(text).not.toContain("Integrations");
    expect(text).toContain("Platforms:");

    const legacy = { framework: "dotnet", primaryLanguage: "csharp", database: "sqlserver" } as Project;
    expect(projectBriefLines(legacy).join("\n")).toContain("dotnet / csharp / sqlserver");
  });

  it("renders the roster when the definition selects agent types", () => {
    const p = richProject();
    p.capabilities.agentTypes = ["research", "backend-developer"];
    expect(projectBriefLines(p).join("\n")).toContain("Team roster: research, backend-developer");
  });

  it("builds a headed brief for run context", () => {
    const brief = projectBrief(richProject());
    expect(brief).toContain("Project: Shop (shop)");
    expect(brief).toContain("Definition: Persian online store");
    expect(brief).toContain("Repository: acme/shop @ main");
    expect(brief).toContain("Key features: auth, payments");
  });
});

describe("definition selections → agent prompts", () => {
  it("lands in the research system prompt", () => {
    const gen = new AgentGenerator({} as never, {} as never, {} as never);
    const prompt = gen.promptFor("research", richProject());
    expect(prompt).toContain("Platforms: web, mobile");
    expect(prompt).toContain("Key features: auth, payments");
    expect(prompt).toContain("Integrations: telegram, zarinpal");
    expect(prompt).toContain("Deployment: docker, azure");
  });

  it("lands in the run context project-profile source", async () => {
    const engine = new ContextEngine();
    const now = new Date().toISOString();
    const built = await engine.build({
      project: richProject(),
      agent: { id: "a", type: "research", name: "Research", systemPrompt: "sys", role: "r", maxIterations: 1, timeoutMs: 1 } as never,
      task: { id: "t", projectId: "p1", title: "T", description: "d", status: "created", correlationId: "c", input: {}, createdAt: now, updatedAt: now } as never,
      github: { getFile: async () => undefined, listCommits: async () => [] } as never,
      memory: { search: async () => [] } as never,
    });
    const profile = built.sources.find((s) => s.label === "project-profile")?.content ?? "";
    expect(profile).toContain("Platforms: web, mobile");
    expect(profile).toContain("Key features: auth, payments");
    expect(profile).toContain("Integrations: telegram, zarinpal");
    expect(profile).toContain("Project: Shop (shop)");
  });
});

describe("definition selections → prompts API", () => {
  let cleanup: (() => void) | undefined;
  let app: FastifyInstance | undefined;
  const ENV_KEYS = ["REQUIRE_AUTH", "OPENAI_API_KEY"] as const;
  let savedEnv: Record<string, string | undefined>;

  async function boot(): Promise<FastifyInstance> {
    const container = new Container();
    await container.ensureSeed();
    app = (await buildServer(container)).app;
    await app.ready();
    return app;
  }

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    getEnvFresh();
    cleanup = freshDb().cleanup;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    getEnvFresh();
    cleanup?.();
  });

  async function researchPrompt(srv: FastifyInstance, id: string): Promise<string> {
    const res = await srv.inject({ method: "GET", url: `/projects/${id}/agents` });
    const agents = res.json() as Array<{ type: string; systemPrompt: string }>;
    return agents.find((a) => a.type === "research")?.systemPrompt ?? "";
  }

  it("builds agent prompts from the creation selections and refreshes them on edit", async () => {
    const srv = await boot();
    const created = await srv.inject({
      method: "POST",
      url: "/projects",
      payload: {
        name: "Shop",
        description: "Persian online store",
        configRepo: "acme/shop",
        capabilities: {
          platforms: ["web"],
          languages: ["csharp"],
          frameworks: ["dotnet"],
          databases: ["sqlserver"],
          deploymentTargets: ["docker"],
          features: ["auth"],
          integrations: ["telegram"],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const before = await researchPrompt(srv, id);
    expect(before).toContain("Platforms: web");
    expect(before).toContain("Key features: auth");
    expect(before).toContain("Integrations: telegram");

    // Editing the definition re-onboards and rebuilds the prompts.
    const patched = await srv.inject({
      method: "PATCH",
      url: `/projects/${id}`,
      payload: { capabilities: { features: ["auth", "payments"], platforms: ["web", "mobile"] } },
    });
    expect(patched.statusCode).toBe(200);

    const after = await researchPrompt(srv, id);
    expect(after).toContain("Key features: auth, payments");
    expect(after).toContain("Platforms: web, mobile");
  });
});
