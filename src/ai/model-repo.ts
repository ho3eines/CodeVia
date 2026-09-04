import { DocumentRepository } from "../db/repository.js";
import type { Model, ModelProvider } from "../domain/entities.js";
import type { Db } from "../db/client.js";
import { getDb } from "../db/client.js";
import { randomUUID } from "node:crypto";

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
    return this.findMany().filter((r) => r.data.active).map((r) => r.data);
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
}

export function getModelRepo(): ModelRepository {
  return new ModelRepository();
}

export function getProviderRepo(): ProviderRepository {
  return new ProviderRepository();
}
