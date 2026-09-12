import { describe, it, expect } from "vitest";
import type { Project, Task } from "../domain/entities.js";
import { detectStack, entityFor, scaffoldFor, notePathFor, changeNote } from "../agents/scaffold.js";
import { deterministicBreakdown } from "../agents/orchestrator.js";

const project = (capabilities: Record<string, string[]> = {}, name = "Shop App"): Project =>
  ({ name, capabilities }) as unknown as Project;
const task = (title: string, description = ""): Task => ({ id: "t1", title, description }) as Task;

describe("detectStack", () => {
  it("detects dotnet/csharp backend", () => {
    const s = detectStack(project({ languages: ["csharp"], frameworks: ["dotnet"] }));
    expect(s.backend).toBe("csharp");
  });
  it("detects python/fastapi backend", () => {
    const s = detectStack(project({ languages: ["python"], frameworks: ["fastapi"] }));
    expect(s.backend).toBe("python");
  });
  it("detects vue frontend", () => {
    const s = detectStack(project({ languages: ["typescript"], frameworks: ["vue"] }));
    expect(s.frontend).toBe("vue");
  });
  it("falls back to node-ts + react with no selections", () => {
    const s = detectStack(project({}));
    expect(s.backend).toBe("node-ts");
    expect(s.frontend).toBe("react");
  });
  it("keeps the project stem ASCII for namespaces", () => {
    const s = detectStack(project({}, "فروشگاه من"));
    expect(s.project).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe("entityFor", () => {
  it("maps auth work to Login", () => {
    expect(entityFor("Add login page and API").pascal).toBe("Login");
  });
  it("maps billing work to Payment", () => {
    expect(entityFor("Stripe checkout for payments", "billing flow").pascal).toBe("Checkout");
  });
  it("maps profile work to User", () => {
    expect(entityFor("Edit user profile").pascal).toBe("User");
  });
  it("falls back to the first meaningful word", () => {
    expect(entityFor("Add telemetry exporter").pascal).toBe("Telemetry");
  });
  it("stays ASCII for Persian-only requests", () => {
    const e = entityFor("راست‌چین کردن صفحه", "ظاهر موبایل");
    expect(e.pascal).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe("scaffoldFor", () => {
  const brief = 'Research brief for "Add login page and API"\nRequirements:\n- login';
  it("writes a valid C# controller for dotnet projects", () => {
    const sc = scaffoldFor({
      agentType: "backend-developer",
      project: project({ languages: ["csharp"], frameworks: ["dotnet"] }, "Shop App"),
      task: task("Add login page and API"),
      childId: "task-abc",
      brief,
    })!;
    expect(sc.path).toBe("src/ShopApp.Api/Controllers/LoginController.cs");
    expect(sc.content).toContain("public class LoginController : ControllerBase");
    expect(sc.content).toContain("[HttpGet]");
    expect(sc.content).toContain("[HttpPost]");
    expect(sc.content).toContain("TODO");
    expect(sc.content).toContain("subtask task-abc");
  });
  it("writes an express routes module for node projects", () => {
    const sc = scaffoldFor({
      agentType: "backend-developer",
      project: project({ languages: ["typescript"], frameworks: ["express"] }),
      task: task("Add login API"),
      childId: "task-abc",
      brief,
    })!;
    expect(sc.path).toBe("src/routes/login.routes.ts");
    expect(sc.content).toContain("loginRouter.get(");
    expect(sc.content).toContain("loginRouter.post(");
  });
  it("writes a React page for react projects", () => {
    const sc = scaffoldFor({
      agentType: "frontend-developer",
      project: project({ languages: ["typescript"], frameworks: ["react"] }),
      task: task("Add login page"),
      childId: "task-abc",
      brief,
    })!;
    expect(sc.path).toBe("src/pages/LoginPage.tsx");
    expect(sc.content).toContain("export default function LoginPage()");
    expect(sc.content).toContain("POST /api/login");
  });
  it("writes a migration for database work", () => {
    const sc = scaffoldFor({
      agentType: "database",
      project: project({ databases: ["sqlserver"] }),
      task: task("Add user sessions table migration"),
      childId: "task-abc",
      brief,
    })!;
    expect(sc.path).toMatch(/^db\/migrations\/\d{8}_user\.sql$/);
    expect(sc.content).toContain("CREATE TABLE IF NOT EXISTS");
  });
  it("returns undefined for non-implementers", () => {
    expect(
      scaffoldFor({ agentType: "research", project: project({}), task: task("x"), childId: "c", brief: "" }),
    ).toBeUndefined();
  });
  it("embeds QA fix context when provided", () => {
    const sc = scaffoldFor({
      agentType: "backend-developer",
      project: project({}),
      task: task("Add login API"),
      childId: "task-abc",
      brief,
      fixContext: "POST returns 500",
    })!;
    expect(sc.content).toContain("POST returns 500");
  });
});

describe("deterministicBreakdown with scaffolds", () => {
  it("targets the scaffold first and the note second", () => {
    const items = deterministicBreakdown(
      project({ languages: ["csharp"], frameworks: ["dotnet", "react"] }),
      task("Add login page and API"),
    );
    const be = items.find((i) => i.agentType === "backend-developer")!;
    expect(be.files[0]).toBe("src/ShopApp.Api/Controllers/LoginController.cs");
    expect(be.files[1]).toBe(notePathFor("t1", "backend", "add-login-page-and-api"));
    const fe = items.find((i) => i.agentType === "frontend-developer")!;
    expect(fe.files[0]).toBe("src/pages/LoginPage.tsx");
    expect(fe.files[1].startsWith("docs/tasks/")).toBe(true);
  });
});

describe("changeNote", () => {
  it("keeps request + brief + subtask id", () => {
    const note = changeNote("Backend Developer", task("Implement x") as Task, "do x", "brief body");
    expect(note).toContain("do x");
    expect(note).toContain("brief body");
    expect(note).toContain("t1");
  });
});
