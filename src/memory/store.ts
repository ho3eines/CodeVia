import type { MemoryEntry, MemoryType } from "../domain/entities.js";

export interface MemoryRecord {
  type: MemoryType;
  key: string;
  content: string;
  tags: string[];
  refs: string[];
  scope: "project" | "agent" | "task" | "conversation" | "global";
}

/**
 * Abstraction for persistent memory. The canonical implementation is GitHub-backed
 * (the repo is the source of truth and memory is versioned via commits). A local
 * file store is provided for dev/test/Simulation Mode. The DB remains cache-only.
 */
export interface IMemoryStore {
  readonly kind: string;
  append(record: MemoryRecord): Promise<string>;
  get(type: MemoryType, key: string): Promise<string | undefined>;
  search(query: string, opts?: { types?: MemoryType[] }): Promise<MemoryEntry[]>;
  update(record: MemoryRecord): Promise<string>;
}
