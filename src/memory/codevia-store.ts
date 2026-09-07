import type { MemoryEntry, MemoryType, Project } from "../domain/entities.js";
import type { IMemoryStore, MemoryRecord } from "./store.js";
import { MEMORY_FILE, parseMemoryFile, type ProjectFilesService } from "../github/project-files.js";
import { localId } from "../github/state-codec.js";

/** One canonical memory representation, shared by agents, API and restore. */
export class CodeViaMemoryStore implements IMemoryStore {
  readonly kind = "codevia";
  constructor(private files: ProjectFilesService, private project: Project, private source = "agent") {}
  private async entries(): Promise<MemoryEntry[]> {
    const state = await this.files.pull(this.project);
    const body = state.contents.get(MEMORY_FILE);
    if (body === undefined) throw new Error("CodeVia/memory.md is missing; initialize project state before reading memory");
    return parseMemoryFile(body).map((e) => ({ ...e, id: localId(this.project.id, "memory", `${e.type}\0${e.key}`), projectId: this.project.id, scope: e.scope ?? "project", type: e.type as MemoryType, tags: e.tags, refs: e.refs ?? [], source: e.source, createdAt: e.createdAt || e.updatedAt || this.project.createdAt, updatedAt: e.updatedAt || this.project.updatedAt }));
  }
  async get(type: MemoryType, key: string): Promise<string | undefined> { return (await this.entries()).find((e) => e.type === type && e.key === key)?.content; }
  async search(query: string, opts: { types?: MemoryType[] } = {}): Promise<MemoryEntry[]> {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return (await this.entries()).filter((e) => (!opts.types || opts.types.includes(e.type)) && (!terms.length || terms.some((term) => `${e.key}\n${e.content}\n${e.tags.join(" ")}`.toLocaleLowerCase().includes(term))));
  }
  async append(record: MemoryRecord): Promise<string> { return this.write(record, true); }
  async update(record: MemoryRecord): Promise<string> { return this.write(record, false); }
  private async write(record: MemoryRecord, append: boolean): Promise<string> {
    await this.files.updateMemory(this.project, (entries) => {
      const old = entries.find((e) => e.type === record.type && e.key === record.key);
      const now = new Date().toISOString();
      const entry: MemoryEntry = { ...record, id: localId(this.project.id, "memory", `${record.type}\0${record.key}`), projectId: this.project.id,
        content: append && old ? `${old.content}\n\n${record.content}` : record.content,
        tags: append ? [...new Set([...(old?.tags ?? []), ...record.tags])] : record.tags,
        refs: append ? [...new Set([...(old?.refs ?? []), ...record.refs])] : record.refs,
        source: this.source, version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now,
      };
      return [...entries.filter((e) => e.id !== entry.id), entry];
    });
    return MEMORY_FILE;
  }
}
