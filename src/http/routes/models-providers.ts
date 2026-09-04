import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import type { Model, ModelProvider } from "../../domain/entities.js";

export function registerModelRoutes(app: FastifyInstance, container: Container): void {
  app.get("/models", { schema: { tags: ["models"] } }, async () => {
    return container.modelRepo.findMany().map((r) => r.data);
  });

  app.post("/models", { schema: { tags: ["models"] } }, async (req) => {
    const b = req.body as Record<string, unknown>;
    const model = container.modelRepo.create({
      providerId: String(b.providerId),
      modelId: String(b.modelId ?? "model"),
      displayName: String(b.displayName ?? b.modelId ?? "Model"),
      contextWindow: Number(b.contextWindow ?? 128000),
      inputCostPer1k: Number(b.inputCostPer1k ?? 0),
      outputCostPer1k: Number(b.outputCostPer1k ?? 0),
      capabilities: b.capabilities as Model["capabilities"] ?? {
        vision: false, tools: true, structuredOutput: false, code: true, reasoning: false, streaming: true,
      },
      active: b.active !== false,
      priority: Number(b.priority ?? 100),
      fallbackPriority: Number(b.fallbackPriority ?? 100),
      tags: (b.tags as string[]) ?? [],
    });
    return model;
  });

  app.get("/models/:id", { schema: { tags: ["models"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.modelRepo.findById(id)?.data ?? { error: "model not found" };
  });

  app.patch("/models/:id", { schema: { tags: ["models"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const r = container.modelRepo.findById(id);
    if (!r) return { error: "model not found" };
    const m = { ...r.data, ...b, id, updatedAt: new Date().toISOString() } as Model;
    container.modelRepo.upsert(m);
    return m;
  });

  // Providers
  app.get("/providers", { schema: { tags: ["providers"] } }, async () => {
    return container.providerRepo.findMany().map((r) => r.data);
  });

  app.post("/providers", { schema: { tags: ["providers"] } }, async (req) => {
    const b = req.body as Record<string, unknown>;
    const p = container.providerRepo.create({
      name: String(b.name ?? "Provider"),
      type: (b.type as ModelProvider["type"]) ?? "openai",
      baseUrl: b.baseUrl as string | undefined,
      secretRef: b.secretRef as string | undefined,
      authType: (b.authType as ModelProvider["authType"]) ?? "bearer",
      apiFormat: (b.apiFormat as ModelProvider["apiFormat"]) ?? "openai",
      timeoutMs: Number(b.timeoutMs ?? 60000),
      maxTokensDefault: Number(b.maxTokensDefault ?? 4096),
      defaultTemperature: Number(b.defaultTemperature ?? 0.3),
      rateLimitPerMinute: Number(b.rateLimitPerMinute ?? 200),
      active: b.active !== false,
    });
    return p;
  });

  app.get("/providers/:id", { schema: { tags: ["providers"] } }, async (req) => {
    const { id } = req.params as { id: string };
    return container.providerRepo.findById(id)?.data ?? { error: "provider not found" };
  });

  app.patch("/providers/:id", { schema: { tags: ["providers"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const r = container.providerRepo.findById(id);
    if (!r) return { error: "provider not found" };
    const p = { ...r.data, ...b, id, updatedAt: new Date().toISOString() } as ModelProvider;
    container.providerRepo.upsert(p);
    return p;
  });
}
