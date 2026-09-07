import { parse as parseYaml } from "yaml";

/** Lossless, human-editable Markdown front-matter (JSON field values). */
export function matter(data: Record<string, unknown>, body: string): string {
  const head = Object.entries(data)
    .map(([k, v]) => `${k}: ${JSON.stringify(v ?? null)}`)
    .join("\n");
  return `---\n${head}\n---\n\n${body}`;
}

export function parseMatter(content: string): { data: Record<string, unknown>; body: string } {
  const m = String(content ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: String(content ?? "") };
  const parsed = parseYaml(m[1], { uniqueKeys: true, maxAliasCount: 0 }) as unknown;
  if (parsed !== undefined && parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("CodeVia front matter must be a mapping");
  const data = (parsed ?? {}) as Record<string, unknown>;
  return { data, body: m[2] };
}
