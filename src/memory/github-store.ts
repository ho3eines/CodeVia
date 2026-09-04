import type { IMemoryStore, MemoryRecord } from "./store.js";
import type { IGitHubService, GithubRepoRef } from "../github/types.js";
import type { MemoryEntry, MemoryType } from "../domain/entities.js";
import { randomUUID } from "node:crypto";

/**
 * Canonical memory store. Backed by the project's GitHub repository as the source
 * of truth; every append/update is a commit, which versions memory. On startup /
 * project restore, memory is rehydrated from the repository — the database is
 * never the single source of truth for project knowledge.
 */
export class GitHubMemoryStore implements IMemoryStore {
  readonly kind = "github";
  constructor(
    private readonly github: IGitHubService,
    private readonly repo: GithubRepoRef,
    private readonly branch = "main",
  ) {}

  private pathFor(type: MemoryType, key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `.ai-engineering/memory/${type}/${safe}.md`;
  }

  async append(record: MemoryRecord): Promise<string> {
    const path = this.pathFor(record.type, record.key);
    const existing = await this.github.getFile(this.repo, path, this.branch);
    const content = existing
      ? `${existing.content.trimEnd()}\n\n--- append ${new Date().toISOString()} ---\n\n${record.content}`
      : record.content;
    await this.github.commit(this.repo, this.branch, `memory: append ${record.type}/${record.key}`, [
      { path, content },
    ]);
    return path;
  }

  async update(record: MemoryRecord): Promise<string> {
    const path = this.pathFor(record.type, record.key);
    await this.github.commit(this.repo, this.branch, `memory: update ${record.type}/${record.key}`, [
      { path, content: record.content },
    ]);
    return path;
  }

  async get(type: MemoryType, key: string): Promise<string | undefined> {
    const file = await this.github.getFile(this.repo, this.pathFor(type, key), this.branch);
    return file?.content;
  }

  async search(query: string, opts: { types?: MemoryType[] } = {}): Promise<MemoryEntry[]> {
    const types = opts.types ?? ["architecture", "business", "technical", "decision", "bug", "knowledge", "lesson", "conversation"];
    const results: MemoryEntry[] = [];
    for (const type of types) {
      const file = await this.github.getFile(this.repo, `.ai-engineering/memory/${type}/index.md`, this.branch);
      if (file && file.content.toLowerCase().includes(query.toLowerCase())) {
        results.push({
          id: randomUUID(),
          scope: "project",
          type,
          key: `${type}/index`,
          content: file.content,
          tags: [],
          refs: [],
          source: this.kind,
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return results;
  }
}
