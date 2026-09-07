import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import type { Project } from "../domain/entities.js";
import { getEnvFresh } from "../config/env.js";
import { storeUserGitHubToken } from "../auth/github-tokens.js";
import { setUserGitHubFetchForTest } from "../github/registry.js";
import type { MockGitHubService } from "../github/mock-service.js";
import { freshDb } from "./test-helpers.js";

let fx: ReturnType<typeof freshDb>;
let c: Container;
let project: Project;
let app: FastifyInstance | undefined;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const remoteFile = "CodeVia/oauth-only.md";

beforeEach(async () => {
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("GITHUB_ENABLED", "false");
  vi.stubEnv("GITHUB_CLIENT_ID", "");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "");
  getEnvFresh();
  fx = freshDb(); c = new Container(); await c.ensureSeed();
  project = await c.agentManager.createProject({ name: "OAuth files", description: "Project-owned browsing", configRepo: "acme/oauth-files" });
  const snapshot = await c.projectFiles.pull(project);
  const files = new Map(snapshot.contents);
  files.set(remoteFile, "Only the project's OAuth repository contains this file.\n");
  project = { ...project, ownerId: "owner-a", githubConnection: { kind: "mock" } };
  c.projectRepo.upsert(project, { key: project.slug });
  storeUserGitHubToken(c.kv, "owner-a", "test-only-project-oauth-token");

  // Exercise the real REST adapter with a fake transport, not live GitHub.
  // A successful read must use the owner's OAuth token, never the mock copy.
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-only-project-oauth-token");
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/oauth-files/branches") return json([{ name: "main", commit: { sha: "remote-head" } }]);
    const prefix = "/repos/acme/oauth-files/contents/";
    if (!url.pathname.startsWith(prefix)) throw new Error(`Unexpected GitHub path: ${url.pathname}`);
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    if (path === "CodeVia") return json([...files.keys()].map((path) => ({ path, type: "file" })));
    const content = files.get(path);
    if (content === undefined) return json({ message: "Not found" }, 404);
    return json({ path, sha: "remote-blob", encoding: "base64", content: Buffer.from(content).toString("base64") });
  });
  setUserGitHubFetchForTest(fetcher);
  app = (await buildServer(c)).app;
  await app.ready();
});

afterEach(async () => {
  await app?.close(); app = undefined;
  c.githubAutomation.stop();
  setUserGitHubFetchForTest(undefined);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); getEnvFresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fx.cleanup();
});

describe("project-owned GitHub file browsing", () => {
  it("lists files through the promoted OAuth connection and honors the requested branch", async () => {
    const fallback = vi.spyOn(c.github, "listFiles");
    const res = await app!.inject({ method: "GET", url: `/projects/${project.id}/files?branch=feature` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toContainEqual(expect.objectContaining({ path: remoteFile }));
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/contents/CodeVia?ref=feature"))).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("reads file content through the same connection used for canonical state", async () => {
    const fallback = vi.spyOn(c.github, "getFile");
    const res = await app!.inject({ method: "GET", url: `/projects/${project.id}/file?path=${remoteFile}&branch=feature` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ path: remoteFile, content: "Only the project's OAuth repository contains this file.\n", sha: "remote-blob" });
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith(`/contents/${remoteFile}?ref=feature`))).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("rejects the mock recovery write mode for a real OAuth connection", async () => {
    await expect(c.agentManager.syncProjectState(project.id, undefined, { recoverMissingMock: true })).rejects.toThrow(/mock recovery cannot write to real GitHub/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 404, 503])("fails closed on real GitHub HTTP %i without seeding or replacing cached definitions", async (status) => {
    const before = c.agentRepo.byProject(project.id);
    const seed = vi.spyOn(c.github as MockGitHubService, "seedRepo");
    const fallback = vi.spyOn(c.github, "listFiles");
    fetcher.mockImplementation(async () => json({ message: "Unavailable" }, status));
    const res = await app!.inject({ method: "GET", url: `/projects/${project.id}/files` });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("test-only-project-oauth-token");
    expect(c.agentRepo.byProject(project.id)).toEqual(before);
    expect(seed).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
});
