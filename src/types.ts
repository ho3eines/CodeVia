/** Shared scalar types used across the platform. */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type ID = string;

export type ISODate = string;

/** A correlation id traces an entire execution across Telegram -> Task -> Agent -> Model -> GitHub -> Result. */
export type CorrelationId = string;

export type JobStatus =
  | "pending"
  | "running"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "retrying"
  | "dead";

export type TaskStatus =
  | "created"
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RunStatus = TaskStatus;

export type UserRole = "owner" | "admin" | "developer" | "reviewer" | "viewer";

export type Permission =
  | "project.read"
  | "project.write"
  | "agent.read"
  | "agent.write"
  | "workflow.read"
  | "workflow.write"
  | "model.read"
  | "model.write"
  | "provider.read"
  | "provider.write"
  | "skill.read"
  | "skill.write"
  | "memory.read"
  | "memory.write"
  | "repository.read"
  | "repository.write"
  | "deployment.read"
  | "deployment.write"
  | "secret.read"
  | "secret.write"
  | "telegram.read"
  | "telegram.write"
  | "admin.read"
  | "admin.write";
