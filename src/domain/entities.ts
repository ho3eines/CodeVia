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
  /**
   * Owning account. Absent = platform/shared row (seeded defaults and rows
   * written before per-account ownership existed): visible to every account,
   * and taken over (`adoptRowForMutation`) by the first account that edits it.
   * See `src/ai/ownership.ts` — the rule mirrors `canAccessProject`.
   */
  ownerId?: ID;
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
  /**
   * Per-model sampling temperature — the model's **creativity** dial, from
   * `0.0` (deterministic, repeatable) to `1.0` (most creative/varied).
   * Overrides the provider default for every call to THIS model (chat, test
   * and streaming). Some routes only accept a fixed value — e.g. a model that
   * rejects `0.0` with "Supported values are between 1.0 and 1.0" needs
   * `temperature: 1` here.
   */
  temperature?: number;
  /** Per-model max output tokens; overrides the provider's `maxTokensDefault`. */
  maxTokens?: number;
  /**
   * Omit the `temperature` field entirely from requests to this model — for
   * routes that reject the parameter no matter which value is sent.
   */
  omitTemperature?: boolean;
  /** Notes shown on the Models page (why this model is tuned this way). */
  notes?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  /**
   * Owning account — normally the owner of the model's provider. Absent means
   * platform/shared (see `ModelProvider.ownerId` and `src/ai/ownership.ts`).
   */
  ownerId?: ID;
}

/* ------------------------------------------------------------------ *
 * Skill
 * ------------------------------------------------------------------ */
export interface Skill {
  /** Cache-only optimistic read stamp; never exported to the repository. */
  repositoryRevision?: string;
  id: ID;
  /** Project-local repository definition; absent only for marketplace templates. */
  projectId?: ID;
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

/** The exact skill knowledge and task-local guidance used in a run. */
export interface AssignedSkill {
  slug: string;
  name: string;
  version: string;
  instructions: string;
  guidance: string;
  source: "agent" | "project" | "task" | "dependency";
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
  /** Whether the canonical `CodeVia/` folder lives in this repo. */
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
  /** Cache-only optimistic read stamp; never exported to the repository. */
  repositoryRevision?: string;
  id: ID;
  /**
   * Platform user who owns this project. Empty/undefined means "shared" — legacy
   * rows and single-user installs stay visible to every bot. Per-user bots filter
   * on it, so one user's Telegram bot cannot list or drive another's repos.
   */
  ownerId?: ID;
  slug: string;
  name: string;
  description: string;
  /** Repository containing canonical CodeVia project state. */
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
  /** Persisted CodeVia schema/provenance, never a flag allowing DB fallback. */
  repositoryState?: { version: 2; generation: "ai" | "simulation" | "imported"; initializedAt: ISODate; modelId?: ID };
  active: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface ProjectSettings {
  environment: "development" | "staging" | "production";
  notifications: string[];
  rules: string[];
  skills: string[];
  /** Last automatic selection, so onboarding preserves manual attachments. */
  generatedSkills?: string[];
  workflows: string[];
  budget: Budget;
  /** Max autonomous QA↔Fix retry loops before the parent task fails. */
  maxFixLoops?: number;
  /** When QA fails, route back through research to re-analyse before fixing
   *  instead of patching directly on the same implementer. */
  researchBeforeFix?: boolean;
  /** Cache GitHub context in memory between runs to avoid rescanning the tree
   *  on every autonomous execution. */
  cacheContextInMemory?: boolean;
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
  /**
   * Explicit allow-list of model IDs this agent may use. When non-empty, the
   * router only considers models whose id is in this list (and which satisfy
   * the required capabilities). Primary/secondary/fallbacks are filtered
   * against this list too. Users set this from the agent editor to pin an
   * agent to a specific set of models (e.g. "only use fast + cheap models for
   * the conversation assistant").
   */
  allowedModels?: ID[];
  specialized: Partial<
    Record<"research" | "coding" | "vision" | "fast" | "final-review" | "reasoning", ID>
  >;
}

export interface Agent {
  /** Cache-only optimistic read stamp; never exported to the repository. */
  repositoryRevision?: string;
  id: ID;
  projectId: ID;
  type: AgentType;
  name: string;
  slug: string;
  role: string;
  description: string;
  /** Definition file path within the project repo (CodeVia/agents/<type>.md) */
  configPath?: string;
  systemPrompt: string;
  projectPrompt?: string;
  skills: string[];
  /** Baseline generated from the project profile (manual changes are preserved). */
  generatedSkills?: string[];
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
  /** Cache-only optimistic read stamp; never exported to the repository. */
  repositoryRevision?: string;
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
export type TaskPriority = "low" | "medium" | "high" | "critical";

export interface Task {
  id: ID;
  projectId: ID;
  workflowId?: ID;
  parentTaskId?: ID;
  title: string;
  description: string;
  priority?: TaskPriority;
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
  /** Structured tool evidence (commit SHA, branch, CI checks), not private reasoning. */
  data?: Record<string, unknown>;
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
  /** Snapshot of base skill versions and task-local adaptations actually used. */
  skills?: AssignedSkill[];
  /** Final deliverable/analysis, never a reasoning trace. */
  summary?: string;
  verification?: "passed" | "failed" | "unverified" | "simulated";
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

export interface ConversationAttachment {
  /** Client-supplied file name. */
  name: string;
  /** MIME type (e.g. "image/png", "text/plain", "application/pdf"). */
  contentType: string;
  /** File size in bytes. */
  size: number;
  /** For images / small files (<1MB), a data: URL so vision-capable models can
   *  see it. For larger/binary files we include only filename + kind so the
   *  assistant says it cannot see the binary content directly. */
  dataUrl?: string;
  /** One-line preview/description shown in the transcript bubble. */
  preview?: string;
}

export interface ConversationMessage {
  id: ID;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: ISODate;
  metadata?: {
    attachments?: ConversationAttachment[];
    /** The model used to produce an assistant message. */
    modelId?: ID;
    /** Execution mode (autonomous/agent/simulation/fast) used when dispatching. */
    executionMode?: string;
    /** When this user message triggered an autonomous/agent task, store it. */
    dispatchedTaskId?: ID;
    [k: string]: unknown;
  };
}

export interface Conversation {
  /** Cache-only optimistic read stamp; never exported to the repository. */
  repositoryRevision?: string;
  id: ID;
  /** Omitted for standalone chats (the top-level Chat page); set when the conversation is connected to a project. */
  projectId?: ID;
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

/* ------------------------------------------------------------------ *
 * Model Benchmark (smart routing telemetry)
 * ------------------------------------------------------------------ */

/** A single math problem sent to all models during a benchmark run. */
export interface MathBenchmarkProblem {
  id: string;
  /** Textual question in English (numbers in ASCII so models can parse). */
  question: string;
  /** The exact expected answer (as a number or short string). */
  expected: string;
  /** Operation kind used for analytics grouping. */
  kind: "arithmetic" | "algebra" | "word-problem" | "order-of-ops" | "fractions";
}

/** One (model, problem) attempt recorded during a benchmark. */
export interface ModelBenchmarkResult {
  id: ID;
  benchmarkRunId: string;
  modelId: ID;
  providerId: ID;
  problemId: string;
  problemKind: MathBenchmarkProblem["kind"];
  question: string;
  expectedAnswer: string;
  modelAnswer: string;
  /** true when the model's answer parses to the expected value. */
  correct: boolean;
  /** Whether the model returned *anything* parseable (vs. error / refusal). */
  answered: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Error string if the provider threw (timeout, rate limit, HTTP error…). */
  error?: string;
  createdAt: ISODate;
}

/** Aggregated per-model performance computed from all benchmark results. */
export interface ModelPerformanceStats {
  modelId: ID;
  totalAttempts: number;
  successAttempts: number; // answered without error
  correctCount: number;
  accuracy: number; // 0..1 (correct / successAttempts; if none → 0)
  avgLatencyMs: number;
  p95LatencyMs: number;
  errorRate: number; // 0..1
  avgCostUsd: number;
  /** Composite score 0..1 — higher is better. Weighted: accuracy 60%, speed 20%, reliability 20%. */
  score: number;
  /** Category-specific accuracy breakdown. */
  byKind: Record<string, { attempts: number; correct: number; accuracy: number }>;
  lastTestedAt?: ISODate;
  /** Most recent provider error for this model (timeout, HTTP error, …) — used by the \"Unresponsive\" cleanup list. */
  lastError?: string;
}
