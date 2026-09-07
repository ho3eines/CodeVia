import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Project, Task } from "../domain/entities.js";
import { Container } from "../app/container.js";
import { MockGitHubService } from "../github/mock-service.js";
import {
  buildContextPack, renderContextMarkdown, parseRegistry, mergeRegistry,
  renderPromptContext, extendContent, syncProjectContext,
} from "../agents/context.js";
import { CONTEXT_FILE } from "../github/project-files.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * Context pack: implementers read the existing project before coding,
 * follow-up work extends merged files instead of overwriting them, and
 * CodeVia/context.md persists the architecture + entity registry.
 * ------------------------------------------------------------------ */

const project = (over: Partial<Project> = {}): Project =>
  ({ id: "p1", name: "Shop App", branch: "main", configRepo: "acme/shop", capabilities: {}, ...over }) as Project;

function seedCodeRepo(): MockGitHubService {
  const gh = new MockGitHubService({ seedDemoRepos: false });
  gh.seedRepo("acme", "shop", {
    files: [
      { path: "src/ShopApp.Api/ShopApp.Api.csproj", content: "<Project Sdk=\"Microsoft.NET.Sdk.Web\">\n</Project>\n" },
      { path: "src/ShopApp.Api/Controllers/LoginController.cs", content: "// login v1\npublic class LoginController {}\n" },
      { path: "src/ShopApp.Api/Controllers/UserController.cs", content: "// users\npublic class UserController {}\n" },
      { path: "README.md", content: "# shop\n" },
      { path: "CodeVia/project.md", content: "# manifest\n" },
    ],
  });
  return gh;
}

describe("buildContextPack", () => {
  it("reads tree, manifests, siblings and entity matches", async () => {
    const gh = seedCodeRepo();
    const pack = await buildContextPack({
      github: gh,
      project: project(),
      target: "src/ShopApp.Api/Controllers/RegisterController.cs",
      entityRoute: "register",
    });
    expect(pack.totalFiles).toBe(5);
    // CodeVia/ internals are not project architecture.
    expect(pack.tree.some((p) => p.startsWith("CodeVia/"))).toBe(false);
    expect(pack.stack.backend).toBe("node-ts"); // no selections → defaults
    expect(pack.configs.map((c) => c.path)).toContain("src/ShopApp.Api/ShopApp.Api.csproj");
    // Sibling controller is the convention source for a new controller…
    expect(pack.related.map((c) => c.path)).toContain("src/ShopApp.Api/Controllers/LoginController.cs");
    expect(pack.related.map((c) => c.path)).toContain("src/ShopApp.Api/Controllers/UserController.cs");
  });

  it("finds entity-matching files even outside the target directory", async () => {
    const gh = seedCodeRepo();
    const pack = await buildContextPack({
      github: gh,
      project: project(),
      target: "src/ShopApp.Api/Services/RegisterService.cs",
      entityRoute: "login",
    });
    expect(pack.related.map((c) => c.path)).toContain("src/ShopApp.Api/Controllers/LoginController.cs");
  });

  it("carries recent memory and the persisted registry", async () => {
    const fx = freshDb();
    try {
      const container = new Container();
      await container.ensureSeed();
      const p = await container.agentManager.createProject({ name: "M", description: "d", configRepo: "acme/mem" });
      container.memoryRepo.upsert(
        {
          id: "mem-1", projectId: p.id, scope: "project", type: "decision", key: "auth.strategy",
          content: "Use JWT everywhere", tags: [], refs: [], source: "test", version: 1,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        { projectId: p.id, key: "auth.strategy" },
      );
      const gh = container.github as unknown as MockGitHubService;
      await gh.commit({ owner: "acme", name: "mem" }, "main", "ctx", [
        {
          path: CONTEXT_FILE,
          content: `---\nregistry: {"Login":{"entity":"Login","path":"src/Login.cs","agentType":"backend-developer","subtaskId":"task-1","at":"t"}}\n---\n\n# ctx\n`,
        },
      ]);
      const pack = await buildContextPack({ github: container.github, project: p, memoryRepo: container.memoryRepo });
      expect(pack.memory.map((m) => m.key)).toContain("auth.strategy");
      expect(pack.registry.Login?.path).toBe("src/Login.cs");
    } finally {
      fx.cleanup();
    }
  });

  it("survives repos and failures with an empty pack", async () => {
    const gh = new MockGitHubService({ seedDemoRepos: false });
    const pack = await buildContextPack({ github: gh, project: project({ configRepo: "no/such" }) });
    expect(pack.tree).toEqual([]);
    expect(pack.related).toEqual([]);
  });
});

describe("registry round-trip", () => {
  it("renders, parses and merges the entity registry", () => {
    const p = project();
    const md = renderContextMarkdown(p, {
      tree: ["a.ts"], totalFiles: 1,
      stack: { backend: "node-ts", frontend: "react", project: "ShopApp", pkg: "shopapp" },
      stackSummary: "backend node-ts · frontend react · project ShopApp",
      configs: [], related: [], memory: [],
      registry: { Login: { entity: "Login", path: "src/login.ts", agentType: "backend-developer", subtaskId: "task-1", at: "t" } },
    });
    expect(md).toContain("src/login.ts");
    expect(md).toContain("Stack: backend node-ts");
    expect(parseRegistry(md).Login?.path).toBe("src/login.ts");
    const merged = mergeRegistry(parseRegistry(md), [
      { entity: "Payment", path: "src/pay.ts", agentType: "backend-developer", subtaskId: "task-2", at: "t2" },
    ]);
    expect(Object.keys(merged).sort()).toEqual(["Login", "Payment"]);
    // Re-claiming an entity updates it in place (no duplicates).
    const again = mergeRegistry(merged, [
      { entity: "Login", path: "src/login2.ts", agentType: "backend-developer", subtaskId: "task-3", at: "t3" },
    ]);
    expect(again.Login.path).toBe("src/login2.ts");
  });
});

describe("renderPromptContext", () => {
  it("tells real AI to extend and never duplicate", () => {
    const out = renderPromptContext(
      {
        tree: ["src/a.ts"], totalFiles: 1,
        stack: { backend: "node-ts", frontend: "react", project: "A", pkg: "a" },
        stackSummary: "s",
        configs: [{ path: "package.json", content: "{}" }],
        related: [{ path: "src/a.ts", content: "code" }],
        memory: [{ key: "k", type: "decision", content: "c" }],
        registry: { Login: { entity: "Login", path: "src/a.ts", agentType: "b", subtaskId: "t", at: "t" } },
      },
      "src/a.ts",
    );
    expect(out).toContain("EXTEND");
    expect(out).toContain("never duplicate");
    expect(out).toContain("src/a.ts");
  });
});

describe("extendContent", () => {
  const base = {
    agentName: "Backend Developer", agentType: "backend-developer" as const,
    taskTitle: "Add login rate limiting", subtaskId: "task-new", todos: ["Throttle attempts per IP"],
  };
  it("preserves C# code and adds //-comment TODOs", () => {
    const out = extendContent({ ...base, existing: "public class LoginController {}\n", path: "src/LoginController.cs" });
    expect(out).toContain("public class LoginController {}");
    expect(out).toContain("task-new");
    expect(out).toContain("Existing implementation preserved");
    expect(out).toContain("// TODO (task-new): Add login rate limiting");
  });
  it("uses # comments for python and -- for sql", () => {
    expect(extendContent({ ...base, existing: "x = 1\n", path: "a.py" })).toContain("# TODO (task-new)");
    expect(extendContent({ ...base, existing: "SELECT 1\n", path: "m.sql" })).toContain("-- TODO (task-new)");
  });
  it("uses block comments for vue/svelte", () => {
    const out = extendContent({ ...base, existing: "<template>x</template>\n", path: "AView.vue" });
    expect(out).toContain("<!--");
    expect(out).toContain("<template>x</template>");
  });
});

describe("continuity end-to-end (mock AI + mock GitHub)", () => {
  let fx: ReturnType<typeof freshDb>;
  let container: Container;

  beforeEach(async () => {
    fx = freshDb();
    container = new Container();
    await container.ensureSeed();
  });
  afterEach(() => fx.cleanup());

  it("second task on the same entity extends merged work instead of overwriting", async () => {
    const p = await container.agentManager.createProject({
      name: "Shop App", description: "d", configRepo: "acme/shop",
      capabilities: { languages: ["csharp"], frameworks: ["dotnet"] } as Project["capabilities"],
    });
    const gh = container.github as unknown as MockGitHubService;
    const ref = { owner: "acme", name: "shop" };

    // Task 1: login API → scaffold on its branch.
    const t1 = container.agentManager.createTask({
      projectId: p.id, title: "Add login API", description: "Session endpoint", input: { executionMode: "autonomous" },
    });
    expect((await container.agentManager.runTask(t1.id)).status).toBe("succeeded");
    const kids1 = container.taskRepo.findMany({ parentId: t1.id }).map((k) => k.data);
    const be1 = kids1.find((k) => k.agentType === "backend-developer")!;
    const target = "src/ShopApp.Api/Controllers/LoginController.cs";
    const pr1 = (await gh.listPullRequests(ref)).find((x) => x.head === `agent-task-${t1.id.replace(/^task-/, "")}`)!;
    const v1 = (await gh.getFile(ref, target, pr1.head))?.content ?? "";
    expect(v1).toContain("class LoginController");
    expect(v1).toContain(be1.id);

    // Merge to main (human review step), then a follow-up on the same entity.
    await gh.mergePullRequest(ref, pr1.number);
    expect((await gh.getFile(ref, target, "main"))?.content).toContain(be1.id);

    const t2 = container.agentManager.createTask({
      projectId: p.id, title: "Add login rate limiting", description: "Throttle login attempts per IP",
      input: { executionMode: "autonomous" },
    });
    expect((await container.agentManager.runTask(t2.id)).status).toBe("succeeded");
    const kids2 = container.taskRepo.findMany({ parentId: t2.id }).map((k) => k.data);
    const be2 = kids2.find((k) => k.agentType === "backend-developer")!;
    const pr2 = (await gh.listPullRequests(ref)).find((x) => x.head === `agent-task-${t2.id.replace(/^task-/, "")}`)!;
    const v2 = (await gh.getFile(ref, target, pr2.head))?.content ?? "";

    // Prior work preserved, new subtask appended as TODOs — not a rewrite.
    expect(v2).toContain(be1.id);
    expect(v2).toContain(be2.id);
    expect(v2).toContain("Existing implementation preserved");
    expect(v2).toContain("Throttle");

    // The context file tracks the architecture + entity ownership.
    const ctx = (await gh.getFile(ref, CONTEXT_FILE, "main"))?.content ?? "";
    expect(ctx).toContain("Login");
    expect(ctx).toContain(target);
    expect(parseRegistry(ctx).Login?.path).toBe(target);
  }, 90000);

  it("syncProjectContext is a best-effort no-op without a folder service", async () => {
    const gh = new MockGitHubService({ seedDemoRepos: false });
    await expect(syncProjectContext({ files: undefined, github: gh, project: project() })).resolves.toBe(false);
  });
});
