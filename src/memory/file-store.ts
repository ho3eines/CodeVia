import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MemoryRecord, IMemoryStore } from "./store.js";
import type { MemoryEntry, MemoryType } from "../domain/entities.js";
import { randomUUID } from "node:crypto";

/**
 * Local filesystem memory store. Used for development, tests, and Simulation Mode,
 * mirroring the GitHub-backed structure under .ai-engineering/memory/.
 */
export class LocalFileMemoryStore implements IMemoryStore {
  readonly kind = "local";
  constructor(private readonly root: string) {
    mkdirSync(this.root, { recursive: true });
  }

  private dirForType(type: MemoryType): string {
    return join(this.root, type);
  }

  private fileFor(type: MemoryType, key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(this.dirForType(type), `${safe}.md`);
  }

  async append(record: MemoryRecord): Promise<string> {
    const dir = this.dirForType(record.type);
    mkdirSync(dir, { recursive: true });
    const path = this.fileFor(record.type, record.key);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const updated = existing
      ? `${existing.trimEnd()}\n\n--- append ${new Date().toISOString()} ---\n${record.content}`
      : record.content;
    writeFileSync(path, updated, "utf8");
    return path;
  }

  async update(record: MemoryRecord): Promise<string> {
    const dir = this.dirForType(record.type);
    mkdirSync(dir, { recursive: true });
    const path = this.fileFor(record.type, record.key);
    writeFileSync(path, record.content, "utf8");
    return path;
  }

  async get(type: MemoryType, key: string): Promise<string | undefined> {
    const path = this.fileFor(type, key);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  async search(query: string, opts: { types?: MemoryType[] } = {}): Promise<MemoryEntry[]> {
    const types = opts.types ?? (Object.keys([
      "architecture",
      "business",
      "technical",
      "decision",
      "bug",
      "knowledge",
      "lesson",
      "conversation",
    ]) as MemoryType[]);
    const results: MemoryEntry[] = [];
    for (const type of types) {
      const dir = this.dirForType(type);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const content = readFileSync(join(dir, file), "utf8");
        if (content.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            id: randomUUID(),
            scope: "project",
            type,
            key: file.replace(/\.md$/, ""),
            content,
            tags: [],
            refs: [],
            source: this.kind,
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    return results;
  }
}
