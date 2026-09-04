import { DocumentRepository } from "../db/repository.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import type {
  Conversation,
  ConversationMessage,
  MemoryEntry,
  Project,
  Task,
  Workflow,
} from "./entities.js";
import { randomUUID } from "node:crypto";

export class ProjectRepository extends DocumentRepository<Project> {
  constructor(db: Db = getDb()) {
    super("project", db);
  }
  create(data: Omit<Project, "id" | "createdAt" | "updatedAt">): Project {
    const now = new Date().toISOString();
    const p: Project = { ...data, id: randomUUID(), createdAt: now, updatedAt: now };
    this.upsert(p);
    return p;
  }
  findBySlug(slug: string): Project | undefined {
    return this.findMany({ key: slug }).map((r) => r.data)[0];
  }
}

export class TaskRepository extends DocumentRepository<Task> {
  constructor(db: Db = getDb()) {
    super("task", db);
  }
  create(data: Omit<Task, "id" | "createdAt" | "updatedAt">): Task {
    const now = new Date().toISOString();
    const t: Task = { ...data, id: randomUUID(), createdAt: now, updatedAt: now };
    this.upsert(t, { projectId: t.projectId, parentId: t.parentTaskId });
    return t;
  }
  byProject(projectId: string): Task[] {
    return this.findMany({ projectId }).map((r) => r.data);
  }
}

export class WorkflowRepository extends DocumentRepository<Workflow> {
  constructor(db: Db = getDb()) {
    super("workflow", db);
  }
  create(data: Omit<Workflow, "id" | "createdAt" | "updatedAt" | "version">): Workflow {
    const now = new Date().toISOString();
    const w: Workflow = { ...data, id: randomUUID(), version: 1, createdAt: now, updatedAt: now };
    this.upsert(w, { projectId: w.projectId });
    return w;
  }
  byProject(projectId: string): Workflow[] {
    return this.findMany({ projectId }).map((r) => r.data);
  }
}

export class ConversationRepository extends DocumentRepository<Conversation> {
  constructor(db: Db = getDb()) {
    super("conversation", db);
  }
  create(data: Omit<Conversation, "id" | "createdAt" | "updatedAt" | "summary">): Conversation {
    const now = new Date().toISOString();
    const c: Conversation = { ...data, id: randomUUID(), createdAt: now, updatedAt: now, summary: "" };
    this.upsert(c, { projectId: c.projectId, parentId: c.userId });
    return c;
  }
  addMessage(convId: string, msg: ConversationMessage): Conversation | undefined {
    const rec = this.findById(convId);
    if (!rec) return undefined;
    const updated: Conversation = { ...rec.data, messages: [...rec.data.messages, msg], updatedAt: new Date().toISOString() };
    this.upsert(updated, { projectId: updated.projectId, parentId: updated.userId });
    return updated;
  }
  updateSummary(convId: string, summary: string): Conversation | undefined {
    const rec = this.findById(convId);
    if (!rec) return undefined;
    const updated: Conversation = { ...rec.data, summary, updatedAt: new Date().toISOString() };
    this.upsert(updated, { projectId: updated.projectId, parentId: updated.userId });
    return updated;
  }
}

export class MemoryRepository extends DocumentRepository<MemoryEntry> {
  constructor(db: Db = getDb()) {
    super("memory", db);
  }
  byProject(projectId: string): MemoryEntry[] {
    return this.findMany({ projectId }).map((r) => r.data);
  }
}

export function getProjectRepo(): ProjectRepository {
  return new ProjectRepository();
}
export function getTaskRepo(): TaskRepository {
  return new TaskRepository();
}
export function getWorkflowRepo(): WorkflowRepository {
  return new WorkflowRepository();
}
export function getConversationRepo(): ConversationRepository {
  return new ConversationRepository();
}
export function getMemoryRepo(): MemoryRepository {
  return new MemoryRepository();
}
