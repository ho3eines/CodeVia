import { randomUUID } from "node:crypto";
import { generateCorrelationId } from "../../events/bus.js";
import type { Agent, MemoryEntry, Project, Workflow } from "../../domain/entities.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Container } from "../../app/container.js";
import { getEnv } from "../../config/env.js";
import {
  getGitHubAdminSettings,
  saveGitHubAdminSettings,
  type SaveGitHubAdminSettingsInput,
} from "../../auth/admin-settings.js";

export function registerSettingsRoutes(app: FastifyInstance, container: Container): void {
  app.get("/settings", { schema: { tags: ["settings"] } }, async () => {
    return {
      environment: getEnv().NODE_ENV,
      simulationMode: getEnv().ENABLE_SIMULATION_MODE,
      githubConnected: container.github.kind === "real",
      // "connected" must mean *the bot can receive messages*, not just that a
      // token exists — that difference is what made "it's configured but silent"
      // impossible to see. `receiving` tells you which transport is live.
      telegramConnected: container.telegramStatus().enabled,
      telegramTransport: container.telegramStatus().transport,
      telegramMode: container.telegramStatus().mode,
      defaultMock: getEnv().MOCK_AI_DEFAULT,
      databasePath: getEnv().DATABASE_PATH,
    };
  });

  app.get("/settings/approval", { schema: { tags: ["settings"] } }, async () => {
    return { ...container.approvals.policy(), pending: container.approvals.pendingCount() };
  });

  app.post("/settings/approval", { schema: { tags: ["settings"] } }, async (req) => {
    const b = (req.body ?? {}) as { autoApprove?: boolean; timeoutMs?: number };
    // Configure the approval policy: auto-approve vs. require a human in Telegram/UI.
    const patch: { autoApprove?: boolean; timeoutMs?: number } = {};
    if (typeof b.autoApprove === "boolean") patch.autoApprove = b.autoApprove;
    if (typeof b.timeoutMs === "number") patch.timeoutMs = b.timeoutMs;
    return container.approvals.setPolicy(patch);
  });

  // System backup (config metadata only — no secrets).
  app.get("/settings/backup", { schema: { tags: ["settings"] } }, async () => {
    return {
      providers: container.providerRepo.findMany().map((r) => ({
        id: r.data.id,
        name: r.data.name,
        type: r.data.type,
        secretRef: r.data.secretRef, // reference only, never a value
      })),
      models: container.modelRepo.findMany().map((r) => r.data),
      agents: container.agentRepo.findMany().map((r) => r.data),
      skills: container.skillRepo.findMany().map((r) => ({ id: r.data.id, slug: r.data.slug, name: r.data.name })),
      projects: container.projectRepo.findMany().map((r) => ({ id: r.data.id, slug: r.data.slug, name: r.data.name })),
      // Admin-managed (non-secret) GitHub login settings — included so a fresh
      // instance (e.g. after a Railway deploy wiped the ephemeral DB) can be
      // restored with POST /settings/restore.
      adminSettings: getGitHubAdminSettings(container.kv),
      secretsIncluded: false,
    };
  });

  // Restore admin-managed settings from a backup blob (POST /settings/backup
  // output). Only the validated, non-secret GitHub login settings are written
  // back — secrets stay environment-only by design.
  app.post("/settings/restore", { schema: { tags: ["settings"] } }, async (req: FastifyRequest, reply: FastifyReply) => {
    const b = (req.body ?? {}) as { adminSettings?: Partial<SaveGitHubAdminSettingsInput> };
    if (!b.adminSettings || typeof b.adminSettings !== "object") {
      reply.code(400);
      return { error: "Restore payload missing adminSettings" };
    }
    try {
      const stored = saveGitHubAdminSettings(container.kv, b.adminSettings, req.user.id);
      await container.auditRepo.record({
        userId: req.user.id,
        action: "admin.settings.restore",
        result: "success",
        source: "web",
        correlationId: `restore-${Date.now()}`,
        metadata: { keys: Object.keys(b.adminSettings) },
      });
      return { ok: true, stored };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      reply.code(status);
      return { error: err instanceof Error ? err.message : "Restore failed" };
    }
  });

  // Project export (config + agents + prompts + skills + workflows + rules; no secrets).
  app.get("/projects/:id/export", { schema: { tags: ["settings"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const project = container.projectRepo.findById(id)?.data;
    if (!project) return { error: "project not found" };
    return {
      project,
      agents: container.agentRepo.byProject(id),
      skills: project.settings.skills,
      workflows: container.workflowRepo.byProject(id),
      memory: container.memoryRepo.byProject(id),
      secrets: [],
    };
  });

  // Import a project config blob (the shape produced by GET /projects/:id/export).
  //   mode: "create" (default) → new project, all ids remapped
  //         "merge"            → into targetProjectId; conflicts by slug/name/key
  //   conflict: "skip" (default) | "overwrite"
  //   dryRun: true → preview only (counts + conflicts), nothing written
  app.post("/settings/import", { schema: { tags: ["settings"] } }, async (req, reply) => {
    const b = req.body as {
      project?: Record<string, unknown>;
      agents?: Array<Record<string, unknown>>;
      workflows?: Array<Record<string, unknown>>;
      memory?: Array<Record<string, unknown>>;
      skills?: string[];
      mode?: "create" | "merge";
      targetProjectId?: string;
      conflict?: "skip" | "overwrite";
      dryRun?: boolean;
    };
    if (!b.project) return reply.code(400).send({ error: "import payload missing project" });
    const mode = b.mode === "merge" ? "merge" : "create";
    const conflict = b.conflict === "overwrite" ? "overwrite" : "skip";
    const dryRun = Boolean(b.dryRun);
    const agents = b.agents ?? [];
    const workflows = b.workflows ?? [];
    const memory = b.memory ?? [];
    const skills = Array.isArray(b.skills) ? b.skills.map(String) : [];

    // Resolve target project (existing for merge, new for create).
    let project: Project | undefined;
    const conflicts: Array<{ kind: string; key: string; action: "skip" | "overwrite" | "rename" }> = [];
    if (mode === "merge") {
      project = b.targetProjectId ? container.projectRepo.findById(b.targetProjectId)?.data : undefined;
      if (!project) return reply.code(404).send({ error: "targetProjectId not found (required for mode=merge)" });
    } else {
      const wantedSlug = String(b.project.slug ?? "").trim() || undefined;
      if (wantedSlug && container.projectRepo.findBySlug(wantedSlug)) {
        conflicts.push({ kind: "project", key: wantedSlug, action: "rename" });
      }
    }

    const existingAgents = project ? container.agentRepo.byProject(project.id) : [];
    const existingWorkflows = project ? container.workflowRepo.byProject(project.id) : [];
    const existingMemory = project ? container.memoryRepo.byProject(project.id) : [];
    const agentBySlug = new Map(existingAgents.map((a) => [a.slug, a]));
    const workflowByName = new Map(existingWorkflows.map((w) => [w.name, w]));
    const memoryByKey = new Map(existingMemory.map((m) => [`${m.type}/${m.key}`, m]));

    const plan = {
      agents: { create: 0, overwrite: 0, skip: 0 },
      workflows: { create: 0, overwrite: 0, skip: 0 },
      memory: { create: 0, overwrite: 0, skip: 0 },
      skills: { add: 0 },
    };
    const decide = (bucket: { create: number; overwrite: number; skip: number }, kind: string, key: string, exists: boolean) => {
      if (!exists) {
        bucket.create++;
        return "create" as const;
      }
      const action = conflict;
      conflicts.push({ kind, key, action });
      if (action === "overwrite") bucket.overwrite++;
      else bucket.skip++;
      return action;
    };
    const agentPlan = agents.map((a) => ({ a, action: decide(plan.agents, "agent", String(a.slug ?? a.name ?? "?"), agentBySlug.has(String(a.slug))) }));
    const workflowPlan = workflows.map((w) => ({ w, action: decide(plan.workflows, "workflow", String(w.name ?? "?"), workflowByName.has(String(w.name))) }));
    const memoryPlan = memory.map((m) => ({ m, action: decide(plan.memory, "memory", `${m.type}/${m.key}`, memoryByKey.has(`${m.type}/${m.key}`)) }));
    const currentSkills = new Set(project?.settings.skills ?? []);
    const newSkills = skills.filter((sk) => !currentSkills.has(sk));
    plan.skills.add = newSkills.length;

    if (dryRun) return { ok: true, dryRun: true, mode, conflict, plan, conflicts };

    // ---- write phase ----
    if (mode === "create") {
      const src = b.project;
      const baseSlug = String(src.slug ?? "").trim() || undefined;
      const slug = baseSlug && container.projectRepo.findBySlug(baseSlug) ? `${baseSlug}-${Date.now().toString(36).slice(-4)}` : baseSlug;
      const settings = (src.settings as Project["settings"] | undefined) ?? undefined;
      project = await container.agentManager.createProject({
        name: String(src.name ?? "Imported"),
        slug,
        description: String(src.description ?? ""),
        configRepo: String(src.configRepo ?? "owner/repo"),
        branch: (src.branch as string) ?? "main",
        repositories: src.repositories as never,
        capabilities: src.capabilities as never,
        defaultModelId: src.defaultModelId as string | undefined,
        settings: settings ? { ...settings, skills: Array.from(new Set([...(settings.skills ?? []), ...skills])) } : undefined,
      });
      // Onboarding scaffolds default agents/workflows; imported entities replace
      // same-slug/name scaffolds instead of duplicating them in the new project.
      for (const a of container.agentRepo.byProject(project.id)) agentBySlug.set(a.slug, a);
      for (const w of container.workflowRepo.byProject(project.id)) workflowByName.set(w.name, w);
    }
    if (!project) return reply.code(500).send({ error: "import failed to resolve project" });
    const projectId = project.id;
    const now = new Date().toISOString();

    const result = { agents: 0, workflows: 0, memory: 0, skills: 0, skipped: 0 };
    const agentIdMap = new Map<string, string>();
    for (const { a, action } of agentPlan) {
      const existing = agentBySlug.get(String(a.slug));
      const shouldWrite = mode === "create" || action !== "skip";
      if (!shouldWrite) {
        result.skipped++;
        continue;
      }
      const id = existing?.id ?? randomUUID();
      if (typeof a.id === "string") agentIdMap.set(a.id, id);
      const agent = {
        ...(existing ?? {}),
        ...a,
        id,
        projectId,
        version: existing ? existing.version + 1 : 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } as Agent;
      container.agentRepo.upsert(agent, { projectId, key: agent.slug });
      result.agents++;
    }
    for (const { w, action } of workflowPlan) {
      const existing = workflowByName.get(String(w.name));
      if (mode === "merge" && action === "skip") {
        result.skipped++;
        continue;
      }
      const id = existing?.id ?? randomUUID();
      const nodes = Array.isArray(w.nodes)
        ? (w.nodes as Array<Record<string, unknown>>).map((n) => ({
            ...n,
            agentId: typeof n.agentId === "string" ? (agentIdMap.get(n.agentId) ?? n.agentId) : n.agentId,
          }))
        : [];
      const wf = {
        ...(existing ?? {}),
        ...w,
        nodes,
        id,
        projectId,
        version: existing ? existing.version + 1 : 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } as unknown as Workflow;
      container.workflowRepo.upsert(wf, { projectId });
      result.workflows++;
    }
    for (const { m, action } of memoryPlan) {
      const existing = memoryByKey.get(`${m.type}/${m.key}`);
      if (mode === "merge" && action === "skip") {
        result.skipped++;
        continue;
      }
      const entry = {
        scope: "project",
        tags: [],
        refs: [],
        source: "import",
        ...(existing ?? {}),
        ...m,
        id: existing?.id ?? randomUUID(),
        projectId,
        version: existing ? existing.version + 1 : 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } as MemoryEntry;
      container.memoryRepo.upsert(entry, { projectId, key: `${entry.type}/${entry.key}` });
      result.memory++;
    }
    if (newSkills.length) {
      const fresh = container.projectRepo.findById(projectId)?.data;
      if (fresh) {
        container.projectRepo.upsert(
          { ...fresh, settings: { ...fresh.settings, skills: Array.from(new Set([...(fresh.settings.skills ?? []), ...skills])) }, updatedAt: now },
          { key: fresh.slug },
        );
        result.skills = newSkills.length;
      }
    }
    await container.auditRepo.record({
      action: "project.imported",
      projectId,
      result: "success",
      source: "web",
      correlationId: generateCorrelationId(),
      metadata: { mode, conflict, ...result },
    });
    return { ok: true, mode, conflict, projectId, imported: result, conflicts };
  });
}
