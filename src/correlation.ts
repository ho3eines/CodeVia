import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { CorrelationId } from "./types.js";

/** Generates a traceable correlation id for an entire execution. */
export function correlationId(): CorrelationId {
  return `corr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * Correlation id for the current async context (typically the HTTP request),
 * so jobs, approvals and runs created anywhere in the call stack share one id
 * without every call site passing it explicitly.
 */
const store = new AsyncLocalStorage<CorrelationId>();

export function currentCorrelationId(): CorrelationId | undefined {
  return store.getStore();
}

export function runWithCorrelation<T>(cid: CorrelationId, fn: () => T): T {
  return store.run(cid, fn);
}
