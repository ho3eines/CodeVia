import { describe, it, expect } from "vitest";
import {
  ALL_AGENT_TYPES,
  CORE_AGENT_TYPES,
  agentTypesForProject,
  configRepoOf,
  getProjectOptionCatalog,
  hydrateProject,
  isValidRepoFullName,
  legacyFieldsFromCapabilities,
  normalizeCapabilities,
  normalizeRepositories,
} from "../domain/project-options.js";
import type { Project } from "../domain/entities.js";

describe("project option catalog", () => {
  it("exposes every multi-select dimension with stable ids", () => {
    const c = getProjectOptionCatalog();
    for (const key of ["platforms", "languages", "frameworks", "databases", "deploymentTargets", "features", "integrations", "agentTypes"] as const) {
      expect(c[key].length, key).toBeGreaterThan(3);
      const ids = c[key].map((o) => o.value);
      expect(new Set(ids).size, `${key} ids unique`).toBe(ids.length);
    }
    expect(c.agentTypes.map((a) => a.value)).toEqual(ALL_AGENT_TYPES);
    expect(c.coreAgentTypes).toEqual(CORE_AGENT_TYPES);
  });
});

describe("normalizeCapabilities (multi-select)", () => {
  it("accepts arrays, comma strings and legacy single values", () => {
    const caps = normalizeCapabilities(
      { platforms: ["web", "Mobile — iOS"], databases: "SQL Server, postgres", languages: ["C#", "typescript"] },
      { framework: ".NET", database: "Redis" },
    );
    expect(caps.platforms).toEqual(["web", "mobile-ios"]);
    expect(caps.databases).toEqual(["sqlserver", "postgresql", "redis"]);
    expect(caps.languages).toEqual(["csharp", "typescript"]);
    expect(caps.frameworks).toEqual(["dotnet"]);
  });

  it("keeps unknown custom values and de-duplicates", () => {
    const caps = normalizeCapabilities({ frameworks: ["Phoenix", "phoenix", "React"] });
    expect(caps.frameworks).toEqual(["phoenix", "react"]);
  });

  it("drops agent types that do not exist", () => {
    const caps = normalizeCapabilities({ agentTypes: ["backend-developer", "not-an-agent", "devops"] });
    expect(caps.agentTypes).toEqual(["backend-developer", "devops"]);
  });

  it("derives legacy single-value labels from the first selection", () => {
    const caps = normalizeCapabilities({ languages: ["typescript", "go"], frameworks: ["nextjs"], databases: ["postgresql"], deploymentTargets: ["kubernetes"] });
    expect(legacyFieldsFromCapabilities(caps)).toEqual({
      primaryLanguage: "TypeScript",
      framework: "Next.js",
      database: "PostgreSQL",
      deploymentTarget: "Kubernetes",
    });
  });
});

describe("agentTypesForProject", () => {
  it("returns every agent when nothing is selected (legacy behaviour)", () => {
    expect(agentTypesForProject(normalizeCapabilities({}))).toEqual(ALL_AGENT_TYPES);
  });

  it("always includes the core agents next to an explicit roster", () => {
    const roster = agentTypesForProject(normalizeCapabilities({ agentTypes: ["backend-developer"] }));
    expect(roster).toContain("backend-developer");
    for (const core of CORE_AGENT_TYPES) expect(roster).toContain(core);
    expect(roster).not.toContain("frontend-developer");
  });

  it("derives a roster from the selected stack", () => {
    const roster = agentTypesForProject(normalizeCapabilities({ platforms: ["web"], databases: ["postgresql"], deploymentTargets: ["kubernetes"] }));
    expect(roster).toContain("frontend-developer");
    expect(roster).toContain("database");
    expect(roster).toContain("devops");
    expect(roster.length).toBeLessThan(ALL_AGENT_TYPES.length);
  });
});

describe("normalizeRepositories (multi-repo)", () => {
  it("validates owner/name and guarantees exactly one config repo", () => {
    const repos = normalizeRepositories([
      { repo: "acme/api", role: "backend" },
      { repo: "acme/web", role: "frontend", branch: "develop" },
      { repo: "not a repo" },
      { repo: "acme/api" }, // duplicate
    ]);
    expect(repos.map((r) => r.repo)).toEqual(["acme/api", "acme/web"]);
    expect(repos.filter((r) => r.isConfigRepo)).toHaveLength(1);
    expect(configRepoOf(repos)?.repo).toBe("acme/api");
    expect(repos[1].branch).toBe("develop");
  });

  it("falls back to the legacy configRepo/branch pair", () => {
    const repos = normalizeRepositories(undefined, { repo: "acme/legacy", branch: "main" });
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ repo: "acme/legacy", branch: "main", isConfigRepo: true });
    expect(normalizeRepositories(undefined, { repo: "garbage" })).toEqual([]);
  });

  it("honours an explicit isConfigRepo flag", () => {
    const repos = normalizeRepositories([{ repo: "a/one" }, { repo: "a/two", isConfigRepo: true }]);
    expect(configRepoOf(repos)?.repo).toBe("a/two");
    expect(repos.filter((r) => r.isConfigRepo)).toHaveLength(1);
  });

  it("isValidRepoFullName", () => {
    expect(isValidRepoFullName("owner/repo.name-1")).toBe(true);
    expect(isValidRepoFullName("owner/")).toBe(false);
    expect(isValidRepoFullName("https://github.com/o/r")).toBe(false);
  });
});

describe("hydrateProject (upgrade of old single-repo documents)", () => {
  it("builds repositories/capabilities from legacy fields and mirrors the config repo", () => {
    const legacy = {
      id: "p1",
      name: "Old",
      slug: "old",
      description: "",
      configRepo: "acme/old",
      branch: "master",
      framework: ".NET",
      database: "SQL Server",
      primaryLanguage: "C#",
      active: true,
      settings: { skills: [], rules: [], allowedTools: [], memoryScopes: [] },
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    } as unknown as Project;
    const p = hydrateProject(legacy);
    expect(p.repositories).toEqual([expect.objectContaining({ repo: "acme/old", branch: "master", isConfigRepo: true })]);
    expect(p.capabilities.frameworks).toEqual(["dotnet"]);
    expect(p.capabilities.databases).toEqual(["sqlserver"]);
    expect(p.capabilities.languages).toEqual(["csharp"]);
    expect(p.configRepo).toBe("acme/old");
    // idempotent
    expect(hydrateProject(p)).toEqual(p);
  });
});
