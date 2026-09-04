import type {
  CorrelationId,
  ID,
  ISODate,
  JobStatus,
  Permission,
  RunStatus,
  TaskStatus,
  UserRole,
} from "../types.js";

/* ------------------------------------------------------------------ *
 * User
 * ------------------------------------------------------------------ */
export interface User {
  id: ID;
  /** Provider-agnostic stable id (e.g. GitHub login / email) */
  externalId: string;
  email: string;
  name: string;
  role: UserRole;
  avatarUrl?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ *
 * Model Provider
 * ------------------------------------------------------------------ */
export type ProviderType =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "azure-openai"
  | "ollama"
  | "openai-compatible"
  | "custom-http"
  | "mock";

export interface ModelProvider {
  id: ID;
  name: string;
  type: ProviderType;
  baseUrl?: string;
  /** Secret reference, e.g. OPENAI_API_KEY. Never a literal key. */
  secretRef?: string;
  /**
   * Optional literal API key encrypted at rest (AES-256-GCM, derived from
   * AUTH_SECRET). Useful when there is no deploy-time env var to reference;
   * only kept opaque in responses.
   */
  secretValueEnc?: string;
  authType: "bearer" | "api-key" | "none";
  apiFormat: "openai" | "anthropic" | "gemini" | "ollama" | "custom";
  timeoutMs: number;
  maxTokensDefault: number;
  defaultTemperature: number;
  rateLimitPerMinute: number;
  active: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ *
 * Model Registry
 * ------------------------------------------------------------------ */
export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  structuredOutput: boolean;
  code: boolean;
  reasoning: boolean;
  streaming: boolean;
}

export interface Model {
  id: ID;
  providerId: ID;
  /** Model id as understood by the provider, e.g. "gpt-4o". */
  modelId: string;
  displayName: string;
  contextWindow: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
  capabilities: ModelCapabilities;
  active: boolean;
  priority: number;
  fallbackPriority: number;
  tags: string[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ *
 * Skill
 * ------------------------------------------------------------------ */
export interface Skill {
  id: ID;
  slug: string;
  name: string;
  description: string;
  category: string;
  instructions: string;
  version: string;
  tools: string[];
  dependencies: string[];
  compatibleAgentTypes: string[];
  metadata: Record<string, unknown>;
  enabled: boolean;
  builtIn: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ *
 * Project
 * ------------------------------------------------------------------ */

/** Role a linked repository plays inside a project (multi-repo projects). */
export type ProjectRepositoryRole =
  | "primary"
  | "frontend"
  | "backend"
  | "mobile"
  | "infra"
  | "docs"
  | "library"
  | "other";

/** A GitHub repository linked to a project. Picked from the connected account. */
export interface ProjectRepositoryLink {
  /** `owner/name` */
  repo: string;
  branch: string;
  role: ProjectRepositoryRole;
  /** Whether `.ai-engineering/` (agents, prompts, memory…) lives in this repo. */
  isConfigRepo?: boolean;
  private?: boolean;
  defaultBranch?: string;
  htmlUrl?: string;
  addedAt?: ISODate;
}

/** How the platform talks to GitHub for this project. */
export interface ProjectGithubConnection {
  kind: "user-oauth" | "server-token" | "mock";
  /** For `user-oauth`: the platform user whose GitHub login token is used. */
  userId?: ID;
  login?: string;
}

/**
 * Multi-select project profile. Every dimension is a list so a project can be
 * e.g. web + mobile, Postgres + Redis, React + .NET at the same time. The
 * legacy single-value fields on Project (`framework`, `database`, …) are kept
 * in sync with the first entry of each list for older code paths/prompts.
 */
export interface ProjectCapabilities {
  platforms: string[];
  languages: string[];
  frameworks: string[];
  databases: string[];
  deploymentTargets: string[];
  features: string[];
  integrations: string[];
  /** Agent roster to generate/enable for this project (empty = all 18 types). */
  agentTypes: AgentType[];
}

export interface Project {
  id: ID;
  slug: string;
  name: string;
  description: string;
  /** Root .ai-engineering repo (GitHub) that acts as source of truth (= primary repository). */
  configRepo: string;
  branch: string;
  /** All repositories linked to the project (the first / `isConfigRepo` one mirrors `configRepo`). */
  repositories: ProjectRepositoryLink[];
  capabilities: ProjectCapabilities;
  githubConnection?: ProjectGithubConnection;
  /** @deprecated derived from capabilities.languages[0] — kept for prompts/back-compat */
  primaryLanguage?: string;
  /** @deprecated derived from capabilities.frameworks[0] */
  framework?: string;
  /** @deprecated derived from capabilities.databases[0] */
  database?: string;
  /** @deprecated derived from capabilities.deploymentTargets[0] */
  deploymentTarget?: string;
  defaultModelId?: ID;
  defaultAgentId?: ID;
  telegramChatId?: string;
  memoryRepo?: string;
  settings: ProjectSettings;
  active: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface ProjectSettings {
  environment: "development" | "staging" | "production";
  notifications: string[];
  rules: string[];
  skills: string[];
  workflows: string[];
  budget: Budget;
  permissions: Record<Permission, boolean>;
  metadata: Record<string, unknown>;
}

export interface Budget {
  maxTokensPerRun: number;
  maxCallsPerRun: number;
  maxCostUsdPerRun: number;
  maxDurationMs: number;
}

/* ------------------------------------------------------------------ *
 * Agent
 * ------------------------------------------------------------------ */
export type AgentType =
  | "orchestrator"
  | "project-manager"
  | "research"
  | "business-analyst"
  | "system-architect"
  | "backend-developer"
  | "frontend-developer"
  | "uiux"
  | "database"
  | "devops"
  | "qa-test"
  | "security"
  | "code-reviewer"
  | "documentation"
  | "debugging"
  | "refactoring"
  | "performance"
  | "release";

export interface AgentModelConfig {
  primary: ID;
  secondary?: ID;
  fallbacks: ID[];
  specialized: Partial<
    Record<"research" | "coding" | "vision" | "fast" | "final-review" | "reasoning", ID>
  >;
}

export interface Agent {
  id: ID;
  projectId: ID;
  type: AgentType;
  name: string;
  slug: string;
  role: string;
  description: string;
  /** YAML file path within .ai-engineering/agents */
  configPath?: string;
  systemPrompt: string;
  projectPrompt?: string;
  skills: string[];
  tools: string[];
  permissions: string[];
  models: AgentModelConfig;
  maxIterations: number;
  timeoutMs: number;
  tokenBudget: number;
  memorySources: string[];
  enabled: boolean;
  version: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ *
 * Workflow
 * ------------------------------------------------------------------ */
export type WorkflowNodeType =
  | "agent"
  | "tool"
  | "condition"
  | "approval"
  | "parallel"
  | "trigger"
  | "webhook"
  | "telegram";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  name: string;
  config: Record<string, unknown>;
  retries: number;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** Optional condition expression on the edge. */
  condition?: string;
}

export interface Workflow {
  id: ID;
  projectId: ID;
  name: string;
  slug: string;
  description: string;
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  enabled: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ *
 * Task / Run
 * ------------------------------------------------------------------ */
export interface Task {
  id: ID;
  projectId: ID;
  workflowId?: ID;
  parentTaskId?: ID;
  title: string;
  description: string;
  status: TaskStatus;
  agentType?: AgentType;
  assignedAgentId?: ID;
  correlationId: CorrelationId;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  approvalRequired?: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface RunStep {
  index: number;
  label: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  tool?: string;
  detail?: string;
  startedAt?: ISODate;
  finishedAt?: ISODate;
}

export interface Run {
  id: ID;
  taskId: ID;
  projectId: ID;
  workflowId?: ID;
  agentId: ID;
  agentType: AgentType;
  status: RunStatus;
  steps: RunStep[];
  modelId?: ID;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  error?: string;
  correlationId: CorrelationId;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ *
 * Conversation
 * ------------------------------------------------------------------ */
export type ConversationSource = "web" | "telegram";

export interface ConversationMessage {
  id: ID;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: ISODate;
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  id: ID;
  projectId: ID;
  userId: ID;
  source: ConversationSource;
  title: string;
  messages: ConversationMessage[];
  summary: string;
  modelId?: ID;
  activeAgentId?: ID;
  updatedAt: ISODate;
  createdAt: ISODate;
}

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */
export type MemoryScope = "global" | "project" | "agent" | "task" | "conversation";
export type MemoryType =
  | "architecture"
  | "business"
  | "technical"
  | "decision"
  | "bug"
  | "knowledge"
  | "lesson"
  | "conversation";

export interface MemoryEntry {
  id: ID;
  projectId?: ID;
  scope: MemoryScope;
  type: MemoryType;
  key: string;
  content: string;
  tags: string[];
  refs: string[];
  source: string;
  version: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ *
 * Job (queue)
 * ------------------------------------------------------------------ */
export interface Job {
  id: ID;
  type: string;
  status: JobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  scheduledAt?: ISODate;
  startedAt?: ISODate;
  finishedAt?: ISODate;
  error?: string;
  correlationId: CorrelationId;
  createdAt: ISODate;
}

/* ------------------------------------------------------------------ *
 * Audit / Cost / Notification
 * ------------------------------------------------------------------ */
export interface AuditLog {
  id: ID;
  userId?: ID;
  agentId?: ID;
  projectId?: ID;
  action: string;
  result: "success" | "failure" | "denied" | "pending";
  source: "web" | "telegram" | "github" | "system";
  correlationId: CorrelationId;
  metadata: Record<string, unknown>;
  ip?: string;
  createdAt: ISODate;
}

export interface CostRecord {
  id: ID;
  providerId?: ID;
  modelId?: ID;
  projectId?: ID;
  agentId?: ID;
  taskId?: ID;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  createdAt: ISODate;
}

export type NotificationSeverity = "info" | "success" | "warning" | "error";

export interface Notification {
  id: ID;
  severity: NotificationSeverity;
  title: string;
  message: string;
  projectId?: ID;
  read: boolean;
  createdAt: ISODate;
}
