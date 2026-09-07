import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentType, Project, Skill } from "../domain/entities.js";
import { normalizeCapabilities } from "../domain/project-options.js";
import { scaffoldFor } from "../agents/generator.js";
import { BUILTIN_SKILLS } from "../skills/catalog.js";
import { availableSkills, compileAssignedSkills, resolveSkillDependencies, selectTaskSkills } from "../skills/assignment.js";
import { Container } from "../app/container.js";
import { freshDb } from "./test-helpers.js";

const project = (capabilities: Parameters<typeof normalizeCapabilities>[0] = { languages: ["typescript"], frameworks: ["react", "fastify"], databases: ["postgresql"] }): Project => ({
  id: "p", name: "Shop", slug: "shop", description: "Store", configRepo: "acme/shop", branch: "main", repositories: [],
  capabilities: normalizeCapabilities(capabilities),
  settings: { environment: "development", skills: [], rules: [], workflows: [], notifications: [], metadata: {}, permissions: {} as never, budget: { maxCallsPerRun: 20, maxTokensPerRun: 20000, maxDurationMs: 120000, maxCostUsdPerRun: 5 } },
  active: true, createdAt: "", updatedAt: "",
});
const agent = (type: AgentType) => ({ type, name: type, skills: [...scaffoldFor(type).skills] });
const custom = (slug: string, extra: Partial<Skill> = {}): Skill => ({
  id: `s-${slug}`, slug, name: slug, description: "Custom project convention", category: "general", instructions: `BASE_${slug}`,
  dependencies: [], compatibleAgentTypes: [], tools: ["ungranted-tool"], metadata: {}, version: "2.0", enabled: true, builtIn: false, createdAt: "", updatedAt: "", ...extra,
});

describe("task-scoped skill selection", () => {
  it("filters legacy mixed-stack defaults by the project and specialist responsibility", () => {
    const p = project();
    const backend = selectTaskSkills(BUILTIN_SKILLS, p, agent("backend-developer"));
    const frontend = selectTaskSkills(BUILTIN_SKILLS, p, agent("frontend-developer"));
    const database = selectTaskSkills(BUILTIN_SKILLS, p, agent("database"));
    expect(backend.skills).toEqual(expect.arrayContaining(["nodejs", "typescript", "restapi", "postgresql"]));
    expect(frontend.skills).toEqual(expect.arrayContaining(["react", "typescript", "ui-design"]));
    expect(frontend.skills).not.toContain("postgresql");
    expect(database.skills).toContain("postgresql");
    for (const selection of [backend, frontend, database]) {
      expect(selection.assignments.map((s) => s.slug)).not.toEqual(expect.arrayContaining(["dotnet"]));
      for (const slug of ["csharp", "sqlserver", "blazor"]) expect(selection.assignments.map((s) => s.slug)).not.toContain(slug);
    }
  });

  it("does not turn a TypeScript frontend into an unrelated Node backend", () => {
    const p = project({ platforms: ["web"], languages: ["csharp", "typescript"], frameworks: ["dotnet", "react"], databases: ["sqlserver"] });
    const backend = selectTaskSkills(BUILTIN_SKILLS, p, agent("backend-developer"));
    const frontend = selectTaskSkills(BUILTIN_SKILLS, p, agent("frontend-developer"));
    expect(backend.skills).toContain("dotnet");
    expect(backend.skills).not.toContain("nodejs");
    expect(backend.skills).not.toContain("typescript");
    expect(frontend.skills).toEqual(expect.arrayContaining(["react", "typescript"]));
    expect(frontend.skills).not.toContain("blazor");
  });

  it("injects attached project skills only into compatible agents", () => {
    const p = project();
    p.settings.skills = ["design-kit"];
    const catalog = [...BUILTIN_SKILLS, custom("design-kit", { compatibleAgentTypes: ["frontend-developer"], dependencies: ["css"] })];
    const ui = selectTaskSkills(catalog, p, agent("frontend-developer"), { title: "Accessible login form", description: "UI duty", input: {} });
    const backend = selectTaskSkills(catalog, p, agent("backend-developer"));
    expect(ui.skills).toContain("design-kit");
    expect(ui.assignments.find((s) => s.slug === "css")?.source).toBe("dependency");
    expect(compileAssignedSkills(ui.assignments)).toContain("BASE_design-kit");
    expect(backend.skills).not.toContain("design-kit");
  });

  it("resolves transitive knowledge once, without imposing a different stack", () => {
    const p = project({ languages: ["csharp"], frameworks: ["blazor"] });
    const selection = selectTaskSkills(BUILTIN_SKILLS, p, agent("frontend-developer"), { title: "Form", description: "", input: { skills: ["blazor", "ui-design"] } });
    expect(selection.assignments.map((s) => s.slug)).toEqual(["csharp", "dotnet", "ui-design", "blazor"]);
    expect(selection.assignments.map((s) => s.slug)).not.toContain("aspnetcore");
    // JavaScript React and SQL Server are not inherently TypeScript/.NET.
    expect(resolveSkillDependencies(BUILTIN_SKILLS, ["react", "nodejs", "sqlserver"]).map((s) => s.slug)).toEqual(["react", "nodejs", "sqlserver"]);
  });

  it("adapts instructions independently per duty without mutating the catalog or agent", () => {
    const p = project();
    const a = agent("backend-developer");
    const before = JSON.stringify({ catalog: BUILTIN_SKILLS, agent: a });
    const select = (title: string, guidance: string) => selectTaskSkills(BUILTIN_SKILLS, p, a, {
      title, description: "Server work", input: { files: ["src/auth.ts"], skills: ["security"], skillInstructions: { security: guidance } },
    });
    const login = select("Login endpoint", "Validate login inputs and reject expired sessions.");
    const webhook = select("Webhook endpoint", "Validate the signature before accepting payment events.");
    expect(compileAssignedSkills(login.assignments)).toContain("Validate login inputs");
    expect(compileAssignedSkills(webhook.assignments)).toContain("Validate the signature");
    expect(compileAssignedSkills(webhook.assignments)).not.toContain("Validate login inputs");
    expect(login.assignments[0].instructions).toBe(BUILTIN_SKILLS.find((s) => s.slug === "security")!.instructions);
    expect(login.assignments[0].guidance).toContain("src/auth.ts");
    expect(JSON.stringify({ catalog: BUILTIN_SKILLS, agent: a })).toBe(before);
  });

  it("re-evaluates repair guidance and adds compatible testing knowledge", () => {
    const fix = selectTaskSkills(BUILTIN_SKILLS, project(), agent("backend-developer"), {
      title: "Repair session expiry", description: "Server fix", input: { skills: ["restapi"], fixContext: "src/auth.ts: expected 401, got 200" },
    });
    expect(fix.skills).toEqual(["restapi", "testing"]);
    expect(fix.assignments.every((s) => s.guidance.includes("expected 401, got 200"))).toBe(true);
  });

  it("ignores disabled automatic roots but rejects explicit unavailable, incompatible or wrong-stack selections", () => {
    const catalog = BUILTIN_SKILLS.map((s) => s.slug === "testing" ? { ...s, enabled: false } : s);
    const p = project();
    const a = agent("frontend-developer");
    expect(selectTaskSkills(catalog, p, a).skills).not.toContain("testing");
    for (const slug of ["testing", "missing", "postgresql", "blazor"]) {
      expect(() => selectTaskSkills(catalog, p, a, { title: "T", description: "", input: { skills: [slug] } })).toThrow(/unavailable|incompatible/);
    }
    expect(availableSkills(catalog, p, a).some((s) => s.slug === "blazor")).toBe(false);
  });

  it("rejects malformed skill assignments and guidance for unassigned skills", () => {
    for (const input of [
      { skills: "security" }, { skills: ["security", "security"] }, { skills: ["../invalid"] },
      { skills: ["security"], skillInstructions: { unknown: "Do something" } },
      { skills: ["security"], skillInstructions: { security: "x".repeat(1201) } },
      { skillInstructions: [] },
    ]) expect(() => selectTaskSkills(BUILTIN_SKILLS, project(), agent("backend-developer"), { title: "T", description: "", input })).toThrow();
  });

  it("fails clearly on missing/disabled prerequisites and dependency cycles", () => {
    expect(() => resolveSkillDependencies([custom("a", { dependencies: ["missing"] })], ["a"])).toThrow(/missing or disabled/);
    expect(() => resolveSkillDependencies([custom("a", { dependencies: ["b"] }), custom("b", { enabled: false })], ["a"])).toThrow(/missing or disabled/);
    expect(() => resolveSkillDependencies([custom("a", { dependencies: ["b"] }), custom("b", { dependencies: ["a"] })], ["a"])).toThrow(/Circular/);
  });
});

describe("skill persistence and onboarding", () => {
  let fx: ReturnType<typeof freshDb>;
  let c: Container;
  beforeEach(async () => { fx = freshDb(); c = new Container(); await c.ensureSeed(); });
  afterEach(() => fx.cleanup());

  it("indexes new custom skills by slug and keeps old unindexed skills resolvable", () => {
    const { id: _id, createdAt: _created, updatedAt: _updated, ...data } = custom("company-api");
    const skill = c.skillRepo.create(data);
    expect(c.skillRepo.findBySlug(skill.slug)?.id).toBe(skill.id);
    expect(c.skillRepo.findMany({ key: skill.slug })).toHaveLength(1);
    c.skillRepo.upsert(custom("legacy-unindexed"));
    expect(c.skillRepo.findBySlug("legacy-unindexed")?.name).toBe("legacy-unindexed");
    expect(() => c.skillRepo.create(data)).toThrow(/already exists/);
  });

  it("does not re-enable a disabled built-in when its catalog version is upgraded", () => {
    const skill = c.skillRepo.findBySlug("dotnet")!;
    c.skillRepo.upsert({ ...skill, version: "0.1", enabled: false }, { key: skill.slug });
    c.skillRepo.seedBuiltIns();
    expect(c.skillRepo.findBySlug("dotnet")).toMatchObject({ enabled: false, version: "1.1.0" });
  });

  it("generates stack-specific defaults and preserves manual project/agent skill choices on re-onboard", async () => {
    const p = await c.agentManager.createProject({ name: "Skill Profile", description: "Store", configRepo: "acme/skill-profile", capabilities: { platforms: ["web"], languages: ["csharp"], frameworks: ["blazor"], databases: ["oracle"] } });
    const ui = c.agentRepo.byType(p.id, "frontend-developer")!;
    expect(ui.skills).toContain("blazor");
    expect(ui.skills).not.toContain("react");
    expect(c.agentRepo.byType(p.id, "database")!.skills).toContain("oracle");
    c.skillRepo.upsert(custom("manual-project"), { key: "manual-project" });
    c.skillRepo.upsert(custom("manual-agent"), { key: "manual-agent" });
    c.projectRepo.upsert({ ...p, settings: { ...p.settings, skills: [...p.settings.skills, "manual-project"] } }, { key: p.slug });
    c.agentRepo.upsert({ ...ui, skills: [...ui.skills.filter((s) => s !== "testing"), "manual-agent"] }, { projectId: p.id });
    await c.agentManager.syncProjectState(p.id);
    await c.agentManager.onboardProject(p.id);
    const next = c.agentRepo.byType(p.id, "frontend-developer")!;
    expect(c.projectRepo.findById(p.id)!.data.settings.skills).toContain("manual-project");
    expect(next.skills).toContain("manual-agent");
    // Project skill attachments apply at selection time, without rewriting agent defaults.
    expect(c.skillsRegistry.forTask(c.projectRepo.findById(p.id)!.data, next).skills).toContain("manual-project");
    expect(next.skills).not.toContain("testing");
    expect(next.generatedSkills).toContain("blazor");
    await c.projectFiles.restore(p, { projectRepo: c.projectRepo, taskRepo: c.taskRepo, agentRepo: c.agentRepo, memoryRepo: c.memoryRepo }, { includeTasks: false });
    expect(c.agentRepo.byType(p.id, "frontend-developer")!.generatedSkills).toEqual(next.generatedSkills);
  });
});
