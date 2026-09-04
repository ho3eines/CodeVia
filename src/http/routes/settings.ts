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
      telegramConnected: await container.telegram.health(),
      defaultMock: getEnv().MOCK_AI_DEFAULT,
      databasePath: getEnv().DATABASE_PATH,
    };
  });

  app.post("/settings/approval", { schema: { tags: ["settings"] } }, async (req) => {
    const b = req.body as { autoApprove?: boolean };
    // Configure the approval channel: auto-approve vs. require human in Telegram/UI.
    container.approvalChannel = async (action, detail) => {
      await container.notificationRepo.create({
        severity: "warning",
        title: "Approval needed",
        message: action,
        projectId: (detail as { projectId?: string }).projectId,
      });
      return b.autoApprove !== false;
    };
    return { autoApprove: b.autoApprove !== false };
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

  // Import a project config blob.
  app.post("/settings/import", { schema: { tags: ["settings"] } }, async (req) => {
    const b = req.body as { project?: Record<string, unknown>; agents?: unknown[] };
    if (!b.project) return { error: "import payload missing project" };
    const project = await container.agentManager.createProject({
      name: String(b.project.name ?? "Imported"),
      slug: b.project.slug as string | undefined,
      description: String(b.project.description ?? ""),
      configRepo: String(b.project.configRepo ?? "owner/repo"),
      branch: (b.project.branch as string) ?? "main",
      defaultModelId: b.project.defaultModelId as string | undefined,
    });
    return { ok: true, projectId: project.id, importedAgents: (b.agents ?? []).length };
  });
}
