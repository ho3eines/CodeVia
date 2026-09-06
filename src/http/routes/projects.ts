import type { FastifyInstance, FastifyReply } from "fastify";
import type { Container } from "../../app/container.js";
import type { AgentType, Project, ProjectGithubConnection, ProjectRepositoryLink } from "../../domain/entities.js";
import { skillsForCapabilities } from "../../domain/project-options.js";
import {
  configRepoOf,
  getProjectOptionCatalog,
  hydrateProject,
  isValidRepoFullName,
  legacyFieldsFromCapabilities,
  normalizeCapabilities,
  normalizeRepositories,
} from "../../domain/project-options.js";
import { parseRepoFullName } from "../../github/types.js";
import { resolveGitHubForUser } from "../../github/registry.js";
import { resolveRequestUser } from "../auth.js";
import { describeUserGitHubToken } from "../../auth/github-tokens.js";
import { DISCOVERED_RULE_TAG } from "../../agents/manager.js";
import { defaultPlanFor } from "../../agents/plan.js";

function fail(reply: FastifyReply, status: number, message: string, extra: Record<string, unknown> = {}): { error: string } {
  reply.code(status);
  return { error: message, ...extra };
}

function errStatus(err: unknown): number {
  const s = (err as { statusCode?: number } | undefined)?.statusCode;
  return typeof s === "number" && s >= 400 && s < 600 ? s : 500;
}

export function registerProjectRoutes(app: FastifyInstance, container: Container): void {
  /** Read a project, upgraded to the current document shape. */
  const load = (id: string): Project | undefined => {
    const r = container.projectRepo.findById(id);
    return r ? hydrateProject(r.data) : undefined;
  };
  const save = (p: Project): Project => {
    const next = hydrateProject({ ...p, updatedAt: new Date().toISOString() });
    container.projectRepo.upsert(next, { key: next.slug });
    return next;
  };

  // Option catalog for the multi-select project form (platforms, languages, …).
  app.get("/projects/options", { schema: { tags: ["projects"] } }, async () => {
    return getProjectOptionCatalog();
  });

  // List projects — yours, plus shared/unowned ones (seed data and single-user
  // installs carry no owner, so nothing disappears when auth is enabled).
  app.get("/projects", { schema: { tags: ["projects"] } }, async (req) => {
    const { user } = resolveRequestUser(req, container);
    return container.projectRepo
      .findMany()
      .map((r) => hydrateProject(r.data))
      .filter((p) => !p.ownerId || p.ownerId === user.id);
  });

  // Create project + auto-onboard (Agent Generator / Skills / Workflow / Rules)
  app.post("/projects", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    if (!name) return fail(reply, 400, "Project name is required");
    const repositories = normalizeRepositories(body.repositories, {
      repo: typeof body.configRepo === "string" ? body.configRepo : undefined,
      branch: typeof body.branch === "string" ? body.branch : undefined,
    });
    if (repositories.length === 0) {
      const given = typeof body.configRepo === "string" ? body.configRepo.trim() : "";
      return fail(
        reply,
        400,
        given
          ? `Invalid repository "${given}" — expected owner/name`
          : "Select at least one GitHub repository (owner/name) for the project",
      );
    }
    const { user, authenticated } = resolveRequestUser(req, container);
    const ownerId = user.id;
    const resolved = resolveGitHubForUser({ kv: container.kv, userId: user.id, authenticated, fallback: container.github });
    const tokenInfo = resolved.source === "user-oauth" ? describeUserGitHubToken(container.kv, user.id) : undefined;
    const githubConnection: ProjectGithubConnection = {
      kind: resolved.source,
      userId: resolved.source === "user-oauth" ? user.id : undefined,
      login: tokenInfo?.login,
    };
    try {
      let project = await container.agentManager.createProject({
        ownerId,
        name,
        slug: typeof body.slug === "string" && body.slug.trim() ? body.slug.trim() : undefined,
        description: String(body.description ?? ""),
        repositories,
        capabilities: (body.capabilities as Record<string, unknown> | undefined) ?? {
          platforms: body.platforms,
          languages: body.languages,
          frameworks: body.frameworks,
          databases: body.databases,
          deploymentTargets: body.deploymentTargets,
          features: body.features,
          integrations: body.integrations,
          agentTypes: body.agentTypes,
        },
        githubConnection,
        primaryLanguage: body.primaryLanguage as string | undefined,
        framework: body.framework as string | undefined,
        database: body.database as string | undefined,
        deploymentTarget: body.deploymentTarget as string | undefined,
        defaultModelId: body.defaultModelId as string | undefined,
        tech: Array.isArray(body.tech) ? (body.tech as string[]) : [],
      });

      // Compute skills from the selected capabilities
      const skills = skillsForCapabilities(project.capabilities);

      // Attach skills to the project settings
      project.settings = {
        ...project.settings,
        skills: skills ?? [],
      };

      // Persist the updated project (including skills)
      const updated = save({ ...project, id: project.id });
      project = updated;

      const agents = container.agentRepo.byProject(project.id).filter((a) => a.enabled).length;
      reply.code(201);
      return { ...project, agents };
    } catch (err) {
      return fail(reply, errStatus(err), err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/projects/:id", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = load(id);
    if (!p) return fail(reply, 404, "project not found");
    return p;
  });

  app.patch("/projects/:id", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = load(id);
    if (!p) return fail(reply, 404, "project not found");
    const patch: Partial<Project> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.description === "string") patch.description = body.description;
    if (typeof body.defaultModelId === "string") patch.defaultModelId = body.defaultModelId || undefined;
    if (typeof body.telegramChatId === "string") patch.telegramChatId = body.telegramChatId || undefined;
    if (typeof body.active === "boolean") patch.active = body.active;
    if (body.settings && typeof body.settings === "object") patch.settings = { ...p.settings, ...(body.settings as Partial<Project["settings"]>) };
    if (body.capabilities && typeof body.capabilities === "object") {
      patch.capabilities = normalizeCapabilities({ ...p.capabilities, ...(body.capabilities as Record<string, unknown>) });
      Object.assign(patch, legacyFieldsFromCapabilities(patch.capabilities));
    }
    if (Array.isArray(body.repositories)) {
      const repos = normalizeRepositories(body.repositories);
      if (repos.length === 0) return fail(reply, 400, "A project needs at least one repository");
      patch.repositories = repos;
    } else if (typeof body.configRepo === "string" || typeof body.branch === "string") {
      // Legacy single-repo update: rewrite the config repo link.
      const repo = typeof body.configRepo === "string" ? body.configRepo.trim() : p.configRepo;
      if (!isValidRepoFullName(repo)) return fail(reply, 400, `Invalid repository "${repo}" — expected owner/name`);
      const branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : p.branch;
      const cfg = configRepoOf(p.repositories);
      patch.repositories = p.repositories.map((r) => (r === cfg ? { ...r, repo, branch } : r));
    }
    const updated = save({ ...p, ...patch, id });
    // Capability edits normally refresh generated agents/prompts, but UI callers
    // can explicitly send reonboard:false when they are only saving metadata or
    // want to stage stack changes before regenerating the roster.
    const rerun = body.reonboard === true || (body.reonboard !== false && patch.capabilities !== undefined);
    if (rerun) await container.agentManager.onboardProject(id, []);
    return load(id) ?? updated;
  });

  app.post("/projects/:id/activate", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = load(id);
    if (!p) return fail(reply, 404, "project not found");
    return save({ ...p, active: true });
  });

  app.post("/projects/:id/deactivate", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = load(id);
    if (!p) return fail(reply, 404, "project not found");
    return save({ ...p, active: false });
  });

  app.delete("/projects/:id", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    container.projectRepo.deleteById(id);
    return { ok: true };
  });

  // Sub-resources
  app.get("/projects/:id/agents", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.agentRepo.byProject(id);
  });

  app.get("/projects/:id/skills", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const p = load(id);
    if (!p) return [];
    return p.settings.skills;
  });

  app.get("/projects/:id/memory", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.memoryRepo.byProject(id);
  });

  app.get("/projects/:id/workflows", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.workflowRepo.byProject(id);
  });

  app.get("/projects/:id/tasks", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.taskRepo.byProject(id);
  });

  app.get("/projects/:id/runs", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.runRepo.byProject(id);
  });

  app.get("/projects/:id/tests", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.runRepo.byProject(id).filter((r) => r.agentType === "qa-test");
  });

  /** GitHub service for a project: the linking user's token when available, else the platform default. */
  const githubForProject = (req: Parameters<typeof resolveRequestUser>[0], p: Project) => {
    const { user, authenticated } = resolveRequestUser(req, container);
    const userId = p.githubConnection?.kind === "user-oauth" ? p.githubConnection.userId ?? user.id : user.id;
    return resolveGitHubForUser({ kv: container.kv, userId, authenticated: authenticated || !!p.githubConnection?.userId, fallback: container.github }).service;
  };

  app.get("/projects/:id/issues", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const p = load(id);
    if (!p) return [];
    const q = req.query as { repo?: string };
    const gh = githubForProject(req, p);
    const targets = q.repo ? p.repositories.filter((r) => r.repo === q.repo) : p.repositories;
    const out: Array<{ repo: string; number: number; title: string; state: string; htmlUrl: string }> = [];
    for (const link of targets) {
      const ref = parseRepoFullName(link.repo);
      if (!ref) continue;
      try {
        for (const i of await gh.listIssues(ref)) out.push({ repo: link.repo, ...i });
      } catch {
        /* one repo failing must not hide the others */
      }
    }
    return out;
  });

  app.get("/projects/:id/pull-requests", { schema: { tags: ["projects"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const p = load(id);
    if (!p) return [];
    const q = req.query as { repo?: string };
    const gh = githubForProject(req, p);
    const targets = q.repo ? p.repositories.filter((r) => r.repo === q.repo) : p.repositories;
    const out: Array<Record<string, unknown>> = [];
    for (const link of targets) {
      const ref = parseRepoFullName(link.repo);
      if (!ref) continue;
      try {
        for (const pr of await gh.listPullRequests(ref)) out.push({ repo: link.repo, ...pr });
      } catch {
        /* ignore per-repo failures */
      }
    }
    return out;
  });

  const workflowForIntent = (projectId: string, text: string): string | undefined => {
    const workflows = container.workflowRepo.byProject(projectId).filter((w) => w.enabled);
    const lower = text.toLowerCase();
    const bugLike = /bug|fix|error|failing|test|login|debug|خطا|ارور|باگ|خراب|رفع|دیباگ|تست|لاگین|ورود/.test(lower);
    const wanted = bugLike ? "bug-diagnosis-loop" : "autonomous-development-loop";
    return workflows.find((w) => w.slug === wanted)?.id ?? workflows[0]?.id;
  };

  // Natural-language AI action on a project (routed through Agent Manager)
  app.post("/projects/:id/ask", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const project = load(id);
    if (!project) return fail(reply, 404, "project not found");
    const title = String(body.title ?? "AI request");
    const description = String(body.description ?? body.prompt ?? title);
    const executionMode = body.executionMode === "agent" || body.executionMode === "simulation" ? body.executionMode : "workflow";
    const routedAgentType = (body.agentType as AgentType | undefined) ?? container.agentRouter.route(`${title} ${description}`);
    const workflowId = typeof body.workflowId === "string" && body.workflowId
      ? body.workflowId
      : executionMode === "workflow"
        ? workflowForIntent(id, `${title} ${description}`)
        : undefined;
    if (executionMode === "simulation") {
      const agent = container.agentRepo.byType(id, routedAgentType);
      const plan = agent ? defaultPlanFor(agent, {
        id: "simulation",
        projectId: id,
        title,
        description,
        status: "created",
        agentType: routedAgentType,
        correlationId: "simulation",
        input: body.input as Record<string, unknown> | undefined ?? {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) : [];
      return { simulation: true, projectId: id, routedAgentType, workflowId, plan: plan.map((s) => ({ label: s.label, tool: s.tool, requiresApproval: s.requiresApproval })) };
    }
    const task = container.agentManager.createTask({
      projectId: id,
      title,
      description,
      agentType: workflowId ? undefined : routedAgentType,
      workflowId,
      input: { ...(body.input as Record<string, unknown> | undefined ?? {}), routedAgentType, executionMode },
    });
    const job = container.queue.enqueue("agent.run", { taskId: task.id }, { correlationId: task.correlationId });
    return { task, jobId: job.id, routedAgentType, workflowId, executionMode };
  });

  // Re-run onboarding
  app.post("/projects/:id/onboard", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!load(id)) return fail(reply, 404, "project not found");
    return container.agentManager.onboardProject(id, Array.isArray(body.tech) ? (body.tech as string[]) : []);
  });

  // ---- Project rules (discovered + manual) ----
  app.get("/projects/:id/rules", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = load(id);
    if (!p) return fail(reply, 404, "project not found");
    return p.settings.rules.map((text, index) => {
      const discovered = text.startsWith(DISCOVERED_RULE_TAG);
      const body = discovered ? text.slice(DISCOVERED_RULE_TAG.length).trim() : text;
      const category = /^##\s*([\w-]+)\s+rules/i.exec(body)?.[1]?.toLowerCase() ?? "custom";
      return { index, category, discovered, text: body };
    });
  });

  app.put("/projects/:id/rules", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = load(id);
    if (!p) return fail(reply, 404, "project not found");
    const body = (req.body ?? {}) as { rules?: string[]; keepDiscovered?: boolean };
    const manual = Array.isArray(body.rules) ? body.rules.map((r) => String(r).trim()).filter(Boolean) : [];
    const discovered = body.keepDiscovered === false ? [] : p.settings.rules.filter((r) => r.startsWith(DISCOVERED_RULE_TAG));
    const next = save({ ...p, settings: { ...p.settings, rules: [...manual, ...discovered] } });
    container.auditRepo.record({ action: "project.rules.updated", projectId: id, result: "success", source: "web", correlationId: `rules-${id}-${Date.now()}`, metadata: { manual: manual.length, discovered: discovered.length } });
    return { rules: next.settings.rules.length, manual: manual.length, discovered: discovered.length };
  });

  // ---- Dry run / Simulation: preview what an agent would do, without running it ----
  app.post("/projects/:id/dry-run", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = load(id);
    if (!p) return fail(reply, 404, "project not found");
    const body = (req.body ?? {}) as { title?: string; description?: string; agentType?: string };
    const text = `${body.title ?? ""} ${body.description ?? ""}`.trim();
    const agentType = (body.agentType as AgentType | undefined) ?? container.agentRouter.route(text);
    const agent = container.agentRepo.byType(id, agentType);
    if (!agent) return fail(reply, 404, `no agent of type ${agentType} in this project`);
    const now = new Date().toISOString();
    const task = {
      id: "dry-run",
      projectId: id,
      title: body.title ?? text.slice(0, 80) ?? "Dry run",
      description: body.description ?? "",
      status: "created" as const,
      agentType,
      correlationId: "dry-run",
      input: {},
      createdAt: now,
      updatedAt: now,
    };
    const plan = defaultPlanFor(agent, task);
    const context = await container.contextEngine.build({ project: p, agent, task, skills: container.skillsRegistry, github: container.github }).catch(() => undefined);
    const tools = plan.filter((s) => s.tool).map((s) => container.toolRegistry.get(s.tool!)).filter(Boolean);
    return {
      simulation: true,
      agent: { id: agent.id, name: agent.name, type: agent.type },
      model: { primary: agent.models.primary || null, fallbacks: agent.models.fallbacks },
      plan: plan.map((s, i) => ({ index: i, label: s.label, tool: s.tool ?? null, requiresApproval: Boolean(s.requiresApproval) || Boolean(s.tool && container.toolRegistry.get(s.tool)?.dangerous) })),
      writes: plan.filter((s) => s.tool && container.toolRegistry.get(s.tool)?.dangerous).map((s) => ({ step: s.label, tool: s.tool })),
      approvalsNeeded: plan.filter((s) => s.requiresApproval || (s.tool && container.toolRegistry.get(s.tool)?.dangerous)).length,
      context: context ? { tokens: context.tokens, sources: context.sources.map((c) => c.label) } : null,
      tools: tools.map((t) => ({ name: t!.name, dangerous: t!.dangerous, permissions: t!.permissions })),
      budget: p.settings.budget,
    };
  });

  // ---- Repositories (multi-repo) ----
  app.get("/projects/:id/repositories", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = load(id);
    if (!p) return fail(reply, 404, "project not found");
    return p.repositories.map((r) => ({ ...r, path: r.isConfigRepo ? ".ai-engineering" : undefined }));
  });

  // Link a repository (picked from the connected GitHub account) to a project.
  app.post("/projects/:id/repositories", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = load(id);
    if (!p) return fail(reply, 404, "project not found");
    const repo = String(body.repo ?? body.fullName ?? "").trim();
    if (!isValidRepoFullName(repo)) return fail(reply, 400, `Invalid repository "${repo}" — expected owner/name`);
    const existing = p.repositories.find((r) => r.repo.toLowerCase() === repo.toLowerCase());
    const link: Partial<ProjectRepositoryLink> = {
      repo,
      branch: typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : (existing?.branch ?? (typeof body.defaultBranch === "string" ? body.defaultBranch : "main")),
      role: (body.role as ProjectRepositoryLink["role"]) ?? existing?.role ?? (p.repositories.length ? "other" : "primary"),
      isConfigRepo: body.isConfigRepo === true || (p.repositories.length === 0),
      private: typeof body.private === "boolean" ? body.private : existing?.private,
      defaultBranch: typeof body.defaultBranch === "string" ? body.defaultBranch : existing?.defaultBranch,
      htmlUrl: typeof body.htmlUrl === "string" ? body.htmlUrl : existing?.htmlUrl,
      addedAt: existing?.addedAt,
    };
    let repos = existing ? p.repositories.map((r) => (r === existing ? { ...r, ...link } : r)) : [...p.repositories, link as ProjectRepositoryLink];
    if (link.isConfigRepo) repos = repos.map((r) => ({ ...r, isConfigRepo: r.repo.toLowerCase() === repo.toLowerCase() }));
    const updated = save({ ...p, repositories: normalizeRepositories(repos) });
    if (container.github.kind === "mock") await container.agentManager.onboardProject(id, []);
    return updated;
  });

  app.patch("/projects/:id/repositories/:owner/:name", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id, owner, name } = req.params as { id: string; owner: string; name: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = load(id);
    if (!p) return fail(reply, 404, "project not found");
    const full = `${owner}/${name}`.toLowerCase();
    const target = p.repositories.find((r) => r.repo.toLowerCase() === full);
    if (!target) return fail(reply, 404, "repository not linked to this project");
    let repos = p.repositories.map((r) =>
      r === target
        ? {
            ...r,
            branch: typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : r.branch,
            role: (typeof body.role === "string" ? (body.role as ProjectRepositoryLink["role"]) : r.role),
            isConfigRepo: body.isConfigRepo === true ? true : r.isConfigRepo,
          }
        : r,
    );
    if (body.isConfigRepo === true) repos = repos.map((r) => ({ ...r, isConfigRepo: r.repo.toLowerCase() === full }));
    return save({ ...p, repositories: normalizeRepositories(repos) });
  });

  app.delete("/projects/:id/repositories/:owner/:name", { schema: { tags: ["projects"] } }, async (req, reply) => {
    const { id, owner, name } = req.params as { id: string; owner: string; name: string };
    const p = load(id);
    if (!p) return fail(reply, 404, "project not found");
    const full = `${owner}/${name}`.toLowerCase();
    const repos = p.repositories.filter((r) => r.repo.toLowerCase() !== full);
    if (repos.length === p.repositories.length) return fail(reply, 404, "repository not linked to this project");
    if (repos.length === 0) return fail(reply, 400, "Cannot remove the last repository — a project needs at least one");
    return save({ ...p, repositories: normalizeRepositories(repos) });
  });
}
