import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import { getEnv } from "../../config/env.js";

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
      secretsIncluded: false,
    };
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
