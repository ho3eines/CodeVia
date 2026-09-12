import { DocumentRepository } from "../db/repository.js";
import type { Model, ModelProvider } from "../domain/entities.js";
import type { Db } from "../db/client.js";
import { getDb } from "../db/client.js";
import { randomUUID } from "node:crypto";
import { rowVisibleTo, scopedModels, scopedProviders } from "./ownership.js";

export class ModelRepository extends DocumentRepository<Model> {
  constructor(db: Db = getDb()) {
    super("model", db);
  }

  /** Attach an entity with a generated id. */
  create(data: Omit<Model, "id" | "createdAt" | "updatedAt">): Model {
    const now = new Date().toISOString();
    const model: Model = { ...data, id: randomUUID(), createdAt: now, updatedAt: now };
    this.upsert(model);
    return model;
  }

  findByProvider(providerId: string): Model[] {
    return this.findMany({ key: providerId }).map((r) => r.data);
  }

  listActive(): Model[] {
    return this.findMany()
      .filter((r) => r.data.active)
      .map((r) => r.data);
  }

  /* ---------------------------------------------------------------- *
   * Per-account scoping (see src/ai/ownership.ts)
   * ---------------------------------------------------------------- */

  /** Every model the account may see — its own plus the shared/platform rows. */
  listForOwner(ownerId?: string | undefined): Model[] {
    return scopedModels(
      this.findMany().map((r) => r.data),
      ownerId,
    );
  }

  /** Active models the account may see. This is what routing must consume. */
  listActiveForOwner(ownerId?: string | undefined): Model[] {
    return this.listForOwner(ownerId).filter((m) => m.active);
  }

  /** Read one model, but only when the account may see it. */
  findVisibleById(id: string, ownerId?: string | undefined): Model | undefined {
    const row = this.findById(id)?.data;
    return row && rowVisibleTo(row, ownerId) ? row : undefined;
  }
}

export class ProviderRepository extends DocumentRepository<ModelProvider> {
  constructor(db: Db = getDb()) {
    super("provider", db);
  }

  create(data: Omit<ModelProvider, "id" | "createdAt" | "updatedAt">): ModelProvider {
    const now = new Date().toISOString();
    const provider: ModelProvider = { ...data, id: randomUUID(), createdAt: now, updatedAt: now };
    this.upsert(provider);
    return provider;
  }

  /** Every provider the account may see — its own plus the shared/platform rows. */
  listForOwner(ownerId?: string | undefined): ModelProvider[] {
    return scopedProviders(
      this.findMany().map((r) => r.data),
      ownerId,
    );
  }

  /** Read one provider, but only when the account may see it. */
  findVisibleById(id: string, ownerId?: string | undefined): ModelProvider | undefined {
    const row = this.findById(id)?.data;
    return row && rowVisibleTo(row, ownerId) ? row : undefined;
  }
}

export function getModelRepo(): ModelRepository {
  return new ModelRepository();
}

export function getProviderRepo(): ProviderRepository {
  return new ProviderRepository();
}
