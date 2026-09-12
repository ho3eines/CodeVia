import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";
import type { IGitHubService } from "../github/types.js";
import type { Project } from "../domain/entities.js";
import { signSession } from "../auth/github-oauth.js";
import { storeUserGitHubToken } from "../auth/github-tokens.js";
import { setUserGitHubFetchForTest } from "../github/registry.js";

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
    seedRepo(
      owner: string,
      name: string,
      opts?: { files?: Array<{ path: string; content: string }>; branch?: string },
    ): unknown;
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
      platforms: [],
      languages: [],
      frameworks: [],
      databases: [],
      deploymentTargets: [],
      features: [],
      integrations: [],
      agentTypes: [],
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
  return {
    ...legacy,
    repositories: [
      {
        repo: configRepo,
        branch: "main",
        role: "primary",
        isConfigRepo: true,
        htmlUrl: `https://github.com/${configRepo}`,
        addedAt: new Date().toISOString(),
      },
    ],
  } as unknown as Project;
}

describe("project chat send", () => {
  it("injects real repository evidence (README + tree) into the chat prompt", async () => {
    const name = `blazor-${randomUUID().slice(0, 8)}`;
    const repo = `acme/${name}`;
    const gh = container.github as unknown as {
      seedRepo(
        owner: string,
        name: string,
        opts?: { files?: Array<{ path: string; content: string }>; branch?: string },
      ): unknown;
    };
    gh.seedRepo("acme", name, {
      files: [
        { path: "README.md", content: "# Pdd.ir — Blazor shop\nThis is a Blazor WebAssembly project." },
        { path: "Pdd.ir.csproj", content: '<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">' },
        { path: "Program.cs", content: "var builder = WebAssemblyHostBuilder.CreateDefault(args);" },
      ],
      branch: "main",
    });

    const project = modernProject(`proj-${name}`, name, repo);
    container.projectRepo.upsert(project, { key: project.slug });

    const created = await app.inject({
      method: "POST",
      url: "/conversations",
      payload: { projectId: project.id, title: "Project Chat", userId: "local-user" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const conv = created.json();

    const spy = vi.spyOn(container.aiText, "complete");
    try {
      const res = await app.inject({
        method: "POST",
        url: `/conversations/${conv.id}/messages`,
        payload: { role: "user", content: "پروژه رو بررسی کن" },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().messages.at(-1).role).toBe("assistant");
      expect(spy).toHaveBeenCalled();
      const messages = spy.mock.calls[0][0].messages;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("Pdd.ir — Blazor shop");
      expect(system).toContain("BlazorWebAssembly");
      expect(system).toContain("Pdd.ir.csproj");
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it("sends on a legacy project that has no repositories array", async () => {
    const project = legacyProject("proj-legacy1", "legacy1", "acme/legacy");
    container.projectRepo.upsert(project, { key: project.slug });

    const created = await app.inject({
      method: "POST",
      url: "/conversations",
      payload: { projectId: project.id, title: "Project Chat", userId: "local-user" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const conv = created.json();

    const res = await app.inject({
      method: "POST",
      url: `/conversations/${conv.id}/messages`,
      payload: { role: "user", content: "سلام" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    expect(body.messages.at(-1).role).toBe("assistant");
    expect(body.messages.at(-1).content).toBeTruthy();
  }, 30000);

  it("does not 500 when attachments arrive as a non-array", async () => {
    const project = legacyProject("proj-legacy2", "legacy2", "acme/legacy2");
    container.projectRepo.upsert(project, { key: project.slug });
    const conv = (
      await app.inject({
        method: "POST",
        url: "/conversations",
        payload: { projectId: project.id, title: "Project Chat", userId: "local-user" },
      })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/conversations/${conv.id}/messages`,
      payload: { role: "user", content: "سلام", attachments: { name: "x" } },
    });
    expect(res.statusCode, res.body).toBe(200);
  }, 30000);

  it("still sends for a normal project and dispatches non-chat modes", async () => {
    const p = modernProject("proj-modern1", "modern1", "acme/modern");
    container.projectRepo.upsert(p, { key: p.slug });
    const conv = (
      await app.inject({
        method: "POST",
        url: "/conversations",
        payload: { projectId: p!.id, title: "Project Chat", userId: "local-user" },
      })
    ).json();
    const chat = await app.inject({
      method: "POST",
      url: `/conversations/${conv.id}/messages`,
      payload: { role: "user", content: "سلام" },
    });
    expect(chat.statusCode, chat.body).toBe(200);
    expect(chat.json().messages.at(-1).role).toBe("assistant");

    const dispatched = await app.inject({
      method: "POST",
      url: `/conversations/${conv.id}/messages`,
      payload: { role: "user", content: "یک کار انجام بده", executionMode: "agent" },
    });
    expect(dispatched.statusCode, dispatched.body).toBe(200);
    expect(dispatched.json().messages.at(-1).metadata?.dispatchedTaskId).toBeTruthy();
  }, 30000);

  it("still returns the assistant reply when GitHub conversation sync fails", async () => {
    const project = legacyProject("proj-legacy-persist", "legacy-persist", "acme/legacy");
    container.projectRepo.upsert(project, { key: project.slug });
    const created = await app.inject({
      method: "POST",
      url: "/conversations",
      payload: { projectId: project.id, title: "Project Chat", userId: "local-user" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const conv = created.json();
    const spy = vi
      .spyOn(container.projectFiles, "syncConversation")
      .mockRejectedValue(Object.assign(new Error("GitHub 404"), { status: 404 }));
    try {
      const res = await app.inject({
        method: "POST",
        url: `/conversations/${conv.id}/messages`,
        payload: { role: "user", content: "سلام" },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.messages.at(-1).role).toBe("assistant");
      expect(body.messages.at(-1).content).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it("keeps the in-page thread after GET /projects restores a unique empty repo", async () => {
    // Persist-spy 200 on a reused acme/legacy repo is a false green: restore
    // throws "conversation identity crosses projects" before prune can run.
    // A unique README-only repo lets restore succeed with an empty
    // CodeVia/conversations tree — the path that used to wipe the live chat
    // and 404 the next send. Spy persist so Git stays empty.
    const name = `empty-wipe-${randomUUID().slice(0, 8)}`;
    const repo = `acme/${name}`;
    const gh = container.github as unknown as {
      seedRepo(
        owner: string,
        name: string,
        opts?: { files?: Array<{ path: string; content: string }>; branch?: string },
      ): unknown;
    };
    gh.seedRepo("acme", name, { files: [{ path: "README.md", content: `# ${name}\n` }], branch: "main" });

    const project = legacyProject(`proj-${name}`, name, repo);
    container.projectRepo.upsert(project, { key: project.slug });

    const spy = vi
      .spyOn(container.projectFiles, "syncConversation")
      .mockRejectedValue(Object.assign(new Error("GitHub 404"), { status: 404 }));
    try {
      const created = await app.inject({
        method: "POST",
        url: "/conversations",
        payload: { projectId: project.id, title: "Project Chat", userId: "local-user" },
      });
      expect(created.statusCode, created.body).toBe(200);
      const conv = created.json();

      const first = await app.inject({
        method: "POST",
        url: `/conversations/${conv.id}/messages`,
        payload: { role: "user", content: "سلام" },
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().messages.at(-1).role).toBe("assistant");

      const listed = await app.inject({ method: "GET", url: "/projects" });
      expect(listed.statusCode, listed.body).toBe(200);
      // Prove restore of THIS project succeeded (empty snapshot), not that
      // GET /projects merely skipped a throwing restore.
      await expect(container.agentManager.readProject(project.id)).resolves.toMatchObject({ id: project.id });
      expect(container.conversationRepo.findById(conv.id)?.data).toBeTruthy();

      const second = await app.inject({
        method: "POST",
        url: `/conversations/${conv.id}/messages`,
        payload: { role: "user", content: "ادامه بده" },
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().messages.at(-1).role).toBe("assistant");
      expect(second.json().messages.length).toBeGreaterThanOrEqual(4);
    } finally {
      spy.mockRestore();
    }
  }, 30000);
});

/**
 * Logged-in owner + project stored as `server-token` + live GITHUB_TOKEN.
 * Repo writes must use the owner's OAuth token (`tok-alice`), never the PAT
 * (`ghs_server` is login-only and 404s on the owner's private repos).
 */
describe("project chat send uses the owner's OAuth token, not GITHUB_TOKEN", () => {
  const ENV_KEYS = [
    "REQUIRE_AUTH",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "AUTH_SECRET",
    "GITHUB_TOKEN",
    "GITHUB_ENABLED",
  ] as const;
  let savedEnv: Record<string, string | undefined>;
  let cleanupOwner: (() => void) | undefined;
  let ownerApp: FastifyInstance | undefined;
  let ownerContainer: Container;

  function repoFake(seen: string[]): typeof fetch {
    let head = "head-sha";
    const files = new Map<string, string>();
    let n = 0;
    const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    const listDir = (dir: string) => {
      const prefix = dir ? `${dir.replace(/\/$/, "")}/` : "";
      const names = new Set<string>();
      const items: Array<{ path: string; type: string; size?: number }> = [];
      for (const p of files.keys()) {
        if (dir && p !== dir && !p.startsWith(prefix)) continue;
        if (p === dir) continue;
        const rest = dir ? p.slice(prefix.length) : p;
        const name = rest.split("/")[0];
        if (!name || names.has(name)) continue;
        names.add(name);
        const full = dir ? prefix + name : name;
        const isFile = files.has(full);
        items.push({ path: full, type: isFile ? "file" : "dir", size: isFile ? files.get(full)!.length : undefined });
      }
      return items;
    };
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seen.push(auth);
      if (auth === "Bearer ghs_server") return json({ message: "Not Found" }, 404);
      if (auth !== "Bearer tok-alice") return json({ message: "Bad credentials" }, 401);

      if (url.endsWith("/user") && method === "GET") {
        return json({ login: "alice", name: "Alice" }, 200, { "x-oauth-scopes": "repo, read:user, user:email" });
      }
      if (url.includes("/branches?") || /\/branches(?:\?|$)/.test(url)) {
        return json([{ name: "main", commit: { sha: head } }]);
      }
      if (url.includes("/branches/main")) {
        return json({ name: "main", commit: { sha: head } });
      }
      if (url.includes("/git/commits/") && method === "GET") {
        return json({ sha: head, tree: { sha: `tree-${head}` } });
      }
      if (url.includes("/git/trees") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          tree?: Array<{ path?: string; content?: string; sha?: string | null }>;
        };
        for (const entry of body.tree ?? []) {
          if (!entry.path) continue;
          if (entry.sha === null) files.delete(entry.path);
          else if (typeof entry.content === "string") files.set(entry.path, entry.content);
        }
        return json({ sha: `tree-${++n}` });
      }
      if (url.includes("/git/commits") && method === "POST") {
        head = `commit-${++n}`;
        return json({ sha: head });
      }
      if (url.includes("/git/refs/") && method === "PATCH") {
        return json({ object: { sha: head } });
      }
      if (url.includes("/contents/")) {
        const pathMatch = url.match(/\/contents\/([^?]*)/);
        const dir = decodeURIComponent(pathMatch?.[1] ?? "").replace(/\/$/, "");
        if (dir && files.has(dir)) {
          return json({ content: Buffer.from(files.get(dir)!).toString("base64"), sha: "blob" });
        }
        return json(listDir(dir));
      }
      return json({ message: `not found ${url}` }, 404);
    }) as typeof fetch;
  }

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.AUTH_SECRET = "test-auth-secret-for-chat-oauth-0123456789";
    process.env.GITHUB_TOKEN = "ghs_server";
    process.env.GITHUB_ENABLED = "true";
    getEnvFresh();
    cleanupOwner = freshDb().cleanup;
  });

  afterEach(async () => {
    setUserGitHubFetchForTest(undefined);
    vi.unstubAllGlobals();
    ownerContainer?.githubAutomation.stop();
    if (ownerApp) {
      await ownerApp.close();
      ownerApp = undefined;
    }
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    getEnvFresh();
    cleanupOwner?.();
  });

  it("sends with the owner's OAuth token and rebinds a server-token project", async () => {
    const seen: string[] = [];
    const fake = repoFake(seen);
    setUserGitHubFetchForTest(fake);
    vi.stubGlobal("fetch", fake);

    ownerContainer = new Container();
    await ownerContainer.ensureSeed();
    ownerApp = (await buildServer(ownerContainer)).app;
    await ownerApp.ready();

    const alice = ownerContainer.userRepo.upsertGitHubUser({
      id: 1,
      login: "alice",
      name: "Alice",
      email: "a@example.com",
    }).user;
    storeUserGitHubToken(ownerContainer.kv, alice.id, "tok-alice", { scopes: "repo", login: "alice" });
    const cookie = `cv_session=${signSession(alice.id)}`;

    const now = new Date().toISOString();
    const project = {
      ...legacyProject("proj-owner-chat", "owner-chat", "alice/app"),
      ownerId: alice.id,
      githubConnection: { kind: "server-token" as const },
      createdAt: now,
      updatedAt: now,
    } as unknown as Project;
    ownerContainer.projectRepo.upsert(project, { key: project.slug });

    const listed = await ownerApp.inject({ method: "GET", url: "/projects", headers: { cookie } });
    expect(listed.statusCode, listed.body).toBe(200);

    const created = await ownerApp.inject({
      method: "POST",
      url: "/conversations",
      headers: { cookie },
      payload: { projectId: project.id, title: "Project Chat" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const conv = created.json();

    const res = await ownerApp.inject({
      method: "POST",
      url: `/conversations/${conv.id}/messages`,
      headers: { cookie },
      payload: { role: "user", content: "سلام" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.messages.at(-1).role).toBe("assistant");
    expect(body.messages.at(-1).content).toBeTruthy();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((auth) => auth === "Bearer tok-alice")).toBe(true);
    expect(ownerContainer.projectRepo.findById(project.id)?.data.githubConnection).toMatchObject({
      kind: "user-oauth",
      userId: alice.id,
      login: "alice",
    });
  }, 30000);
});

/* ------------------------------------------------------------------ *
 * Standalone chat: conversations without a projectId power the
 * top-level Chat page (simple AI Q&A, no project needed). They answer
 * with a generic assistant prompt and skip repo context, GitHub mirror
 * and task dispatch — those stay in the project section.
 * ------------------------------------------------------------------ */
describe("standalone chat (no project)", () => {
  it("creates a conversation without projectId", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/conversations",
      payload: { title: "Hello", userId: "local-user" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const conv = created.json();
    expect(conv.id).toBeTruthy();
    expect(conv.projectId).toBeUndefined();
  }, 30000);

  it("still 404s when given a bogus projectId", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/conversations",
      payload: { projectId: "proj-nope", title: "x" },
    });
    expect(created.statusCode).toBe(404);
  }, 30000);

  it("answers with a generic prompt and no repository context", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/conversations",
      payload: { title: "General Q", userId: "local-user" },
    });
    const conv = created.json();
    const spy = vi.spyOn(container.aiText, "complete");
    try {
      const res = await app.inject({
        method: "POST",
        url: `/conversations/${conv.id}/messages`,
        payload: { role: "user", content: "What is 2+2?" },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.messages.length).toBeGreaterThanOrEqual(2);
      expect(body.messages.at(-1).role).toBe("assistant");
      expect(spy).toHaveBeenCalled();
      const system = spy.mock.calls[0][0].messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("general-purpose");
      expect(system).not.toContain("project assistant AI for the project");
      expect(system).not.toContain("Repository context");
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it("guides task execution modes to the project chat instead of dispatching", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/conversations",
      payload: { title: "Tasks?", userId: "local-user" },
    });
    const conv = created.json();
    const tasksBefore = container.taskRepo.findMany().length;
    const res = await app.inject({
      method: "POST",
      url: `/conversations/${conv.id}/messages`,
      payload: { role: "user", content: "build it", executionMode: "autonomous" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const last = res.json().messages.at(-1);
    expect(last.role).toBe("assistant");
    expect(last.content).toContain("need a project");
    expect(container.taskRepo.findMany().length).toBe(tasksBefore);
  }, 30000);

  it("lists standalone chats for their owner", async () => {
    const before = (await app.inject({ method: "GET", url: "/conversations" })).json();
    await app.inject({ method: "POST", url: "/conversations", payload: { title: "List me", userId: "local-user" } });
    const after = (await app.inject({ method: "GET", url: "/conversations" })).json();
    expect(after.length).toBe(before.length + 1);
    expect(after.some((c: { title?: string; projectId?: string }) => c.title === "List me" && !c.projectId)).toBe(true);
  }, 30000);
});
