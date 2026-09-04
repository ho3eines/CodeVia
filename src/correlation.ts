import { randomUUID } from "node:crypto";
import type { CorrelationId } from "./types.js";

/** Generates a traceable correlation id for an entire execution. */
export function correlationId(): CorrelationId {
  return `corr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
