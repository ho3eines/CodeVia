import { z } from "zod";
import type { PromptVersion } from "../prompts/versions.js";
import { matter, parseMatter } from "./markdown.js";
import { assertVersion, repositorySafe, STATE_VERSION } from "./state-codec.js";

export const PROMPT_HISTORY_DIR = "CodeVia/prompts/history";
export const PROMPT_HISTORY_INDEX = "CodeVia/prompts/index.md";

export interface PromptHistory {
  projectId: string;
  agentId: string;
  versions: PromptVersion[];
}

const versionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  version: z.number().int().positive(),
  systemPrompt: z.string().max(100_000),
  projectPrompt: z.string().max(100_000).optional(),
  source: z.string(),
  note: z.string().optional(),
  derivedFrom: z.number().int().positive().optional(),
  createdAt: z.string().min(1),
});
const historySchema = z
  .object({
    projectId: z.string().min(1),
    agentId: z.string().min(1),
    versions: z.array(versionSchema).max(10_000),
  })
  .superRefine((history, ctx) => {
    const ids = new Set<string>(),
      versions = new Set<number>();
    for (const v of history.versions) {
      if (v.projectId !== history.projectId || v.agentId !== history.agentId)
        ctx.addIssue({ code: "custom", message: "Prompt version belongs to a different history" });
      if (ids.has(v.id) || versions.has(v.version))
        ctx.addIssue({ code: "custom", message: "Duplicate prompt version identity or number" });
      ids.add(v.id);
      versions.add(v.version);
    }
  });

export function parsePromptHistory(content: string): PromptHistory {
  const { data } = parseMatter(content);
  assertVersion(data);
  return historySchema.parse(data.promptHistory);
}

export function renderPromptHistory(history: PromptHistory): string {
  const safe = historySchema.parse(repositorySafe(history));
  const versions = [...safe.versions].sort((a, b) => a.version - b.version);
  return matter(
    { schemaVersion: STATE_VERSION, promptHistory: { ...safe, versions } },
    [
      `# Prompt history — ${history.agentId}`,
      "",
      "The complete, observed prompt versions are in front matter. This file does not activate a prompt; CodeVia/agents/ remains authoritative for the current definition.",
      "",
      ...versions.map((v) => `- v${v.version} · ${v.createdAt} · ${v.source}`),
    ].join("\n"),
  );
}

/** Marks completion of the one-time migration from the old local-only index. */
export function renderPromptHistoryIndex(): string {
  return matter(
    { schemaVersion: STATE_VERSION, kind: "prompt-history", formatVersion: 1 },
    "# Prompt history\n\nHistory files live in history/. Only observed versions are recorded; missing past versions are never invented.",
  );
}
export function parsePromptHistoryIndex(content: string): void {
  const { data } = parseMatter(content);
  assertVersion(data);
  z.object({ kind: z.literal("prompt-history"), formatVersion: z.literal(1) }).parse(data);
}
