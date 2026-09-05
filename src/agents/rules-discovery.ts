import type { Project } from "../domain/entities.js";
import type { IGitHubService } from "../github/types.js";
import { parseRepoFullName } from "../github/types.js";
import { logger } from "../logger.js";

/**
 * Automatic Rules Discovery.
 *
 * When a repository is connected we read the files that conventionally encode
 * a project's working agreements (README, CONTRIBUTING, CODEOWNERS,
 * .editorconfig, Directory.Build.*, package.json, *.csproj, Dockerfile, CI
 * definitions, `.ai-engineering/rules/*.md`) and distil them into short,
 * imperative rules the Context Engine injects into every agent prompt.
 */
export interface DiscoveredRule {
  /** coding | architecture | git | security | testing | database | ui | naming */
  category: string;
  text: string;
  source: string;
}

const MAX_RULE_FILES = 30;

export async function discoverProjectRules(
  github: IGitHubService,
  project: Project,
  files: string[],
): Promise<DiscoveredRule[]> {
  const ref = parseRepoFullName(project.repositories[0]?.repo ?? project.configRepo);
  if (!ref) return [];
  const low = files.map((f) => [f, f.toLowerCase()] as const);
  const pick = (re: RegExp) => low.filter(([, l]) => re.test(l)).map(([f]) => f);

  const rules: DiscoveredRule[] = [];
  const read = async (path: string): Promise<string | undefined> => {
    try {
      return (await github.getFile(ref, path, project.branch))?.content;
    } catch {
      return undefined;
    }
  };

  // 1. Explicit `.ai-engineering/rules/*.md` — verbatim, highest priority.
  for (const path of pick(/^\.ai-engineering\/rules\/[^/]+\.md$/).slice(0, MAX_RULE_FILES)) {
    const content = await read(path);
    if (!content) continue;
    const category = path.split("/").pop()!.replace(/\.md$/, "");
    for (const line of bulletLines(content)) rules.push({ category, text: line, source: path });
  }

  // 2. CONTRIBUTING / README "Contributing|Guidelines|Conventions" sections.
  for (const path of pick(/^(contributing|\.github\/contributing)(\.md)?$/)) {
    const content = await read(path);
    if (!content) continue;
    for (const line of bulletLines(content).slice(0, 12)) rules.push({ category: "coding", text: line, source: path });
  }
  const readme = pick(/^readme(\.md)?$/)[0];
  if (readme) {
    const content = await read(readme);
    if (content) {
      const section = extractSection(content, /^#+\s*(contributing|guidelines|conventions|development|coding standards)/im);
      for (const line of bulletLines(section ?? "").slice(0, 8)) rules.push({ category: "coding", text: line, source: readme });
    }
  }

  // 3. CODEOWNERS → git rule.
  const owners = pick(/(^|\/)codeowners$/)[0];
  if (owners) {
    const content = await read(owners);
    const count = (content ?? "").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
    if (count > 0) rules.push({ category: "git", text: `Respect CODEOWNERS: ${count} ownership rule(s) — request review from the listed owners for touched paths.`, source: owners });
  }

  // 4. .editorconfig → naming/coding style.
  const editorconfig = pick(/^\.editorconfig$/)[0];
  if (editorconfig) {
    const content = (await read(editorconfig)) ?? "";
    const indent = /indent_style\s*=\s*(\w+)/i.exec(content)?.[1];
    const size = /indent_size\s*=\s*(\d+)/i.exec(content)?.[1];
    const eol = /end_of_line\s*=\s*(\w+)/i.exec(content)?.[1];
    const bits = [indent && `${indent} indentation`, size && `size ${size}`, eol && `${eol} line endings`].filter(Boolean);
    if (bits.length) rules.push({ category: "coding", text: `Follow .editorconfig: ${bits.join(", ")}.`, source: editorconfig });
    const naming = content.match(/dotnet_naming_rule\.[^\n]+/g)?.length ?? 0;
    if (naming > 0) rules.push({ category: "naming", text: `Apply the ${naming} .NET naming rule(s) declared in .editorconfig.`, source: editorconfig });
  }

  // 5. Directory.Build.props / *.csproj → framework, nullable, warnings-as-errors.
  for (const path of pick(/(^|\/)directory\.build\.props$|\.csproj$/).slice(0, 3)) {
    const content = (await read(path)) ?? "";
    const tf = /<TargetFrameworks?>([^<]+)</i.exec(content)?.[1];
    if (tf) rules.push({ category: "architecture", text: `Target framework is ${tf}; do not change it without approval.`, source: path });
    if (/<Nullable>enable</i.test(content)) rules.push({ category: "coding", text: "Nullable reference types are enabled — no new nullable warnings.", source: path });
    if (/<TreatWarningsAsErrors>true</i.test(content)) rules.push({ category: "coding", text: "Warnings are errors — the build must be warning-free.", source: path });
  }

  // 6. package.json → scripts (test/lint/build) and engines.
  const pkg = pick(/^package\.json$/)[0];
  if (pkg) {
    try {
      const json = JSON.parse((await read(pkg)) ?? "{}") as { scripts?: Record<string, string>; engines?: Record<string, string>; type?: string };
      const scripts = json.scripts ?? {};
      if (scripts.test) rules.push({ category: "testing", text: `Run \`npm test\` (${scripts.test}) before opening a PR.`, source: pkg });
      if (scripts.lint) rules.push({ category: "coding", text: `Code must pass \`npm run lint\` (${scripts.lint}).`, source: pkg });
      if (scripts.build) rules.push({ category: "coding", text: `\`npm run build\` (${scripts.build}) must succeed.`, source: pkg });
      if (json.engines?.node) rules.push({ category: "architecture", text: `Node.js ${json.engines.node} is required.`, source: pkg });
      if (json.type === "module") rules.push({ category: "coding", text: "The package is ESM (`type: module`) — use import/export and `.js` specifiers.", source: pkg });
    } catch {
      /* invalid package.json — ignore */
    }
  }

  // 7. Dockerfile / compose → deployment rule.
  if (pick(/(^|\/)dockerfile$/).length) rules.push({ category: "architecture", text: "The service is containerised — keep the Dockerfile building and avoid host-specific paths.", source: "Dockerfile" });

  // 8. CI definitions → testing rule.
  const ci = pick(/^\.github\/workflows\/.+\.ya?ml$|^\.gitlab-ci\.ya?ml$|^azure-pipelines\.ya?ml$|^\.circleci\//);
  if (ci.length) rules.push({ category: "testing", text: `CI is defined in ${ci.slice(0, 3).join(", ")}${ci.length > 3 ? ", …" : ""} — changes must keep CI green.`, source: ci[0]! });

  // 9. Security hygiene defaults when secrets scaffolding exists.
  if (pick(/^\.env\.example$|^\.env\.sample$/).length) rules.push({ category: "security", text: "Configuration comes from environment variables (see .env.example); never commit real secrets.", source: ".env.example" });

  // 10. Tests folder → testing rule.
  if (pick(/(^|\/)(tests?|__tests__|spec)\//).length) rules.push({ category: "testing", text: "Add or update tests alongside behaviour changes; existing tests must keep passing.", source: "tests/" });

  const deduped = dedupe(rules);
  logger.info(`discovered ${deduped.length} rule(s) for ${project.slug}`, { categories: [...new Set(deduped.map((r) => r.category))] });
  return deduped;
}

/** Render discovered rules as the flat `settings.rules` strings agents consume. */
export function rulesToStrings(rules: DiscoveredRule[]): string[] {
  const byCat = new Map<string, DiscoveredRule[]>();
  for (const r of rules) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  return [...byCat.entries()].map(([cat, list]) => `## ${cap(cat)} rules\n${list.map((r) => `- ${r.text}`).join("\n")}`);
}

function bulletLines(md: string): string[] {
  return md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^([-*+]|\d+\.)\s+/.test(l))
    .map((l) => l.replace(/^([-*+]|\d+\.)\s+/, "").trim())
    .filter((l) => l.length >= 8 && l.length <= 240);
}

function extractSection(md: string, heading: RegExp): string | undefined {
  const m = heading.exec(md);
  if (!m) return undefined;
  const start = m.index;
  const level = (m[0].match(/^#+/) ?? ["#"])[0].length;
  const rest = md.slice(start + m[0].length);
  const next = new RegExp(`^#{1,${level}}\\s`, "m").exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}

function dedupe(rules: DiscoveredRule[]): DiscoveredRule[] {
  const seen = new Set<string>();
  return rules.filter((r) => {
    const k = `${r.category}:${r.text.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
