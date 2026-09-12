import type { ID } from "../types.js";
import type { Model, ModelProvider } from "../domain/entities.js";
import { DEMO_USER_ID } from "../auth/identity.js";

/* ------------------------------------------------------------------ *
 * Per-account ownership for Models and Providers.
 *
 * Before this module the model registry was a single global table: every
 * account saw — and could edit, delete, run and re-key — every other
 * account's providers. On a shared deployment that meant one user's API
 * keys and models were another user's to spend.
 *
 * The rule here deliberately mirrors `canAccessProject` (src/http/auth.ts)
 * so projects, models and providers behave the same way:
 *
 *   1. A row with no `ownerId` is a platform/shared row: the seeded defaults
 *      (Mock AI, OpenAI, Anthropic, Gemini) and rows written before
 *      per-account ownership existed. Every account may see and use them.
 *   2. The unauthenticated demo user (`user-demo`) sees everything — a
 *      single-user / simulation install must not lose access to anything.
 *   3. Otherwise an account sees only its own rows.
 *
 * Writes are stricter than reads: mutating a shared row hands it to the
 * acting account (`adoptRowForMutation`), exactly like `adoptProjectConnection`
 * hands a stranded project to the account that opens it. That is what stops
 * "user A pastes a key into the shared OpenAI card" from exposing that key —
 * or that budget — to user B.
 * ------------------------------------------------------------------ */

/** Anything that can carry an owner. */
export type OwnedRow = { ownerId?: ID };

/**
 * The seeded offline provider is the platform's always-available fallback.
 * It carries no secret and must keep working for every account, so it is
 * never taken over by an individual user (see `adoptRowForMutation`).
 */
export const BUILT_IN_MOCK_PROVIDER_ID = "provider-mock";

/** Seeded offline models belonging to {@link BUILT_IN_MOCK_PROVIDER_ID}. */
export const BUILT_IN_MOCK_MODEL_IDS: ReadonlySet<string> = new Set([
  "model-mock-fast",
  "model-mock-strong",
  "model-mock-reasoning",
]);

/** A row nobody owns — platform default or pre-multi-user legacy row. */
export function isSharedRow(row: OwnedRow): boolean {
  return !row.ownerId;
}

/**
 * Can the acting account see this row?
 *
 * `userId` is `undefined` for unattended/background work, which keeps using
 * the shared rows rather than silently seeing everything.
 */
export function rowVisibleTo(row: OwnedRow, userId?: string | undefined): boolean {
  // Demo / single-user mode (no login, or the pre-login identity) sees all.
  if (!userId || userId === DEMO_USER_ID) return true;
  return isSharedRow(row) || row.ownerId === userId;
}

/** Filter a provider list down to what one account may see. */
export function scopedProviders<T extends ModelProvider>(providers: T[], userId?: string | undefined): T[] {
  return providers.filter((p) => rowVisibleTo(p, userId));
}

/** Filter a model list down to what one account may see. */
export function scopedModels<T extends Model>(models: T[], userId?: string | undefined): T[] {
  return models.filter((m) => rowVisibleTo(m, userId));
}

/**
 * The account whose models/providers a piece of work should use.
 *
 * Project-scoped work (agent runs, workflow nodes, workers) belongs to the
 * project owner; interactive work (chat, benchmarks, direct chat) belongs to
 * the signed-in user. The demo identity maps to `undefined` (= shared rows
 * only) so a pre-login project never loses its models after this change.
 */
export function actingModelOwner(...candidates: Array<string | undefined | null>): string | undefined {
  for (const candidate of candidates) {
    if (candidate && candidate !== DEMO_USER_ID) return candidate;
  }
  return undefined;
}

/**
 * Never adopt the platform's offline fallback: the built-in mock provider and
 * its seeded models stay shared so every account keeps an offline path.
 */
export function isProtectedSharedRow(row: { id: ID }): boolean {
  return row.id === BUILT_IN_MOCK_PROVIDER_ID || BUILT_IN_MOCK_MODEL_IDS.has(row.id);
}

/**
 * Take ownership of a shared row before mutating it.
 *
 * Returns the row to write: the shared row stamped with the acting account,
 * or the unchanged row when there is nothing to adopt (already owned,
 * protected built-in, demo/unauthenticated caller, or an owner writing its
 * own row).
 *
 * Why: a shared row is visible to every account. Letting an account edit it
 * in place would publish its configuration — and its API key — to everyone
 * else, and would let one account delete or re-key another's fallback.
 */
export function adoptRowForMutation<T extends OwnedRow & { id: ID }>(row: T, userId?: string | undefined): T {
  if (!userId || userId === DEMO_USER_ID) return row;
  if (!isSharedRow(row)) return row;
  if (isProtectedSharedRow(row)) return row;
  return { ...row, ownerId: userId };
}
