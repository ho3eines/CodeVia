import type { ModelProvider } from "../domain/entities.js";

export interface ProviderTestResult {
  ok: boolean;
  /** Whether the secret referenced by `secretRef` is present in the server environment. */
  keyPresent: boolean;
  /** Whether a live network check was attempted. */
  checked: boolean;
  status?: number;
  latencyMs?: number;
  message: string;
  hint?: string;
  /** Model ids discovered from the provider (best effort, capped). */
  models?: string[];
}

/** Resolve the API key for a provider config from the process environment (never stored). */
export function resolveProviderKey(config: ModelProvider): string | undefined {
  return config.secretRef ? process.env[config.secretRef] : undefined;
}

export function providerNeedsKey(config: ModelProvider): boolean {
  return config.type !== "mock" && config.authType !== "none";
}

/** Non-network validation: does this provider have what it needs to be usable? */
export function providerReadiness(config: ModelProvider): { ready: boolean; reason?: string; hint?: string } {
  if (config.type === "mock") return { ready: true };
  if (providerNeedsKey(config)) {
    if (!config.secretRef) {
      return {
        ready: false,
        reason: "No secret reference configured",
        hint: "Set 'Secret Ref' to the name of the environment variable holding the API key (e.g. OPENAI_API_KEY).",
      };
    }
    if (!resolveProviderKey(config)) {
      return {
        ready: false,
        reason: `Environment variable ${config.secretRef} is not set on the server`,
        hint: `Add ${config.secretRef}=<your key> to the server environment (.env / docker-compose) and restart, then activate the provider.`,
      };
    }
  }
  if (!config.baseUrl) {
    return { ready: false, reason: "Base URL is required", hint: "Enter the provider's API base URL (e.g. https://api.openai.com/v1)." };
  }
  return { ready: true };
}

function modelsEndpoint(config: ModelProvider, key: string | undefined): { url: string; headers: Record<string, string> } {
  const base = (config.baseUrl ?? "").replace(/\/+$/, "");
  const headers: Record<string, string> = { accept: "application/json" };
  switch (config.apiFormat) {
    case "anthropic":
      if (key) headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      return { url: `${base}/models?limit=50`, headers };
    case "gemini":
      return { url: `${base}/models${key ? `?key=${encodeURIComponent(key)}` : ""}`, headers };
    case "ollama":
      return { url: `${base.replace(/\/v1$/, "")}/api/tags`, headers };
    case "openai":
    case "custom":
    default:
      if (key) headers.authorization = config.authType === "api-key" ? key : `Bearer ${key}`;
      if (key && config.authType === "api-key") headers["api-key"] = key;
      return { url: `${base}/models`, headers };
  }
}

function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const list = (Array.isArray(obj.data) && obj.data) || (Array.isArray(obj.models) && obj.models) || [];
  return (list as Array<Record<string, unknown>>)
    .map((m) => String(m.id ?? m.name ?? m.model ?? ""))
    .filter(Boolean)
    .map((id) => id.replace(/^models\//, ""))
    .slice(0, 50);
}

/**
 * Live connectivity test for a provider: verifies the key is present, then calls
 * the provider's cheapest read-only endpoint (model catalog) with a short timeout.
 * Never throws; always returns a structured result the UI can display.
 */
export async function testProviderConnection(
  config: ModelProvider,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProviderTestResult> {
  const keyPresent = !!resolveProviderKey(config);
  if (config.type === "mock") {
    return { ok: true, keyPresent: false, checked: false, message: "Mock provider is always available (no network call)." };
  }
  const readiness = providerReadiness(config);
  if (!readiness.ready) {
    return { ok: false, keyPresent, checked: false, message: readiness.reason ?? "Provider not ready", hint: readiness.hint };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.min(opts.timeoutMs ?? 10_000, config.timeoutMs || 10_000);
  const { url, headers } = modelsEndpoint(config, resolveProviderKey(config));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: ctrl.signal });
    const latencyMs = Date.now() - started;
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (res.ok) {
      const models = extractModelIds(body);
      return {
        ok: true,
        keyPresent,
        checked: true,
        status: res.status,
        latencyMs,
        message: `Connected (${res.status}) in ${latencyMs}ms${models.length ? ` — ${models.length} models visible` : ""}`,
        models,
      };
    }
    const apiMessage =
      (body && typeof body === "object" && ((body as { error?: { message?: string } }).error?.message ?? (body as { message?: string }).message)) || res.statusText;
    const hint =
      res.status === 401 || res.status === 403
        ? `The key in ${config.secretRef} was rejected by the provider — check that it is valid and has API access.`
        : res.status === 404
          ? "Endpoint not found — check the Base URL and API format."
          : undefined;
    return { ok: false, keyPresent, checked: true, status: res.status, latencyMs, message: `Provider returned ${res.status}: ${apiMessage}`, hint };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      keyPresent,
      checked: true,
      latencyMs: Date.now() - started,
      message: aborted ? `Timed out after ${timeoutMs}ms` : `Network error: ${err instanceof Error ? err.message : String(err)}`,
      hint: "The server could not reach the provider — check the Base URL, outbound network access, or proxy settings.",
    };
  } finally {
    clearTimeout(timer);
  }
}
