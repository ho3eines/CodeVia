import type { ModelProvider } from "../domain/entities.js";
import type { ChatMessage } from "./types.js";

/** Simple JSON chat contract: an exact endpoint, {model,messages} -> {text}. */
export function buildDirectChatRequest(config: ModelProvider, modelId: string, messages: ChatMessage[], key?: string) {
  const url = config.baseUrl?.trim();
  if (!url) throw new Error("Custom chat requires a full endpoint URL");
  if (messages.some(m => m.role === "tool")) throw new Error("Custom chat does not support native tool messages");
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (key && config.authType === "bearer") headers.authorization = `Bearer ${key}`;
  if (key && config.authType === "api-key") headers["api-key"] = key;
  return { url, headers, body: { model: modelId, messages: messages.map(({ role, content }) => ({ role, content })) } };
}

export function directChatText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("text" in payload) || typeof payload.text !== "string") {
    throw new Error("Custom chat response must contain a string text field");
  }
  return payload.text;
}
