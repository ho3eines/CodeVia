import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";
import { getEnvFresh } from "../config/env.js";
import type { FastifyInstance } from "fastify";
import type { Project } from "../domain/entities.js";

/* ------------------------------------------------------------------ *
 * Local-folder projects, end-to-end through the HTTP layer:
 *   POST /projects/scan, POST /projects/from-local,
 *   GET /projects/:id/analysis, GET /fs/list, GET /fs/stat
 *   + auth gating, conflict handling, and legacy-project compatibility
 * ------------------------------------------------------------------ */

let app: FastifyInstance | undefined;
let container: Container;
let fixtureRoot: string;
let cleanupDb: () => void;
const savedEnv: Record<string, string | undefined> = {};

async function boot(): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  const built = await buildServer(container);
  app = built.app;
  await app.ready();
  return app;
}

beforeEach(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "localproj-"));
  mkdirSync(join(fixtureRoot, "src"));
  writeFileSync(
    join(fixtureRoot, "package.json"),
    JSON.stringify(
      {
        name: "fixture-app",
        description: "fixture app for route tests",
        scripts: { dev: "tsx src/index.ts", build: "tsc" },
        dependencies: { express: "^4.0.0" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(fixtureRoot, "src", "index.ts"), "export {};");
  writeFileSync(join(fixtureRoot, ".env"), "CANARY_SECRET=do-not-leak");

  for (const k of ["CODEVIA_ALLOWED_ROOTS", "REQUIRE_AUTH", "AUTH_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"])
    savedEnv[k] = process.env[k];
  process.env.CODEVIA_ALLOWED_ROOTS = fixtureRoot;
  delete process.env.REQUIRE_AUTH;
  getEnvFresh();
  cleanupDb = freshDb().cleanup;
  await boot();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  cleanupDb();
  rmSync(fixtureRoot, { recursive: true, force: true });
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  getEnvFresh();
});

describe("POST /projects/scan", () => {
  it("returns the structured analysis for a folder", async () => {
    const res = await app!.inject({ method: "POST", url: "/projects/scan", payload: { path: fixtureRoot } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.analysis.name).toBe("fixture-app");
    expect(body.analysis.languages).toContain("TypeScript");
    expect(body.analysis.packageManager).toBe("npm");
    expect(JSON.stringify(body)).not.toContain("CANARY_SECRET");
  });

  it("rejects paths outside the allowed roots with 403", async () => {
    const res = await app!.inject({ method: "POST", url: "/projects/scan", payload: { path: "/etc" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FS_PATH_OUTSIDE_ROOTS");
  });

  it("validates the body", async () => {
    const res = await app!.inject({ method: "POST", url: "/projects/scan", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("404s for a missing folder", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/projects/scan",
      payload: { path: join(fixtureRoot, "does-not-exist") },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("FS_NOT_FOUND");
  });
});

describe("POST /projects/from-local", () => {
  it("creates a project without any GitHub field", async () => {
    const res = await app!.inject({ method: "POST", url: "/projects/from-local", payload: { path: fixtureRoot } });
    expect(res.statusCode).toBe(201);
    const project: Project = res.json();
    expect(project.sourceType).toBe("local");
    expect(project.localPath).toBe(fixtureRoot);
    expect(project.name).toBe("fixture-app");
    expect(project.slug).toBe("fixture-app");
    expect(project.repositories).toEqual([]);
    expect(project.githubConnection).toBeUndefined();
    expect(project.analysis?.languages).toContain("TypeScript");
    // capabilities go through the option catalog (canonical values)
    expect(project.capabilities.languages).toContain("typescript");
    expect(project.capabilities.frameworks).toContain("nodejs-express");
    expect(project.active).toBe(true);
  });

  it("applies user overrides over the detected values", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/projects/from-local",
      payload: {
        path: fixtureRoot,
        overrides: { name: "My Custom Name", description: "custom desc", capabilities: { languages: ["Go"] } },
      },
    });
    expect(res.statusCode).toBe(201);
    const project = res.json();
    expect(project.name).toBe("My Custom Name");
    expect(project.slug).toBe("my-custom-name");
    expect(project.description).toBe("custom desc");
    // Override wins over the analysis detection (canonicalized to "go").
    expect(project.capabilities.languages[0]).toBe("go");
  });

  it("conflicts (409) when the same folder is linked again", async () => {
    const first = await app!.inject({ method: "POST", url: "/projects/from-local", payload: { path: fixtureRoot } });
    expect(first.statusCode).toBe(201);
    const second = await app!.inject({ method: "POST", url: "/projects/from-local", payload: { path: fixtureRoot } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already linked/i);
  });

  it("conflicts (409) on a duplicate slug", async () => {
    mkdirSync(join(fixtureRoot, "other"), { recursive: true });
    writeFileSync(join(fixtureRoot, "other", "package.json"), JSON.stringify({ name: "fixture-app" }));
    const first = await app!.inject({ method: "POST", url: "/projects/from-local", payload: { path: fixtureRoot } });
    expect(first.statusCode).toBe(201);
    const second = await app!.inject({
      method: "POST",
      url: "/projects/from-local",
      payload: { path: join(fixtureRoot, "other"), overrides: { name: "fixture-app" } },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/slug/i);
  });

  it("rejects paths outside the allowed roots", async () => {
    const res = await app!.inject({ method: "POST", url: "/projects/from-local", payload: { path: "/etc" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("project read paths with a local project", () => {
  it("GET /projects lists it and GET /projects/:id returns it intact", async () => {
    const created = await app!.inject({ method: "POST", url: "/projects/from-local", payload: { path: fixtureRoot } });
    const project = created.json() as Project;

    const list = await app!.inject({ method: "GET", url: "/projects" });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Project[]).some((p) => p.id === project.id)).toBe(true);

    const got = await app!.inject({ method: "GET", url: `/projects/${project.id}` });
    expect(got.statusCode).toBe(200);
    const hydrated = got.json() as Project;
    expect(hydrated.sourceType).toBe("local");
    expect(hydrated.localPath).toBe(fixtureRoot);
    expect(hydrated.repositories).toEqual([]);
  });

  it("GET /projects/:id/analysis returns the stored analysis", async () => {
    const created = await app!.inject({ method: "POST", url: "/projects/from-local", payload: { path: fixtureRoot } });
    const project = created.json() as Project;
    const res = await app!.inject({ method: "GET", url: `/projects/${project.id}/analysis` });
    expect(res.statusCode).toBe(200);
    expect(res.json().analysis.rootPath).toBe(fixtureRoot);
    expect(res.json().analysis.name).toBe("fixture-app");
  });

  it("GET /projects/:id/analysis 404s for projects without an analysis", async () => {
    // A legacy-shaped project: no sourceType, no analysis, no repositories.
    const legacy: Project = {
      id: "proj-legacy01",
      slug: "legacy-github-project",
      name: "Legacy",
      description: "",
      configRepo: "some/repo",
      branch: "main",
      repositories: [{ repo: "some/repo", branch: "main", role: "primary", isConfigRepo: true }],
      capabilities: {
        platforms: [],
        languages: ["TypeScript"],
        frameworks: [],
        databases: [],
        deploymentTargets: [],
        features: [],
        integrations: [],
        agentTypes: [],
      },
      settings: {
        environment: "development",
        notifications: [],
        rules: [],
        skills: [],
        workflows: [],
        budget: { maxTokensPerRun: 1, maxCallsPerRun: 1, maxCostUsdPerRun: 1, maxDurationMs: 1 },
        permissions: {} as Project["settings"]["permissions"],
        metadata: {},
      },
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    container.projectRepo.upsert(legacy, { key: legacy.slug });

    const got = await app!.inject({ method: "GET", url: "/projects/proj-legacy01" });
    expect(got.statusCode).toBe(200);
    expect((got.json() as Project).configRepo).toBe("some/repo");

    const analysis = await app!.inject({ method: "GET", url: "/projects/proj-legacy01/analysis" });
    expect(analysis.statusCode).toBe(404);
  });
});

describe("local project through repo-centric routes (audit regressions)", () => {
  let projectId: string;

  beforeEach(async () => {
    const created = await app!.inject({ method: "POST", url: "/projects/from-local", payload: { path: fixtureRoot } });
    expect(created.statusCode).toBe(201);
    projectId = (created.json() as Project).id;
  });

  it("PATCHes metadata without any repository (no 5xx, change persisted)", async () => {
    const res = await app!.inject({
      method: "PATCH",
      url: `/projects/${projectId}`,
      payload: { description: "renamed description", name: "Renamed App" },
    });
    expect(res.statusCode).toBe(200);
    const got = await app!.inject({ method: "GET", url: `/projects/${projectId}` });
    const p = got.json() as Project;
    expect(p.description).toBe("renamed description");
    expect(p.name).toBe("Renamed App");
    expect(p.sourceType).toBe("local");
  });

  it("PATCHes capabilities (re-onboard path) without a repository", async () => {
    const res = await app!.inject({
      method: "PATCH",
      url: `/projects/${projectId}`,
      payload: { capabilities: { languages: ["python"] }, reonboard: true },
    });
    expect(res.statusCode).toBe(200);
    const p = res.json() as Project;
    expect(p.capabilities.languages[0]).toBe("python");
  });

  it("deactivates/reactivates the project", async () => {
    const res = await app!.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { active: false } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Project).active).toBe(false);
  });

  it("repo-status answers 200 with an explanation instead of crashing", async () => {
    const res = await app!.inject({ method: "GET", url: `/projects/${projectId}/repo-status` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.healthy).toBe(false); // no repository linked — by design
    expect(body.project.id).toBe(projectId);
  });

  it("repo-centric routes return a clear 400, not a GitHub 502", async () => {
    for (const [method, url] of [
      ["POST", `/projects/${projectId}/pull`],
      ["GET", `/projects/${projectId}/files`],
      ["GET", `/projects/${projectId}/file?path=CodeVia/project.md`],
      ["POST", `/projects/${projectId}/ci-setup`],
      ["POST", `/projects/${projectId}/pull-requests`],
      ["POST", `/projects/${projectId}/issues`],
    ] as const) {
      const res = await app!.inject({
        method,
        url,
        ...(method === "GET" ? {} : { payload: { title: "t", head: "a", base: "b" } }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/no linked repository/i);
    }
  });

  it("project subresources (agents/tasks/memory/workflows/runs) stay readable", async () => {
    for (const url of [
      `/agents?projectId=${projectId}`,
      `/tasks?projectId=${projectId}`,
      `/memory?projectId=${projectId}`,
      `/workflows?projectId=${projectId}`,
      `/runs?projectId=${projectId}`,
      `/projects/${projectId}/options`,
    ]) {
      const res = await app!.inject({ method: "GET", url });
      expect([200, 404]).toContain(res.statusCode);
      expect(res.statusCode).not.toBeGreaterThanOrEqual(500);
    }
  });
});

describe("GET /fs/list and /fs/stat", () => {
  it("lists the allowed roots when no path is given", async () => {
    const res = await app!.inject({ method: "GET", url: "/fs/list" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries.some((e: { name: string }) => e.name === fixtureRoot)).toBe(true);
  });

  it("lists a directory and describes sensitive files without opening them", async () => {
    const res = await app!.inject({ method: "GET", url: `/fs/list?path=${encodeURIComponent(fixtureRoot)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("package.json");
    expect(names).toContain(".env");
    expect(body.entries.find((e: { name: string }) => e.name === ".env").sensitive).toBe(true);
    expect(body.entries.find((e: { name: string }) => e.name === "src").kind).toBe("directory");
  });

  it("stats a path with typed metadata", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/fs/stat?path=${encodeURIComponent(join(fixtureRoot, "package.json"))}`,
    });
    expect(res.statusCode).toBe(200);
    const stat = res.json();
    expect(stat.kind).toBe("file");
    expect(stat.name).toBe("package.json");
    expect(stat.size).toBeGreaterThan(0);
  });

  it("refuses paths outside the allowed roots", async () => {
    const res = await app!.inject({ method: "GET", url: `/fs/list?path=${encodeURIComponent("/etc")}` });
    expect(res.statusCode).toBe(403);
    const res2 = await app!.inject({ method: "GET", url: `/fs/stat?path=${encodeURIComponent("/etc/passwd")}` });
    expect(res2.statusCode).toBe(403);
  });

  it("404s for a missing path", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/fs/stat?path=${encodeURIComponent(join(fixtureRoot, "nope.txt"))}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("authentication gate", () => {
  it("requires a session when REQUIRE_AUTH is on", async () => {
    // Reboot the app with strict auth (auth-guard pattern).
    if (app) {
      await app.close();
      app = undefined;
    }
    process.env.REQUIRE_AUTH = "true";
    process.env.AUTH_SECRET = "test-auth-secret-for-localproj-0123456789";
    // Login must be *configured*, otherwise non-production servers deliberately
    // downgrade strict auth instead of locking everybody out.
    process.env.GITHUB_CLIENT_ID = "test-client-id";
    process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
    getEnvFresh();
    await boot();

    const res = await app!.inject({ method: "GET", url: "/fs/list" });
    expect(res.statusCode).toBe(401);
    const res2 = await app!.inject({ method: "POST", url: "/projects/scan", payload: { path: fixtureRoot } });
    expect(res2.statusCode).toBe(401);
    const res3 = await app!.inject({ method: "POST", url: "/projects/from-local", payload: { path: fixtureRoot } });
    expect(res3.statusCode).toBe(401);
  });
});
