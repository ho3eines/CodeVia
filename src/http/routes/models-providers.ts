import type { FastifyInstance, FastifyReply } from "fastify";
import type { Container } from "../../app/container.js";
import type { Model, ModelProvider } from "../../domain/entities.js";
import {
  providerReadiness,
  providerHasSecret,
  testProviderConnection,
  testModelChat,
  DEFAULT_MODEL_TEST_MESSAGE,
  type ProviderTestResult,
  type ModelTuning,
} from "../../ai/provider-test.js";
import { detectModelCapabilities, detectModelInfo } from "../../ai/provider-urls.js";
import { streamModelChat } from "../../ai/model-stream.js";
import type { ChatMessage } from "../../ai/types.js";
import { knownModelInfos } from "../../ai/known-models.js";
import { decryptSecret, encryptSecret, maskSecret } from "../../auth/encrypted-secrets.js";
import { logger } from "../../logger.js";

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
  anthropic: { baseUrl: "https://api.anthropic.com", secretRef: "ANTHROPIC_API_KEY", authType: "api-key", apiFormat: "anthropic", label: "Anthropic" },
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
 * Provider payload for the UI: readiness/secret status plus how many models of
 * the Models section are attached to it. The Providers page shows those counts
 * on every card so a user can tell at a glance whether a provider is actually
 * doing anything, without cross-referencing the Models page.
 */
function withStatusAndCounts(
  p: ModelProvider,
  container: Container,
): ReturnType<typeof withStatus> & { modelCount: number; activeModelCount: number } {
  const models = container.modelRepo.findMany().filter((m) => m.data.providerId === p.id);
  return {
    ...withStatus(p),
    modelCount: models.length,
    activeModelCount: models.filter((m) => m.data.active).length,
  };
}

/**
 * The seeded offline provider (fixed id) is the platform's always-available
 * fallback and must never be deleted. User-created mock providers — including
 * duplicates of the built-in one — are ordinary rows and stay deletable.
 */
const BUILT_IN_MOCK_PROVIDER_ID = "provider-mock";
function isBuiltInMock(p: ModelProvider): boolean {
  return p.id === BUILT_IN_MOCK_PROVIDER_ID;
}

/** Per-model overrides (temperature / max tokens) as stored on the model row. */
function tuningOf(m: Model): ModelTuning {
  return {
    temperature: typeof m.temperature === "number" ? m.temperature : undefined,
    maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
    omitTemperature: m.omitTemperature === true,
  };
}

/** Parse an optional numeric field: `undefined` keeps it unset, `null` clears it. */
function optionalNumber(v: unknown): number | undefined | null {
  if (v === null || v === "") return null;
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function numberOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** `true` only when `capabilities` carries at least one of the known boolean keys. */
function isMeaningfulCapabilities(c: unknown): c is Model["capabilities"] {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return ["vision", "tools", "structuredOutput", "code", "reasoning", "streaming"].some((k) => k in o);
}

/**
 * Discover and add models from a provider after creation. The primary source is
 * the provider's **live** model catalog (`testProviderConnection`, a read-only
 * call) and each model is stored with its **auto-detected** capabilities — the
 * user never picks them.
 *
 * When the live catalog is unavailable (no key yet, no outbound network, a 4xx/5xx,
 * or an empty catalog) we fall back to the built-in known-model catalog for that
 * provider type (see `knownModelInfos`). This guarantees the Models section is
 * populated after a provider is added/edited even in offline / air-gapped setups,
 * instead of staying empty. A failed live call never fails the create/edit itself.
 */
async function discoverAndAddModels(
  providerId: string,
  config: ModelProvider,
  container: Container,
): Promise<{ added: string[]; test: ProviderTestResult; fromKnownCatalog: boolean }> {
  const testResult = await testProviderConnection(config, { timeoutMs: 15000 });

  // Candidate models: prefer the live catalog when it actually returned some,
  // otherwise fall back to the known catalog for this provider type.
  const liveInfos = testResult.ok ? (testResult.modelInfos ?? []) : [];
  const useKnownCatalog = liveInfos.length === 0;
  const candidates = useKnownCatalog ? knownModelInfos(config.type) : liveInfos;

  // De-duplicate against models ALREADY in the Models section for THIS provider
  // (a model id can legitimately exist for more than one provider).
  const existingModels = new Set(
    container.modelRepo.findMany().filter((m) => m.data.providerId === providerId).map((m) => m.data.modelId),
  );

  const added: string[] = [];
  for (const info of candidates) {
    const modelId = info.id.replace(/^models\//, "").trim();
    if (!modelId || existingModels.has(modelId)) continue;

    try {
      container.modelRepo.create({
        providerId,
        modelId,
        displayName: info.displayName || modelId,
        contextWindow: Number(info.contextWindow) || 128000,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        capabilities: info.capabilities,
        active: true,
        priority: 100,
        fallbackPriority: 100,
        tags: [],
      });
      added.push(modelId);
      existingModels.add(modelId);
    } catch (err) {
      logger.warn(
        `Failed to add model ${modelId} for provider ${providerId}`,
        { err: String(err) },
      );
    }
  }

  return { added, test: testResult, fromKnownCatalog: useKnownCatalog && added.length > 0 };
}

type ProviderStatus = ReturnType<typeof withStatus> & {
  discoveredModels?: number;
  test?: ProviderTestResult;
  message?: string;
};

/**
 * Best-effort model discovery attached to the create/edit response. After a
 * provider is created OR edited, every model in the provider's live catalog
 * that is not yet in the Models section is added automatically (capabilities
 * auto-detected, no user input required). A failed catalog call never fails
 * the create/edit itself — it is only surfaced in `status.message` so the UI
 * can tell the user why no models appeared.
 */
async function attachDiscovery(
  status: ProviderStatus,
  p: ModelProvider,
  container: Container,
  action: "created" | "updated",
): Promise<void> {
  const base = `Provider ${action}`;
  if (p.type === "mock") {
    status.discoveredModels = 0;
    status.message = `${base} (mock provider — no live model catalog)`;
    return;
  }
  let added: string[] = [];
  let test: ProviderTestResult;
  let fromKnownCatalog = false;
  try {
    ({ added, test, fromKnownCatalog } = await discoverAndAddModels(p.id, p, container));
  } catch (err) {
    logger.warn(`Model discovery failed for provider ${p.id} after ${action}`, { err: String(err) });
    status.discoveredModels = 0;
    status.message = `${base} (model discovery failed - check logs)`;
    return;
  }
  if (added.length > 0) {
    logger.info(`Discovered ${added.length} model(s) for provider ${p.name} (${p.id}) after ${action}`, {
      fromKnownCatalog,
    });
  }
  status.discoveredModels = added.length;
  status.test = test;
  status.message = added.length
    ? fromKnownCatalog
      ? `${base} and ${added.length} model(s) added to the Models section from the built-in catalog (live catalog unavailable)`
      : `${base} and ${added.length} model(s) added to the Models section`
    : test.ok
      ? `${base} — all catalog models are already in the Models section`
      : `${base} — ${test.message}`;
}

export function registerModelRoutes(app: FastifyInstance, container: Container): void {
  app.get("/models", { schema: { tags: ["models"] } }, async () => {
    return container.modelRepo.findMany().map((r) => r.data);
  });

  app.post("/models", { schema: { tags: ["models"] } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const providerId = String(b.providerId ?? "").trim();
    if (!providerId) return fail(reply, 400, "providerId is required");
    const prow = container.providerRepo.findById(providerId);
    if (!prow) return fail(reply, 400, `Unknown provider "${providerId}"`);
    // `modelId` may be typed by hand — many free/preview models are missing from
    // a provider's catalog, so manual entry is a first-class path here. The id is
    // normalized (a pasted `models/gemini-…` prefix is stripped) but never
    // validated against the catalog.
    const modelId = String(b.modelId ?? "").trim().replace(/^models\//, "");
    if (!modelId) return fail(reply, 400, "modelId is required (the provider's model name, e.g. gpt-4o-mini)");
    const duplicate = container.modelRepo
      .findMany()
      .find((m) => m.data.providerId === providerId && m.data.modelId === modelId);
    // Idempotent: re-adding an existing model returns it instead of creating a
    // second row (the UI shows a "already in the registry" notice).
    if (duplicate) {
      return { ...duplicate.data, duplicate: true, message: `Model "${modelId}" is already in the registry for this provider` };
    }
    // Capabilities are auto-detected when the client does not supply them.
    const detectedCapabilities = detectModelCapabilities(modelId);
    const capabilities = isMeaningfulCapabilities(b.capabilities)
      ? (b.capabilities as Model["capabilities"])
      : detectedCapabilities;
    const model = container.modelRepo.create({
      providerId,
      modelId,
      displayName: String(b.displayName ?? modelId),
      contextWindow: numberOr(b.contextWindow, detectModelInfo(modelId).contextWindow),
      inputCostPer1k: numberOr(b.inputCostPer1k, 0),
      outputCostPer1k: numberOr(b.outputCostPer1k, 0),
      capabilities,
      active: b.active !== false,
      priority: numberOr(b.priority, 100),
      fallbackPriority: numberOr(b.fallbackPriority, 100),
      tags: Array.isArray(b.tags) ? (b.tags as string[]) : [],
      // Optional per-model tuning — needed by routes that mandate a specific
      // temperature (or reject the parameter entirely).
      ...(typeof optionalNumber(b.temperature) === "number" ? { temperature: optionalNumber(b.temperature) as number } : {}),
      ...(typeof optionalNumber(b.maxTokens) === "number" ? { maxTokens: optionalNumber(b.maxTokens) as number } : {}),
      ...(b.omitTemperature === true ? { omitTemperature: true } : {}),
      ...(typeof b.notes === "string" && b.notes.trim() ? { notes: b.notes.trim() } : {}),
    });
    reply.code(201);
    return { ...model, detectedCapabilities };
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

    const patch: Partial<Model> = {};
    if (typeof b.displayName === "string" && b.displayName.trim()) patch.displayName = b.displayName.trim();
    if (typeof b.modelId === "string" && b.modelId.trim()) {
      const modelId = b.modelId.trim().replace(/^models\//, "");
      const clash = container.modelRepo
        .findMany()
        .find((m) => m.data.id !== id && m.data.providerId === (b.providerId ?? r.data.providerId) && m.data.modelId === modelId);
      if (clash) return fail(reply, 409, `Model "${modelId}" already exists for this provider`);
      patch.modelId = modelId;
    }
    if (typeof b.providerId === "string" && b.providerId.trim()) {
      if (!container.providerRepo.findById(b.providerId.trim())) return fail(reply, 400, `Unknown provider "${b.providerId}"`);
      patch.providerId = b.providerId.trim();
    }
    if (b.contextWindow !== undefined) patch.contextWindow = numberOr(b.contextWindow, r.data.contextWindow);
    if (b.inputCostPer1k !== undefined) patch.inputCostPer1k = numberOr(b.inputCostPer1k, r.data.inputCostPer1k);
    if (b.outputCostPer1k !== undefined) patch.outputCostPer1k = numberOr(b.outputCostPer1k, r.data.outputCostPer1k);
    if (b.priority !== undefined) patch.priority = numberOr(b.priority, r.data.priority);
    if (b.fallbackPriority !== undefined) patch.fallbackPriority = numberOr(b.fallbackPriority, r.data.fallbackPriority);
    if (b.active !== undefined) patch.active = b.active !== false;
    if (Array.isArray(b.tags)) patch.tags = (b.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean);
    if (isMeaningfulCapabilities(b.capabilities)) {
      patch.capabilities = { ...r.data.capabilities, ...(b.capabilities as Model["capabilities"]) };
    }
    if (typeof b.notes === "string") patch.notes = b.notes.trim() || undefined;
    if (b.omitTemperature !== undefined) patch.omitTemperature = b.omitTemperature === true;
    // Temperature / max tokens: a number sets the override, null (or "") clears it
    // and returns the model to the provider default.
    if (b.temperature !== undefined) {
      const t = optionalNumber(b.temperature);
      if (t === null) patch.temperature = undefined;
      else if (typeof t === "number") {
        // Temperature is the model's creativity dial: 0.0 = deterministic,
        // 1.0 = most creative.
        if (t < 0 || t > 1) return fail(reply, 400, "temperature must be between 0.0 and 1.0 (0 = deterministic, 1 = most creative)");
        patch.temperature = t;
      }
    }
    if (b.maxTokens !== undefined) {
      const mt = optionalNumber(b.maxTokens);
      if (mt === null) patch.maxTokens = undefined;
      else if (typeof mt === "number") {
        if (mt < 1) return fail(reply, 400, "maxTokens must be at least 1");
        patch.maxTokens = Math.floor(mt);
      }
    }

    const m: Model = { ...r.data, ...patch, id, createdAt: r.data.createdAt, updatedAt: new Date().toISOString() };
    // `undefined` in a patch means "clear it", so drop the keys explicitly.
    if (b.temperature !== undefined && patch.temperature === undefined) delete m.temperature;
    if (b.maxTokens !== undefined && patch.maxTokens === undefined) delete m.maxTokens;
    if (typeof b.notes === "string" && !patch.notes) delete m.notes;
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

  // Pre-registration model test (before the model is saved). Two modes:
  //  - with `message` in the body → sends ONE real chat message to the model and
  //    returns the exact chat URL + the model's reply (what the Test button uses);
  //  - without `message` → cheap detection only: auto-detected capabilities +
  //    catalog lookup (used by the Add-Model dropdown; never costs a completion).
  // Never persists anything.
  app.post("/models/test", { schema: { tags: ["models"] } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const providerId = String(b.providerId ?? "").trim();
    if (!providerId) return fail(reply, 400, "providerId is required");
    const prow = container.providerRepo.findById(providerId);
    if (!prow) return fail(reply, 400, `Unknown provider "${providerId}"`);
    const modelId = String(b.modelId ?? "").trim();
    if (!modelId) return fail(reply, 400, "modelId is required");
    const info = detectModelInfo(modelId);
    const message = typeof b.message === "string" ? b.message.trim() : "";
    if (message) {
      const chat = await testModelChat(prow.data, info.id, {
        message,
        timeoutMs: 15000,
        tuning: {
          temperature: typeof b.temperature === "number" ? b.temperature : undefined,
          maxTokens: typeof b.maxTokens === "number" ? b.maxTokens : undefined,
          omitTemperature: b.omitTemperature === true,
        },
      });
      return {
        providerId,
        capabilities: info.capabilities,
        detectedCapabilities: info.capabilities,
        ...chat,
      };
    }
    // Detection-only mode: verify reachability + catalog membership, no completion call.
    const test = await testProviderConnection(prow.data, { timeoutMs: 15000 });
    const catalogChecked = Array.isArray(test.models);
    const found = catalogChecked ? test.models!.includes(info.id) : undefined;
    return {
      providerId,
      modelId: info.id,
      found,
      contextWindow: info.contextWindow,
      capabilities: info.capabilities,
      detectedCapabilities: info.capabilities,
      ...test,
    };
  });

  // Live chat test for a saved model: sends ONE real message to the model and
  // returns the exact chat URL + the model's reply. Accepts an optional custom
  // message in the body so users can ask the model anything from the UI.
  app.post("/models/:id/test", { schema: { tags: ["models"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = container.modelRepo.findById(id);
    if (!r) return fail(reply, 404, "model not found");
    const prow = container.providerRepo.findById(r.data.providerId);
    if (!prow) return fail(reply, 404, `Provider not found for model "${r.data.modelId}"`);
    const modelId = r.data.modelId;
    const message = typeof b.message === "string" && b.message.trim() ? b.message : DEFAULT_MODEL_TEST_MESSAGE;
    // The model's saved tuning is used, but the caller may override it for a
    // one-off probe (the Edit form's "Test with these settings" button).
    const tuning: ModelTuning = { ...tuningOf(r.data) };
    if (typeof b.temperature === "number") tuning.temperature = b.temperature;
    if (typeof b.maxTokens === "number") tuning.maxTokens = b.maxTokens;
    if (b.omitTemperature !== undefined) tuning.omitTemperature = b.omitTemperature === true;
    const chat = await testModelChat(prow.data, modelId, { message, timeoutMs: 15000, tuning });
    return {
      providerId: prow.data.id,
      capabilities: r.data.capabilities,
      detectedCapabilities: detectModelInfo(modelId).capabilities,
      ...chat,
    };
  });

  /**
   * Streaming chat with a saved model — Server-Sent Events, one `delta` frame
   * per token chunk so the UI can type the answer out like ChatGPT.
   * Frames: `meta` (endpoint) → `delta`* → `done` | `error`.
   */
  app.post("/models/:id/stream", { schema: { tags: ["models"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = container.modelRepo.findById(id);
    if (!r) return fail(reply, 404, "model not found");
    const prow = container.providerRepo.findById(r.data.providerId);
    if (!prow) return fail(reply, 404, `Provider not found for model "${r.data.modelId}"`);

    // Accept either a single `message` or a full `messages` history so the
    // modal can hold a real multi-turn conversation.
    const history = Array.isArray(b.messages)
      ? (b.messages as Array<Record<string, unknown>>)
          .map((m) => ({ role: String(m.role ?? "user") as ChatMessage["role"], content: String(m.content ?? "") }))
          .filter((m) => m.content.trim() && ["system", "user", "assistant"].includes(m.role))
      : [];
    const single = typeof b.message === "string" ? b.message.trim() : "";
    const messages: ChatMessage[] = history.length ? history : single ? [{ role: "user", content: single }] : [];
    if (!messages.length) return fail(reply, 400, "message (or messages[]) is required");

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const ctrl = new AbortController();
    reply.raw.on("close", () => ctrl.abort());
    try {
      for await (const ev of streamModelChat(prow.data, r.data.modelId, {
        messages,
        temperature: typeof b.temperature === "number" ? b.temperature : r.data.temperature,
        maxTokens: typeof b.maxTokens === "number" ? b.maxTokens : r.data.maxTokens,
        omitTemperature: b.omitTemperature === undefined ? r.data.omitTemperature === true : b.omitTemperature === true,
        signal: ctrl.signal,
      })) {
        send(ev);
      }
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  /**
   * Bulk operations for the Models page multi-select: delete / activate /
   * deactivate many models in one call.
   */
  app.post("/models/bulk", { schema: { tags: ["models"] } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const action = String(b.action ?? "delete");
    if (!["delete", "activate", "deactivate"].includes(action)) {
      return fail(reply, 400, `Unknown action "${action}"`, { allowed: ["delete", "activate", "deactivate"] });
    }
    const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map((v) => String(v)).filter(Boolean) : [];
    if (!ids.length) return fail(reply, 400, "ids[] is required");
    const affected: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const row = container.modelRepo.findById(id);
      if (!row) {
        missing.push(id);
        continue;
      }
      if (action === "delete") container.modelRepo.deleteById(id);
      else {
        container.modelRepo.upsert({
          ...row.data,
          active: action === "activate",
          updatedAt: new Date().toISOString(),
        });
      }
      affected.push(id);
    }
    return { ok: true, action, affected: affected.length, ids: affected, missing };
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
    return container.providerRepo.findMany().map((r) => withStatusAndCounts(r.data, container));
  });

  /**
   * Provider dashboard summary — the numbers shown at the top of the Providers
   * page (total / active / ready / needs a key, plus attached model counts).
   */
  app.get("/providers/summary", { schema: { tags: ["providers"] } }, async () => {
    const providers = container.providerRepo.findMany().map((r) => r.data);
    const models = container.modelRepo.findMany().map((r) => r.data);
    const ready = providers.filter((p) => providerReadiness(p).ready);
    const active = providers.filter((p) => p.active);
    return {
      total: providers.length,
      active: active.length,
      inactive: providers.length - active.length,
      ready: ready.length,
      needsKey: providers.filter((p) => !providerReadiness(p).ready).length,
      activeAndReady: providers.filter((p) => p.active && providerReadiness(p).ready).length,
      models: models.length,
      activeModels: models.filter((m) => m.active).length,
      orphanModels: models.filter((m) => !providers.some((p) => p.id === m.providerId)).length,
      byType: providers.reduce<Record<string, number>>((acc, p) => {
        acc[p.type] = (acc[p.type] ?? 0) + 1;
        return acc;
      }, {}),
    };
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
    const status: ProviderStatus = withStatusAndCounts(p, container);

    // 🤖 Auto-discover and add models from the newly created provider (real catalog,
    //    capabilities auto-detected). The live test result is surfaced so the UI can
    //    show the exact endpoint and the discovered models.
    await attachDiscovery(status, p, container, "created");
    return status;
  });

  app.get("/providers/:id", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = container.providerRepo.findById(id)?.data;
    return p ? withStatusAndCounts(p, container) : fail(reply, 404, "provider not found");
  });

  // Pre-registration connectivity test — never saves anything. Feeds the
  // "Test connection" button inside the Add/Edit Provider form so users can
  // verify the EXACT values currently in the form (and see the endpoint +
  // models) BEFORE committing them. When `providerId` is passed (edit mode)
  // and no new key was typed, the stored encrypted key is used for the test —
  // the edit form never re-displays secrets, so re-typing must not be required.
  app.post("/providers/test", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const type = String(b.type ?? "openai") as ModelProvider["type"];
    if (!PROVIDER_TYPES.includes(type)) return fail(reply, 400, `Unknown provider type "${type}"`, { allowed: PROVIDER_TYPES });
    const preset = PROVIDER_PRESETS[type];
    const authType = (typeof b.authType === "string" ? b.authType : preset.authType) as ModelProvider["authType"];
    if (!AUTH_TYPES.includes(authType)) return fail(reply, 400, `Unknown authType "${authType}"`);
    const apiFormat = (typeof b.apiFormat === "string" ? b.apiFormat : preset.apiFormat) as ModelProvider["apiFormat"];
    if (!API_FORMATS.includes(apiFormat)) return fail(reply, 400, `Unknown apiFormat "${apiFormat}"`);
    const baseUrl = typeof b.baseUrl === "string" && b.baseUrl.trim() ? b.baseUrl.trim() : preset.baseUrl;
    const secretRef = typeof b.secretRef === "string" && b.secretRef.trim() ? b.secretRef.trim() : preset.secretRef;
    const secretValue = typeof b.secretValue === "string" && b.secretValue.trim() ? b.secretValue.trim() : undefined;
    // Edit mode: fall back to the key already stored for this provider so the
    // user can test form changes without re-entering the secret.
    let inheritedSecretValueEnc: string | undefined;
    const editProviderId = typeof b.providerId === "string" ? b.providerId.trim() : "";
    if (!secretValue && editProviderId) {
      const stored = container.providerRepo.findById(editProviderId);
      if (stored) inheritedSecretValueEnc = stored.data.secretValueEnc;
    }
    const name = String(b.name ?? "").trim() || preset.label;
    const draft: ModelProvider = {
      id: "draft",
      name,
      type,
      baseUrl,
      secretRef,
      // Encrypt the pasted key just long enough to be read back by the test;
      // nothing is stored. In edit mode the stored key is reused (still never
      // re-persisted by this endpoint).
      secretValueEnc: secretValue
        ? JSON.stringify(encryptSecret(secretValue, "provider-secret"))
        : inheritedSecretValueEnc,
      authType,
      apiFormat,
      timeoutMs: numberOr(b.timeoutMs, 60000),
      maxTokensDefault: numberOr(b.maxTokensDefault, 4096),
      defaultTemperature: numberOr(b.defaultTemperature, 0.3),
      rateLimitPerMinute: numberOr(b.rateLimitPerMinute, 200),
      active: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const timeoutMs = Math.min(numberOr(b.timeoutMs, 60000), 15000);
    const result = await testProviderConnection(draft, { timeoutMs });
    return { providerId: undefined, ...result };
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
    // 🤖 Re-run model discovery after the edit (same behavior as on create): any
    //    model in the provider's live catalog that is missing from the Models
    //    section is added automatically. Best-effort — a failed catalog call
    //    never fails the edit itself.
    const status: ProviderStatus = withStatusAndCounts(p, container);
    await attachDiscovery(status, p, container, "updated");
    return status;
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
    return withStatusAndCounts(p, container);
  });

  app.post("/providers/:id/deactivate", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.providerRepo.findById(id);
    if (!r) return fail(reply, 404, "provider not found");
    const p = { ...r.data, active: false, updatedAt: new Date().toISOString() };
    container.providerRepo.upsert(p);
    container.providerRegistry.invalidate(id);
    return withStatusAndCounts(p, container);
  });

  // Live connectivity check (key presence + model catalog call) for a saved provider.
  app.post("/providers/:id/test", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.providerRepo.findById(id);
    if (!r) return fail(reply, 404, "provider not found");
    const result = await testProviderConnection(r.data);
    return { providerId: id, ...result };
  });

  /**
   * Pull the provider's catalog and add every model that is missing from the
   * Models section — the same discovery that runs after create/edit, but on
   * demand. This is what the "Sync models" button on a provider card calls, so
   * a user can refresh a provider's models without re-saving the form.
   */
  app.post("/providers/:id/sync-models", { schema: { tags: ["providers", "models"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.providerRepo.findById(id);
    if (!r) return fail(reply, 404, "provider not found");
    const status: ProviderStatus = withStatusAndCounts(r.data, container);
    await attachDiscovery(status, r.data, container, "updated");
    return {
      ok: true,
      providerId: id,
      added: status.discoveredModels ?? 0,
      message: status.message,
      test: status.test,
      ...withStatusAndCounts(r.data, container),
    };
  });

  /**
   * Bulk activate / deactivate / delete providers, mirroring `/models/bulk` so
   * the Providers page can offer the same multi-select workflow as the Models
   * page. Activation of a provider that is not ready is skipped (and reported)
   * unless `force` is set; the built-in mock provider is never deleted.
   */
  app.post("/providers/bulk", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const action = String(b.action ?? "");
    if (!["activate", "deactivate", "delete", "test"].includes(action)) {
      return fail(reply, 400, `Unknown action "${action}"`, { allowed: ["activate", "deactivate", "delete", "test"] });
    }
    const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map((v) => String(v)).filter(Boolean) : [];
    if (!ids.length) return fail(reply, 400, "ids[] is required");
    const force = b.force === true;
    const cascade = b.cascade === true;

    const affected: string[] = [];
    const missing: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const results: Array<{ id: string; name: string; ok: boolean; message: string }> = [];
    let deletedModels = 0;

    for (const id of ids) {
      const row = container.providerRepo.findById(id);
      if (!row) {
        missing.push(id);
        continue;
      }
      const p = row.data;
      if (action === "test") {
        const t = await testProviderConnection(p, { timeoutMs: 15000 });
        results.push({ id, name: p.name, ok: t.ok, message: t.message });
        affected.push(id);
        continue;
      }
      if (action === "delete") {
        if (isBuiltInMock(p)) {
          skipped.push({ id, reason: "The built-in mock provider cannot be deleted" });
          continue;
        }
        const models = container.modelRepo.findMany().filter((m) => m.data.providerId === id);
        if (models.length && !cascade) {
          skipped.push({ id, reason: `Provider has ${models.length} model(s) — retry with cascade` });
          continue;
        }
        for (const m of models) container.modelRepo.deleteById(m.data.id);
        deletedModels += models.length;
        container.providerRepo.deleteById(id);
        container.providerRegistry.invalidate(id);
        affected.push(id);
        continue;
      }
      const activate = action === "activate";
      if (activate) {
        const readiness = providerReadiness(p);
        if (!readiness.ready && !force) {
          skipped.push({ id, reason: readiness.reason ?? "Provider is not ready" });
          continue;
        }
      }
      container.providerRepo.upsert({ ...p, active: activate, updatedAt: new Date().toISOString() });
      container.providerRegistry.invalidate(id);
      affected.push(id);
    }
    return { ok: true, action, affected: affected.length, ids: affected, missing, skipped, deletedModels, results };
  });

  /**
   * Clone a provider (same endpoint/auth/tuning, new name, stored key copied,
   * always created inactive). Handy for spinning up a second key or a staging
   * endpoint without retyping the whole form.
   */
  app.post("/providers/:id/duplicate", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.providerRepo.findById(id);
    if (!r) return fail(reply, 404, "provider not found");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const existingNames = new Set(container.providerRepo.findMany().map((x) => x.data.name.toLowerCase()));
    let name = String(b.name ?? "").trim() || `${r.data.name} (copy)`;
    if (existingNames.has(name.toLowerCase())) {
      let n = 2;
      while (existingNames.has(`${name} ${n}`.toLowerCase())) n += 1;
      name = `${name} ${n}`;
    }
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = r.data;
    const copy = container.providerRepo.create({ ...rest, name, active: false });
    reply.code(201);
    return withStatusAndCounts(copy, container);
  });

  // List the live model catalog for a saved provider. Powers the "Add Model"
  // dropdown — users should pick a model from the catalog (with auto-detected
  // capabilities) instead of typing model ids manually.
  app.get("/providers/:id/models", { schema: { tags: ["providers", "models"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.providerRepo.findById(id);
    if (!r) return fail(reply, 404, "provider not found");
    const result = await testProviderConnection(r.data, { timeoutMs: 15000 });
    return {
      providerId: id,
      providerName: r.data.name,
      apiFormat: r.data.apiFormat,
      catalogUrl: result.catalogUrl,
      chatUrl: result.chatUrl,
      urls: result.urls,
      ok: result.ok,
      keyPresent: result.keyPresent,
      message: result.message,
      hint: result.hint,
      models: result.models ?? [],
      modelInfos: result.modelInfos ?? [],
    };
  });

  app.delete("/providers/:id", { schema: { tags: ["providers"] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = container.providerRepo.findById(id);
    if (!r) return fail(reply, 404, "provider not found");
    if (isBuiltInMock(r.data)) return fail(reply, 400, "The built-in mock provider cannot be deleted (deactivate it instead)");
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
