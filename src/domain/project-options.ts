import type { AgentType, Project, ProjectCapabilities, ProjectRepositoryLink, ProjectRepositoryRole } from "./entities.js";

/* ------------------------------------------------------------------ *
 * Project option catalog.
 *
 * Every project dimension (platform, language, framework, database, deploy
 * target, features, integrations, agent roster) is MULTI-SELECT. The UI
 * renders these as checkbox/chip groups; the API validates against them
 * (unknown values are still accepted as free-text "custom" entries so the
 * catalog never blocks a real-world stack).
 * ------------------------------------------------------------------ */

export interface ProjectOption {
  value: string;
  label: string;
  /** Optional emoji/icon for the UI. */
  icon?: string;
  /** Skill slugs that become relevant when this option is selected. */
  skills?: string[];
  /** Agent types that should be part of the roster when this option is selected. */
  agents?: AgentType[];
}

export const PLATFORM_OPTIONS: ProjectOption[] = [
  { value: "web", label: "Web app", icon: "🌐", agents: ["frontend-developer", "uiux"] },
  { value: "api", label: "API / Backend service", icon: "🔌", agents: ["backend-developer"], skills: ["restapi"] },
  { value: "mobile-android", label: "Mobile — Android", icon: "🤖", agents: ["frontend-developer", "uiux"] },
  { value: "mobile-ios", label: "Mobile — iOS", icon: "🍎", agents: ["frontend-developer", "uiux"] },
  { value: "desktop", label: "Desktop app", icon: "🖥️", agents: ["frontend-developer"] },
  { value: "cli", label: "CLI tool", icon: "⌨️" },
  { value: "library", label: "Library / SDK", icon: "📦", agents: ["documentation"] },
  { value: "microservices", label: "Microservices", icon: "🧩", skills: ["microservices"], agents: ["system-architect", "devops"] },
  { value: "serverless", label: "Serverless / Functions", icon: "⚡", agents: ["devops"] },
  { value: "data-ml", label: "Data / ML pipeline", icon: "📊", agents: ["research", "performance"] },
  { value: "iot", label: "IoT / Embedded", icon: "📡" },
  { value: "browser-extension", label: "Browser extension", icon: "🧷" },
  { value: "bot", label: "Bot (Telegram / Discord / Slack)", icon: "💬" },
];

export const LANGUAGE_OPTIONS: ProjectOption[] = [
  { value: "typescript", label: "TypeScript", skills: ["typescript", "nodejs"] },
  { value: "javascript", label: "JavaScript", skills: ["nodejs"] },
  { value: "csharp", label: "C#", skills: ["csharp", "dotnet"] },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "kotlin", label: "Kotlin" },
  { value: "swift", label: "Swift" },
  { value: "dart", label: "Dart" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "php", label: "PHP" },
  { value: "ruby", label: "Ruby" },
  { value: "cpp", label: "C / C++" },
  { value: "sql", label: "SQL" },
  { value: "shell", label: "Shell / Bash" },
];

export const FRAMEWORK_OPTIONS: ProjectOption[] = [
  { value: "react", label: "React", skills: ["react"] },
  { value: "nextjs", label: "Next.js", skills: ["react", "nodejs"] },
  { value: "vue", label: "Vue / Nuxt" },
  { value: "angular", label: "Angular", skills: ["typescript"] },
  { value: "svelte", label: "Svelte / SvelteKit" },
  { value: "dotnet", label: ".NET", skills: ["dotnet", "csharp"], agents: ["backend-developer"] },
  { value: "aspnetcore", label: "ASP.NET Core", skills: ["aspnetcore", "dotnet", "csharp"] },
  { value: "blazor", label: "Blazor", skills: ["blazor", "dotnet"] },
  { value: "dotnet-maui", label: ".NET MAUI / WPF", skills: ["dotnet", "csharp"] },
  { value: "nodejs-express", label: "Node.js / Express", skills: ["nodejs", "restapi"] },
  { value: "nestjs", label: "NestJS", skills: ["nodejs", "typescript", "restapi"] },
  { value: "fastify", label: "Fastify", skills: ["nodejs", "restapi"] },
  { value: "django", label: "Django" },
  { value: "fastapi", label: "FastAPI", skills: ["restapi"] },
  { value: "flask", label: "Flask" },
  { value: "spring", label: "Spring Boot", skills: ["restapi"] },
  { value: "laravel", label: "Laravel" },
  { value: "rails", label: "Ruby on Rails" },
  { value: "flutter", label: "Flutter", skills: ["ui-design"] },
  { value: "react-native", label: "React Native", skills: ["react"] },
  { value: "android-native", label: "Android (Jetpack Compose)" },
  { value: "swiftui", label: "SwiftUI" },
  { value: "electron", label: "Electron / Tauri" },
  { value: "tailwind", label: "Tailwind CSS", skills: ["ui-design"] },
];

export const DATABASE_OPTIONS: ProjectOption[] = [
  { value: "postgresql", label: "PostgreSQL", skills: ["postgresql"] },
  { value: "sqlserver", label: "SQL Server", skills: ["sqlserver"] },
  { value: "mysql", label: "MySQL / MariaDB" },
  { value: "sqlite", label: "SQLite" },
  { value: "mongodb", label: "MongoDB" },
  { value: "redis", label: "Redis (cache / queue)", agents: ["performance"] },
  { value: "elasticsearch", label: "Elasticsearch / OpenSearch" },
  { value: "dynamodb", label: "DynamoDB" },
  { value: "firebase", label: "Firebase / Firestore" },
  { value: "supabase", label: "Supabase" },
  { value: "oracle", label: "Oracle" },
  { value: "cassandra", label: "Cassandra / ScyllaDB" },
  { value: "clickhouse", label: "ClickHouse" },
  { value: "none", label: "No database" },
];

export const DEPLOYMENT_OPTIONS: ProjectOption[] = [
  { value: "docker", label: "Docker / Compose", skills: ["docker"], agents: ["devops"] },
  { value: "kubernetes", label: "Kubernetes", skills: ["docker"], agents: ["devops"] },
  { value: "railway", label: "Railway", agents: ["devops"] },
  { value: "vercel", label: "Vercel / Netlify", agents: ["devops"] },
  { value: "aws", label: "AWS", agents: ["devops"] },
  { value: "azure", label: "Azure", agents: ["devops"] },
  { value: "gcp", label: "Google Cloud", agents: ["devops"] },
  { value: "iis", label: "IIS / Windows Server", agents: ["devops"] },
  { value: "vps", label: "VPS / Bare metal", agents: ["devops"] },
  { value: "app-stores", label: "App Store / Google Play", agents: ["release"] },
  { value: "github-pages", label: "GitHub Pages" },
  { value: "on-premise", label: "On-premise" },
];

export const FEATURE_OPTIONS: ProjectOption[] = [
  { value: "authentication", label: "Authentication / SSO", skills: ["security"], agents: ["security"] },
  { value: "rbac", label: "Roles & permissions", skills: ["security"], agents: ["security"] },
  { value: "payments", label: "Payments / Billing", agents: ["security"] },
  { value: "realtime", label: "Realtime (WebSocket / SignalR)" },
  { value: "file-storage", label: "File upload / storage" },
  { value: "notifications", label: "Email / SMS / Push notifications" },
  { value: "search", label: "Full-text search" },
  { value: "reporting", label: "Reporting / Dashboards" },
  { value: "i18n", label: "Multi-language (i18n / RTL)", agents: ["uiux"] },
  { value: "multi-tenant", label: "Multi-tenant", agents: ["system-architect"] },
  { value: "background-jobs", label: "Background jobs / Queue" },
  { value: "caching", label: "Caching", agents: ["performance"] },
  { value: "ai-features", label: "AI / LLM features", agents: ["research"] },
  { value: "public-api", label: "Public API / Webhooks", skills: ["restapi"], agents: ["documentation"] },
  { value: "offline", label: "Offline-first / Sync" },
  { value: "analytics", label: "Analytics / Telemetry" },
  { value: "automated-testing", label: "Automated testing", skills: ["testing", "playwright"], agents: ["qa-test"] },
  { value: "ci-cd", label: "CI/CD pipeline", skills: ["github", "git", "docker"], agents: ["devops"] },
];

export const INTEGRATION_OPTIONS: ProjectOption[] = [
  { value: "github-actions", label: "GitHub Actions", skills: ["github"] },
  { value: "telegram", label: "Telegram bot" },
  { value: "slack", label: "Slack" },
  { value: "stripe", label: "Stripe" },
  { value: "openai", label: "OpenAI / LLM APIs" },
  { value: "sentry", label: "Sentry / Error tracking" },
  { value: "sendgrid", label: "SendGrid / Mail provider" },
  { value: "twilio", label: "Twilio / SMS" },
  { value: "s3", label: "S3-compatible storage" },
  { value: "oauth-providers", label: "Google / Microsoft / Apple sign-in", skills: ["security"] },
  { value: "maps", label: "Maps / Geolocation" },
  { value: "erp-crm", label: "ERP / CRM" },
];

export const AGENT_TYPE_OPTIONS: Array<ProjectOption & { value: AgentType }> = [
  { value: "orchestrator", label: "Orchestrator", icon: "🎛️" },
  { value: "project-manager", label: "Project Manager", icon: "📋" },
  { value: "research", label: "Research", icon: "🔎" },
  { value: "business-analyst", label: "Business Analyst", icon: "📈" },
  { value: "system-architect", label: "System Architect", icon: "🏛️" },
  { value: "backend-developer", label: "Backend Developer", icon: "🧱" },
  { value: "frontend-developer", label: "Frontend Developer", icon: "🎨" },
  { value: "uiux", label: "UI/UX", icon: "🖌️" },
  { value: "database", label: "Database", icon: "🗄️" },
  { value: "devops", label: "DevOps", icon: "🚀" },
  { value: "qa-test", label: "QA / Test", icon: "🧪" },
  { value: "security", label: "Security", icon: "🔐" },
  { value: "code-reviewer", label: "Code Reviewer", icon: "👀" },
  { value: "documentation", label: "Documentation", icon: "📚" },
  { value: "debugging", label: "Debugging", icon: "🐞" },
  { value: "refactoring", label: "Refactoring", icon: "♻️" },
  { value: "performance", label: "Performance", icon: "⚡" },
  { value: "release", label: "Release", icon: "🏷️" },
];

export const REPOSITORY_ROLE_OPTIONS: Array<{ value: ProjectRepositoryRole; label: string }> = [
  { value: "primary", label: "Primary (config / source of truth)" },
  { value: "frontend", label: "Frontend" },
  { value: "backend", label: "Backend" },
  { value: "mobile", label: "Mobile" },
  { value: "infra", label: "Infrastructure / IaC" },
  { value: "docs", label: "Documentation" },
  { value: "library", label: "Shared library" },
  { value: "other", label: "Other" },
];

/** Agents every project always gets, regardless of the selection. */
export const CORE_AGENT_TYPES: AgentType[] = ["orchestrator", "project-manager", "code-reviewer", "qa-test", "debugging"];

export const ALL_AGENT_TYPES: AgentType[] = AGENT_TYPE_OPTIONS.map((a) => a.value);

export interface ProjectOptionCatalog {
  platforms: ProjectOption[];
  languages: ProjectOption[];
  frameworks: ProjectOption[];
  databases: ProjectOption[];
  deploymentTargets: ProjectOption[];
  features: ProjectOption[];
  integrations: ProjectOption[];
  agentTypes: ProjectOption[];
  repositoryRoles: Array<{ value: string; label: string }>;
  coreAgentTypes: AgentType[];
}

export function getProjectOptionCatalog(): ProjectOptionCatalog {
  return {
    platforms: PLATFORM_OPTIONS,
    languages: LANGUAGE_OPTIONS,
    frameworks: FRAMEWORK_OPTIONS,
    databases: DATABASE_OPTIONS,
    deploymentTargets: DEPLOYMENT_OPTIONS,
    features: FEATURE_OPTIONS,
    integrations: INTEGRATION_OPTIONS,
    agentTypes: AGENT_TYPE_OPTIONS,
    repositoryRoles: REPOSITORY_ROLE_OPTIONS,
    coreAgentTypes: CORE_AGENT_TYPES,
  };
}

/* ------------------------------------------------------------------ *
 * Normalization helpers
 * ------------------------------------------------------------------ */

const OPTION_INDEX: Record<keyof Omit<ProjectCapabilities, "agentTypes">, ProjectOption[]> = {
  platforms: PLATFORM_OPTIONS,
  languages: LANGUAGE_OPTIONS,
  frameworks: FRAMEWORK_OPTIONS,
  databases: DATABASE_OPTIONS,
  deploymentTargets: DEPLOYMENT_OPTIONS,
  features: FEATURE_OPTIONS,
  integrations: INTEGRATION_OPTIONS,
};

/** Accepts an array, a comma-separated string, or undefined and returns a clean, de-duplicated string list. */
export function toStringList(input: unknown, max = 50): string[] {
  let raw: unknown[] = [];
  if (Array.isArray(input)) raw = input;
  else if (typeof input === "string") raw = input.split(/[,\n;]+/);
  const out: string[] = [];
  for (const v of raw) {
    const s = String(v ?? "").trim();
    if (!s || s.length > 80) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Map a free-text/legacy value (e.g. "SQL Server", ".NET") to a catalog value when possible. */
export function canonicalOption(dimension: keyof typeof OPTION_INDEX, value: string): string {
  const v = value.trim();
  if (!v) return v;
  const lower = v.toLowerCase();
  const list = OPTION_INDEX[dimension];
  const direct = list.find((o) => o.value === lower || o.label.toLowerCase() === lower);
  if (direct) return direct.value;
  // Aliases may list several candidates; the first one that exists in this
  // dimension wins (".NET" is the C# *language* and the .NET *framework*).
  const aliases: Record<string, string[]> = {
    ".net": ["dotnet", "csharp"], "dotnet": ["dotnet", "csharp"], ".net core": ["dotnet", "csharp"], "c#": ["csharp"], "c-sharp": ["csharp"],
    "asp.net": ["aspnetcore"], "asp.net core": ["aspnetcore"], "aspnet": ["aspnetcore"],
    "node": ["nodejs-express", "javascript"], "nodejs": ["nodejs-express", "javascript"], "node.js": ["nodejs-express", "javascript"], "express": ["nodejs-express"],
    "sql server": ["sqlserver"], "mssql": ["sqlserver"], "sql-server": ["sqlserver"], "postgres": ["postgresql"], "pg": ["postgresql"], "mongo": ["mongodb"],
    "maria": ["mysql"], "mariadb": ["mysql"], "k8s": ["kubernetes"], "next": ["nextjs"], "next.js": ["nextjs"], "ts": ["typescript"], "js": ["javascript"],
    "react native": ["react-native"], "android": ["mobile-android"], "ios": ["mobile-ios"], "website": ["web"], "webapp": ["web"], "web app": ["web"],
    "golang": ["go"], "py": ["python"], "spring": ["spring-boot"], "springboot": ["spring-boot"], "vuejs": ["vue"], "nuxt": ["vue"], "sveltekit": ["svelte"],
  };
  const alias = (aliases[lower] ?? []).find((candidate) => list.some((o) => o.value === candidate));
  if (alias) return alias;
  // Keep unknown values as lowercase-hyphenated custom entries.
  return lower.replace(/[^a-z0-9.+#]+/g, "-").replace(/^-+|-+$/g, "");
}

export function normalizeAgentTypes(input: unknown): AgentType[] {
  const wanted = toStringList(input).map((s) => s.toLowerCase()) as AgentType[];
  return ALL_AGENT_TYPES.filter((t) => wanted.includes(t));
}

/** Build a fully-populated capabilities object from partial/legacy input. */
export function normalizeCapabilities(input: Partial<Record<keyof ProjectCapabilities, unknown>> | undefined, legacy?: {
  primaryLanguage?: string;
  framework?: string;
  database?: string;
  deploymentTarget?: string;
  tech?: string[];
}): ProjectCapabilities {
  const dim = (key: keyof typeof OPTION_INDEX, extra: Array<string | undefined> = []): string[] => {
    const values = [...toStringList(input?.[key]), ...extra.filter((x): x is string => !!x && x.trim().length > 0)];
    const out: string[] = [];
    for (const v of values) {
      const c = canonicalOption(key, v);
      if (c && !out.includes(c)) out.push(c);
    }
    return out;
  };
  return {
    platforms: dim("platforms"),
    languages: dim("languages", [legacy?.primaryLanguage]),
    frameworks: dim("frameworks", [legacy?.framework, ...(legacy?.tech ?? [])]),
    databases: dim("databases", [legacy?.database]),
    deploymentTargets: dim("deploymentTargets", [legacy?.deploymentTarget]),
    features: dim("features"),
    integrations: dim("integrations"),
    agentTypes: normalizeAgentTypes(input?.agentTypes),
  };
}

/** Human label for a catalog value (falls back to the raw value). */
export function optionLabel(dimension: keyof typeof OPTION_INDEX, value: string): string {
  return OPTION_INDEX[dimension].find((o) => o.value === value)?.label ?? value;
}

/**
 * Skill slugs implied by the selected capabilities (union over all options).
 * The agent manager merges these with its keyword-based relevance check.
 */
export function skillsForCapabilities(c: ProjectCapabilities): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(OPTION_INDEX) as Array<keyof typeof OPTION_INDEX>) {
    for (const v of c[key]) {
      for (const s of OPTION_INDEX[key].find((o) => o.value === v)?.skills ?? []) out.add(s);
    }
  }
  return [...out];
}

/**
 * Agent roster for a project: an explicit `agentTypes` selection wins (plus the
 * core agents); otherwise the roster is derived from the selected capabilities
 * — and when nothing is selected at all, every agent type is generated (the
 * original behaviour).
 */
export function agentTypesForProject(c: ProjectCapabilities): AgentType[] {
  if (c.agentTypes.length > 0) {
    return ALL_AGENT_TYPES.filter((t) => c.agentTypes.includes(t) || CORE_AGENT_TYPES.includes(t));
  }
  const implied = new Set<AgentType>(CORE_AGENT_TYPES);
  let anySelection = false;
  for (const key of Object.keys(OPTION_INDEX) as Array<keyof typeof OPTION_INDEX>) {
    for (const v of c[key]) {
      anySelection = true;
      for (const a of OPTION_INDEX[key].find((o) => o.value === v)?.agents ?? []) implied.add(a);
    }
  }
  if (!anySelection) return [...ALL_AGENT_TYPES];
  // A real software project always needs these regardless of the stack.
  for (const a of ["system-architect", "backend-developer", "security", "documentation", "refactoring", "release"] as AgentType[]) implied.add(a);
  if (c.databases.some((d) => d !== "none")) implied.add("database");
  if (c.platforms.some((p) => p === "web" || p.startsWith("mobile") || p === "desktop")) {
    implied.add("frontend-developer");
    implied.add("uiux");
  }
  if (c.deploymentTargets.length) implied.add("devops");
  return ALL_AGENT_TYPES.filter((t) => implied.has(t));
}

/** Legacy single-value fields derived from the capability lists (labels, human readable). */
export function legacyFieldsFromCapabilities(c: ProjectCapabilities): Pick<Project, "primaryLanguage" | "framework" | "database" | "deploymentTarget"> {
  const first = (key: keyof typeof OPTION_INDEX): string | undefined => {
    const v = c[key][0];
    return v ? optionLabel(key, v) : undefined;
  };
  return {
    primaryLanguage: first("languages"),
    framework: first("frameworks"),
    database: first("databases"),
    deploymentTarget: first("deploymentTargets"),
  };
}

/* ------------------------------------------------------------------ *
 * Repository links
 * ------------------------------------------------------------------ */

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidRepoFullName(value: string): boolean {
  return REPO_RE.test(value.trim());
}

/** Normalize a repository list; guarantees exactly one config (primary) repo when the list is non-empty. */
export function normalizeRepositories(input: unknown, fallback?: { repo?: string; branch?: string }): ProjectRepositoryLink[] {
  const raw: unknown[] = Array.isArray(input) ? input : [];
  const out: ProjectRepositoryLink[] = [];
  const now = new Date().toISOString();
  for (const item of raw) {
    let link: Partial<ProjectRepositoryLink> | undefined;
    if (typeof item === "string") link = { repo: item };
    else if (item && typeof item === "object") link = item as Partial<ProjectRepositoryLink>;
    if (!link?.repo) continue;
    const repo = String(link.repo).trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
    if (!isValidRepoFullName(repo)) continue;
    if (out.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) continue;
    const role = (REPOSITORY_ROLE_OPTIONS.some((r) => r.value === link!.role) ? link.role : out.length === 0 ? "primary" : "other") as ProjectRepositoryRole;
    out.push({
      repo,
      branch: String(link.branch ?? link.defaultBranch ?? fallback?.branch ?? "main").trim() || "main",
      role,
      isConfigRepo: !!link.isConfigRepo,
      private: link.private,
      defaultBranch: link.defaultBranch,
      htmlUrl: link.htmlUrl ?? `https://github.com/${repo}`,
      addedAt: link.addedAt ?? now,
    });
  }
  if (out.length === 0 && fallback?.repo && isValidRepoFullName(fallback.repo)) {
    out.push({ repo: fallback.repo.trim(), branch: fallback.branch || "main", role: "primary", isConfigRepo: true, htmlUrl: `https://github.com/${fallback.repo.trim()}`, addedAt: now });
  }
  if (out.length > 0 && !out.some((r) => r.isConfigRepo)) {
    const primary = out.find((r) => r.role === "primary") ?? out[0];
    primary.isConfigRepo = true;
  } else if (out.length > 0) {
    // Exactly one config repo.
    let seen = false;
    for (const r of out) {
      if (r.isConfigRepo && seen) r.isConfigRepo = false;
      if (r.isConfigRepo) seen = true;
    }
  }
  return out;
}

export function configRepoOf(repos: ProjectRepositoryLink[]): ProjectRepositoryLink | undefined {
  return repos.find((r) => r.isConfigRepo) ?? repos[0];
}

/**
 * Upgrade a stored project document (possibly written by an older version
 * without `repositories`/`capabilities`) to the current shape. Idempotent.
 */
export function hydrateProject(p: Project): Project {
  const repositories = normalizeRepositories(p.repositories, { repo: p.configRepo, branch: p.branch });
  const capabilities = normalizeCapabilities(p.capabilities, {
    primaryLanguage: p.capabilities ? undefined : p.primaryLanguage,
    framework: p.capabilities ? undefined : p.framework,
    database: p.capabilities ? undefined : p.database,
    deploymentTarget: p.capabilities ? undefined : p.deploymentTarget,
  });
  const cfg = configRepoOf(repositories);
  const legacy = legacyFieldsFromCapabilities(capabilities);
  return {
    ...p,
    repositories,
    capabilities,
    configRepo: cfg?.repo ?? p.configRepo,
    branch: cfg?.branch ?? p.branch ?? "main",
    primaryLanguage: legacy.primaryLanguage ?? p.primaryLanguage,
    framework: legacy.framework ?? p.framework,
    database: legacy.database ?? p.database,
    deploymentTarget: legacy.deploymentTarget ?? p.deploymentTarget,
  };
}
