import type { FastifyInstance, FastifyReply } from "fastify";
import type { Container } from "../../app/container.js";
import type { Model, ModelProvider } from "../../domain/entities.js";
import { providerReadiness, providerHasSecret, testProviderConnection } from "../../ai/provider-test.js";
import { decryptSecret, encryptSecret, maskSecret } from "../../auth/encrypted-secrets.js";

const PROVIDER_TYPES: ModelProvider["type"][] = [
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "azure-openai",
  "ollama",
  "openai-compatible",
  "custom-http",
  "mock",
];
const AUTH_TYPES: ModelProvider["authType"][] = ["bearer", "api-key", "none"];
const API_FORMATS: ModelProvider["apiFormat"][] = ["openai", "anthropic", "gemini", "ollama", "custom"];

/** Sensible defaults per provider type so the "Add Provider" form only needs a name. */
export const PROVIDER_PRESETS: Record<
  ModelProvider["type"],
  { baseUrl?: string; secretRef?: string; authType: ModelProvider["authType"]; apiFormat: ModelProvider["apiFormat"]; label: string }
> = {
  openai: { baseUrl: "https://api.openai.com/v1", secretRef: "OPENAI_API_KEY", authType: "bearer", apiFormat: "openai", label: "OpenAI" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", secretRef: "ANTHROPIC_API_KEY", authType: "api-key", apiFormat: "anthropic", label: "Anthropic" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", secretRef: "GEMINI_API_KEY", authType: "api-key", apiFormat: "gemini", label: "Google Gemini" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", secretRef: "OPENROUTER_API_KEY", authType: "bearer", apiFormat: "openai", label: "OpenRouter" },
  "azure-openai": { baseUrl: "https://<resource>.openai.azure.com/openai", secretRef: "AZURE_OPENAI_API_KEY", authType: "api-key", apiFormat: "openai", label: "Azure OpenAI" },
  ollama: { baseUrl: "http://localhost:11434/v1", secretRef: undefined, authType: "none", apiFormat: "ollama", label: "Ollama (local)" },
  "openai-compatible": { baseUrl: "http://localhost:8000/v1", secretRef: "LLM_API_KEY", authType: "bearer", apiFormat: "openai", label: "OpenAI-compatible" },
  "custom-http": { baseUrl: "", secretRef: "CUSTOM_LLM_API_KEY", authType: "bearer", apiFormat: "custom", label: "Custom HTTP" },
  mock: { baseUrl: undefined, secretRef: undefined, authType: "none", apiFormat: "custom", label: "Mock AI (offline)" },
};

function fail(reply: FastifyReply, status: number, message: string, extra: Record<string, unknown> = {}): { error: string } {
  reply.code(status);
  return { error: message, ...extra };
}

function withStatus(p: ModelProvider): ModelProvider & { readiness: ReturnType<typeof providerReadiness>; keyPresent: boolean; secretValuePresent: boolean; secretMasked: string } {
  const readiness = providerReadiness(p);
  return {
    ...p,
    readiness,
    keyPresent: providerHasSecret(p),
    secretValuePresent: !!p.secretValueEnc,
    secretMasked: p.secretValueEnc ? maskSecret(decryptSecret(p.secretValueEnc, "provider-secret")) : "",
  };
}

/**

 * Discover and add models from a provider after creation.
 * This fetches the model catalog and adds any new models to the repository.
 */
async function discoverAndAddModels(
  providerId: string,
  config: ModelProvider,
  container: Container
): Promise<string[]> {
  // Resolve the provider adapter
  const provider = container.providerRegistry.resolve(config);

  // Test connection and fetch models
  const testResult = await testProviderConnection(config, { timeoutMs: 15000 });

  if (!testResult.ok) {
    // Connection failed - don't add models
    return [];
  }

  // Fetch models from the provider
  let models: ProviderModelInfo[] = [];
  try {
    models = await provider.listModels();
  } catch (err) {
    logger.warn(`Failed to list models for provider ${providerId}`, { err: String(err) });
    return [];
  }

  // Extract model IDs and add to repository
  const existingModels = new Set(
    container.modelRepo.findMany().map((m) => m.data.modelId)
  );

  const added: string[] = [];
  for (const modelInfo of models) {
    const modelId = modelInfo.id.replace(/^models\//, "").trim();
    if (!modelId || existingModels.has(modelId)) continue;

    try {
      container.modelRepo.create({
        providerId,
        modelId,
        displayName: modelInfo.displayName || modelId,
        contextWindow: Number(modelInfo.contextWindow) || 128000,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        capabilities: {
          vision: false,
          tools: true,
          structuredOutput: false,
          code: true,
          reasoning: false,
          streaming: true,
        },
        active: true,
        priority: 100,
        fallbackPriority: 100,
        tags: [],
      });
      added.push(modelId);
    } catch (err) {
      logger.warn(
        `Failed to add model ${modelId} for provider ${providerId}`,
        { err: String(err) }
      );
    }
  }

  return added;
}

function numberOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function registerModelRoutes(app: FastifyInstance, container: Container): void {
  app.get("/models", { schema: { tags: ["models"] } }, async () => {
    return container.modelRepo.findMany().map((r) => r.data);
  });

  app.post("/models", { schema: { tags: ["models"] } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const providerId = String(b.providerId ?? "").trim();
    if (!providerId) return fail(reply, 400, "providerId is required");
    if (!container.providerRepo.findById(providerId)) return fail(reply, 400, `Unknown provider "${providerId}"`);
    const modelId = String(b.modelId ?? "").trim();
    if (!modelId) return fail(reply, 400, "modelId is required (the provider's model name, e.g. gpt-4o-mini)");
    const model = container.modelRepo.create({
      providerId,
      modelId,
      displayName: String(b.displayName ?? modelId),
      contextWindow: numberOr(b.contextWindow, 128000),
      inputCostPer1k: numberOr(b.inputCostPer1k, 0),
      outputCostPer1k: numberOr(b.outputCostPer1k, 0),
      capabilities: (b.capabilities as Model["capabilities"]) ?? {
        vision: false,
        tools: true,
        structuredOutput: false,
        code: true,
        reasoning: false,
        streaming: true,
      },
      active: b.active !== false,
      priority: numberOr(b.priority, 100),
      fallbackPriority: numberOr(b.fallbackPriority, 100),
      tags: Array.isArray(b.tags) ? (b.tags as string[]) : [],
    });
    reply.code(201);
    return model;
  });

  app.get("/models/:id", { schema: { tags: ["models"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const m = container.modelRepo.findById(id)?.data;
    return m ?? fail(reply, 404, "model not found");
  });

  app.patch("/models/:id", { schema: { tags: ["models"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = container.modelRepo.findById(id);
    if (!r) return fail(reply, 404, "model not found");
    const m = { ...r.data, ...b, id, createdAt: r.data.createdAt, updatedAt: new Date().toISOString() } as Model;
    container.modelRepo.upsert(m);
    return m;
  });

  app.post("/models/:id/activate", { schema: { tags: ["models"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.modelRepo.findById(id);
    if (!r) return fail(reply, 404, "model not found");
    const m = { ...r.data, active: true, updatedAt: new Date().toISOString() };
    container.modelRepo.upsert(m);
    return m;
  });

  app.post("/models/:id/deactivate", { schema: { tags: ["models"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.modelRepo.findById(id);
    if (!r) return fail(reply, 404, "model not found");
    const m = { ...r.data, active: false, updatedAt: new Date().toISOString() };
    container.modelRepo.upsert(m);
    return m;
  });

  app.delete("/models/:id", { schema: { tags: ["models"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!container.modelRepo.findById(id)) return fail(reply, 404, "model not found");
    container.modelRepo.deleteById(id);
    return { ok: true };
  });

  // ---------------- Providers ----------------
  app.get("/providers/presets", { schema: { tags: ["providers"] } }, async () => {
    return { types: PROVIDER_TYPES, authTypes: AUTH_TYPES, apiFormats: API_FORMATS, presets: PROVIDER_PRESETS };
  });

  app.get("/providers", { schema: { tags: ["providers"] } }, async () => {
    return container.providerRepo.findMany().map((r) => withStatus(r.data));
  });

  app.post("/providers", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const type = String(b.type ?? "openai") as ModelProvider["type"];
    if (!PROVIDER_TYPES.includes(type)) return fail(reply, 400, `Unknown provider type "${type}"`, { allowed: PROVIDER_TYPES });
    const preset = PROVIDER_PRESETS[type];
    const name = String(b.name ?? "").trim() || preset.label;
    const authType = (typeof b.authType === "string" ? b.authType : preset.authType) as ModelProvider["authType"];
    if (!AUTH_TYPES.includes(authType)) return fail(reply, 400, `Unknown authType "${authType}"`, { allowed: AUTH_TYPES });
    const apiFormat = (typeof b.apiFormat === "string" ? b.apiFormat : preset.apiFormat) as ModelProvider["apiFormat"];
    if (!API_FORMATS.includes(apiFormat)) return fail(reply, 400, `Unknown apiFormat "${apiFormat}"`, { allowed: API_FORMATS });
    const baseUrl = typeof b.baseUrl === "string" && b.baseUrl.trim() ? b.baseUrl.trim() : preset.baseUrl;
    const secretRef = typeof b.secretRef === "string" && b.secretRef.trim() ? b.secretRef.trim() : preset.secretRef;
    if (secretRef && !/^[A-Z][A-Z0-9_]*$/i.test(secretRef)) {
      return fail(reply, 400, "secretRef must be an environment variable NAME (e.g. OPENAI_API_KEY); to store an API key directly use the secretValue field");
    }
    const secretValue = typeof b.secretValue === "string" && b.secretValue.trim() ? b.secretValue.trim() : undefined;
    if (secretValue && secretValue.length < 6) return fail(reply, 400, "secretValue looks too short to be an API key");
    if (type !== "mock" && !baseUrl) return fail(reply, 400, "baseUrl is required for this provider type");
    if (container.providerRepo.findMany().some((r) => r.data.name.toLowerCase() === name.toLowerCase())) {
      return fail(reply, 409, `A provider named "${name}" already exists`);
    }
    const draft: Omit<ModelProvider, "id" | "createdAt" | "updatedAt"> = {
      name,
      type,
      baseUrl,
      secretRef,
      secretValueEnc: secretValue ? JSON.stringify(encryptSecret(secretValue, "provider-secret")) : undefined,
      authType,
      apiFormat,
      timeoutMs: numberOr(b.timeoutMs, 60000),
      maxTokensDefault: numberOr(b.maxTokensDefault, 4096),
      defaultTemperature: numberOr(b.defaultTemperature, 0.3),
      rateLimitPerMinute: numberOr(b.rateLimitPerMinute, 200),
      active: false,
    };
    // Auto-activate when the provider is immediately usable (key present / no key needed);
    // an explicit `active:false` keeps it disabled.
    const readiness = providerReadiness({ ...draft, id: "draft", createdAt: "", updatedAt: "" });
    draft.active = b.active === false ? false : readiness.ready;
    const p = container.providerRepo.create(draft);
    reply.code(201);
    const status = withStatus(p);

    // 🤖 Auto-discover and add models from the newly created provider
    try {
      const added = await discoverAndAddModels(p.id, p, container);
      if (added.length > 0) {
        logger.info(`Discovered ${added.length} models for new provider ${p.name} (${p.id})`);
      }
      // Optionally attach discovered model count to the response
      status.discoveredModels = added.length;
      status.message = added.length
        ? `Provider created and ${added.length} model(s) discovered automatically`
        : "Provider created (no models discovered)";
    } catch (err) {
      logger.warn(`Model discovery failed for new provider ${p.id}`, { err: String(err) });
      status.discoveredModels = 0;
      status.message = "Provider created (model discovery failed - check logs)";
    }

    return status;
  });

  app.get("/providers/:id", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = container.providerRepo.findById(id)?.data;
    return p ? withStatus(p) : fail(reply, 404, "provider not found");
  });

  app.patch("/providers/:id", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = container.providerRepo.findById(id);
    if (!r) return fail(reply, 404, "provider not found");
    if (typeof b.type === "string" && !PROVIDER_TYPES.includes(b.type as ModelProvider["type"])) return fail(reply, 400, `Unknown provider type "${b.type}"`);
    if (typeof b.secretRef === "string" && b.secretRef && !/^[A-Z][A-Z0-9_]*$/i.test(b.secretRef)) {
      return fail(reply, 400, "secretRef must be an environment variable NAME; use secretValue to store a key directly");
    }
    const patch = { ...b };
    if (typeof patch.secretValue === "string") {
      const v = patch.secretValue.trim();
      // An empty secretValue on PATCH means “leave the stored key unchanged” —
      // the edit form does not re-display the secret, so this must never wipe it.
      if (v) patch.secretValueEnc = JSON.stringify(encryptSecret(v, "provider-secret"));
    }
    delete patch.secretValue;
    const p = { ...r.data, ...patch, id, createdAt: r.data.createdAt, updatedAt: new Date().toISOString() } as ModelProvider;
    container.providerRepo.upsert(p);
    container.providerRegistry.invalidate(id);
    return withStatus(p);
  });

  // Approve / enable a provider — refuses when it cannot work (missing key), unless ?force=true.
  app.post("/providers/:id/activate", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { force?: string };
    const r = container.providerRepo.findById(id);
    if (!r) return fail(reply, 404, "provider not found");
    const readiness = providerReadiness(r.data);
    if (!readiness.ready && q.force !== "true") {
      return fail(reply, 422, readiness.reason ?? "Provider is not ready", { hint: readiness.hint, readiness });
    }
    const p = { ...r.data, active: true, updatedAt: new Date().toISOString() };
    container.providerRepo.upsert(p);
    container.providerRegistry.invalidate(id);
    return withStatus(p);
  });

  app.post("/providers/:id/deactivate", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.providerRepo.findById(id);
    if (!r) return fail(reply, 404, "provider not found");
    const p = { ...r.data, active: false, updatedAt: new Date().toISOString() };
    container.providerRepo.upsert(p);
    container.providerRegistry.invalidate(id);
    return withStatus(p);
  });

  // Live connectivity check (key presence + model catalog call).
  app.post("/providers/:id/test", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.providerRepo.findById(id);
    if (!r) return fail(reply, 404, "provider not found");
    const result = await testProviderConnection(r.data);
    return { providerId: id, ...result };
  });

  app.delete("/providers/:id", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.providerRepo.findById(id);
    if (!r) return fail(reply, 404, "provider not found");
    if (r.data.type === "mock") return fail(reply, 400, "The built-in mock provider cannot be deleted (deactivate it instead)");
    const models = container.modelRepo.findMany().filter((m) => m.data.providerId === id);
    const q = req.query as { cascade?: string };
    if (models.length && q.cascade !== "true") {
      return fail(reply, 409, `Provider has ${models.length} model(s). Delete them first or call with ?cascade=true`, { models: models.map((m) => m.data.id) });
    }
    for (const m of models) container.modelRepo.deleteById(m.data.id);
    container.providerRepo.deleteById(id);
    container.providerRegistry.invalidate(id);
    return { ok: true, deletedModels: models.length };
  });
}
