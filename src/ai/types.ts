import type { ID } from "../types.js";
import type { ModelCapabilities } from "../domain/entities.js";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolCallSpec {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  modelId: ID;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolCallSpec[];
  structuredOutput?: Record<string, unknown>;
  jsonMode?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  content: string;
  /** Parsed JSON content when available. */
  json?: unknown;
  finishReason: string;
  usage: Usage;
  modelId: ID;
  providerId: ID;
  costUsd?: number;
  raw?: Record<string, unknown>;
}

export interface ProviderModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
  capabilities: ModelCapabilities;
}

/**
 * Provider abstraction. Agents depend on this interface only — never on a
 * concrete vendor SDK — keeping the platform provider-agnostic.
 */
export interface IModelProvider {
  readonly id: ID;
  readonly type: string;
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<ProviderModelInfo[]>;
  /** Resolve a runtime provider key (secret) from env/secret manager. */
  resolveApiKey(): string | undefined;
  health(): Promise<boolean>;
}
