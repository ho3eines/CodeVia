import { randomUUID } from "node:crypto";
import { DocumentRepository } from "../db/repository.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import type { Agent } from "../domain/entities.js";
import type { ID, ISODate } from "../types.js";

/* ------------------------------------------------------------------ *
 * Prompt versioning
 *
 * Every change to an agent's system/project prompt produces an immutable
 * PromptVersion (v1, v2, …). Versions can be compared (line diff), restored
 * (which creates a new version — history is never rewritten) and cloned.
 * The GitHub config repo remains the durable store (`prompts/agents/*.md`);
 * this repository is the queryable index/cache.
 * ------------------------------------------------------------------ */

export interface PromptVersion {
  id: ID;
  agentId: ID;
  projectId: ID;
  version: number;
  systemPrompt: string;
  projectPrompt?: string;
  /** Who/what produced the version: web user, telegram, generator, restore, import. */
  source: string;
  note?: string;
  /** When restored/cloned: the version this one was derived from. */
  derivedFrom?: number;
  createdAt: ISODate;
}

export class PromptVersionRepository extends DocumentRepository<PromptVersion> {
  constructor(db: Db = getDb()) {
    super("prompt_version", db);
  }

  forAgent(agentId: string): PromptVersion[] {
    return this.findMany({ parentId: agentId })
      .map((r) => r.data)
      .sort((a, b) => a.version - b.version);
  }

  latest(agentId: string): PromptVersion | undefined {
    const all = this.forAgent(agentId);
    return all[all.length - 1];
  }

  /**
   * Snapshot the agent's current prompt as the next version. Skips when the
   * text is identical to the latest snapshot so re-saving is idempotent.
   */
  snapshot(agent: Agent, meta: { source: string; note?: string; derivedFrom?: number }): PromptVersion {
    const prev = this.latest(agent.id);
    if (prev && prev.systemPrompt === agent.systemPrompt && (prev.projectPrompt ?? "") === (agent.projectPrompt ?? "")) {
      return prev;
    }
    const v: PromptVersion = {
      id: randomUUID(),
      agentId: agent.id,
      projectId: agent.projectId,
      version: (prev?.version ?? 0) + 1,
      systemPrompt: agent.systemPrompt,
      projectPrompt: agent.projectPrompt,
      source: meta.source,
      note: meta.note,
      derivedFrom: meta.derivedFrom,
      createdAt: new Date().toISOString(),
    };
    this.upsert(v, { projectId: agent.projectId, parentId: agent.id });
    return v;
  }
}

export function getPromptVersionRepo(): PromptVersionRepository {
  return new PromptVersionRepository();
}

/* ------------------------------------------------------------------ *
 * Line diff (LCS) — small, dependency-free, good enough for prompts.
 * ------------------------------------------------------------------ */
export interface DiffLine {
  type: "same" | "added" | "removed";
  text: string;
}

export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  // Guard pathological sizes: fall back to a whole-replace diff.
  if (n * m > 4_000_000) {
    return [...x.map((t) => ({ type: "removed" as const, text: t })), ...y.map((t) => ({ type: "added" as const, text: t }))];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ type: "same", text: x[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "removed", text: x[i]! });
      i++;
    } else {
      out.push({ type: "added", text: y[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "removed", text: x[i++]! });
  while (j < m) out.push({ type: "added", text: y[j++]! });
  return out;
}

export function diffSummary(lines: DiffLine[]): { added: number; removed: number; unchanged: number } {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const l of lines) {
    if (l.type === "added") added++;
    else if (l.type === "removed") removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}
