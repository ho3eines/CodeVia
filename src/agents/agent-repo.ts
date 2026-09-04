import { DocumentRepository } from "../db/repository.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import type { Agent, AgentType } from "../domain/entities.js";
import { randomUUID } from "node:crypto";

export class AgentRepository extends DocumentRepository<Agent> {
  constructor(db: Db = getDb()) {
    super("agent", db);
  }

  create(data: Omit<Agent, "id" | "createdAt" | "updatedAt" | "version">): Agent {
    const now = new Date().toISOString();
    const agent: Agent = { ...data, id: randomUUID(), version: 1, createdAt: now, updatedAt: now };
    this.upsert(agent);
    return agent;
  }

  byProject(projectId: string): Agent[] {
    return this.findMany({ projectId }).map((r) => r.data);
  }

  byType(projectId: string, type: AgentType): Agent | undefined {
    return this.findMany({ projectId }).map((r) => r.data).find((a) => a.type === type);
  }
}

export function getAgentRepo(): AgentRepository {
  return new AgentRepository();
}
