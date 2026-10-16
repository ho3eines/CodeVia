/**
 * ProjectAnalyzerService — scan a folder on the server and extract structured
 * project metadata (name, description, languages, frameworks, package manager,
 * scripts, entry points, git facts, docker/CI/tests, …).
 *
 * Everything runs through `FilesystemService`, so the allowed-roots policy,
 * size limits and the sensitive-file block apply to scans too. The analyzer
 * only ever reads a fixed whitelist of manifest/config file names; secrets
 * (.env values, keys, tokens) are never opened and git remotes are redacted
 * before they leave this module.
 */

import { promises as fsp } from "node:fs";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { FilesystemService, isSensitivePath } from "../filesystem/filesystem-service.js";
import type { ProjectAnalysis, ProjectAnalysisSuggestions } from "../domain/entities.js";

export interface ProjectAnalyzerOptions {
  filesystem?: FilesystemService;
  /** Max files collected per scan (default 20000, env CODEVIA_FS_SCAN_MAX_FILES). */
  maxFiles?: number;
  /** Max directory depth per scan (default 16, env CODEVIA_FS_SCAN_MAX_DEPTH). */
  maxDepth?: number;
}

export interface ScanOptions {
  maxFiles?: number;
  maxDepth?: number;
}

/** Heavy/system directories that are never walked. */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".parcel-cache",
  "coverage",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  "target",
  ".idea",
  ".vscode",
  "tmp",
  "temp",
  "cache",
  ".cache",
  "bower_components",
  "obj",
  "bin",
]);

const EXT_LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  swift: "Swift",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  hpp: "C++",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
  dart: "Dart",
  lua: "Lua",
  scala: "Scala",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  clj: "Clojure",
  fs: "F#",
  vb: "Visual Basic",
  sql: "SQL",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ps1: "PowerShell",
  bat: "Batch",
};

/** package.json dependency name → framework/library label. */
const FRAMEWORK_BY_PACKAGE: Record<string, string> = {
  react: "React",
  "react-dom": "React",
  next: "Next.js",
  "next.js": "Next.js",
  nuxt: "Nuxt",
  vue: "Vue",
  "@angular/core": "Angular",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  preact: "Preact",
  solid_js: "Solid",
  "solid-js": "Solid",
  express: "Express",
  fastify: "Fastify",
  koa: "Koa",
  "@nestjs/core": "NestJS",
  hapi: "@hapi/hapi",
  hono: "Hono",
  "@remix-run/react": "Remix",
  "react-router-dom": "React Router",
  astro: "Astro",
  gatsby: "Gatsby",
  eleventy: "Eleventy",
  "@11ty/eleventy": "Eleventy",
  electron: "Electron",
  "@tauri-apps/api": "Tauri",
  "react-native": "React Native",
  expo: "Expo",
  prisma: "Prisma",
  "@prisma/client": "Prisma",
  typeorm: "TypeORM",
  mongoose: "Mongoose",
  "drizzle-orm": "Drizzle",
  sequelize: "Sequelize",
  typegoose: "Typegoose",
  redis: "Redis",
  ioredis: "Redis",
  "socket.io": "Socket.IO",
  ws: "ws",
  graphql: "GraphQL",
  apollo_server: "Apollo",
  "apollo-server": "Apollo",
  "@apollo/server": "Apollo",
  tailwindcss: "Tailwind CSS",
  bootstrap: "Bootstrap",
  vite: "Vite",
  webpack: "Webpack",
  rollup: "Rollup",
  esbuild: "esbuild",
  turbo: "Turborepo",
  three: "Three.js",
  d3: "D3.js",
  lodash: "Lodash",
  rxjs: "RxJS",
  zustand: "Zustand",
  "@reduxjs/toolkit": "Redux Toolkit",
  jotai: "Jotai",
  commander: "Commander",
  yargs: "Yargs",
  inquirer: "Inquirer",
  chalk: "Chalk",
  zod: "Zod",
};

/** Python dependency → framework/library label. */
const FRAMEWORK_BY_PYTHON: Record<string, string> = {
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  "fastapi-sqlalchemy": "FastAPI",
  tornado: "Tornado",
  bottle: "Bottle",
  pyramid: "Pyramid",
  sanic: "Sanic",
  starlette: "Starlette",
  scrapy: "Scrapy",
  celery: "Celery",
  sqlalchemy: "SQLAlchemy",
  "django-rest-framework": "Django REST Framework",
  djangorestframework: "Django REST Framework",
  pydantic: "Pydantic",
  numpy: "NumPy",
  pandas: "Pandas",
  torch: "PyTorch",
  tensorflow: "TensorFlow",
  transformers: "Transformers",
};

/** Cargo dependency → framework/library label. */
const FRAMEWORK_BY_CARGO: Record<string, string> = {
  axum: "Axum",
  actix_web: "Actix Web",
  "actix-web": "Actix Web",
  rocket: "Rocket",
  warp: "Warp",
  tokio: "Tokio",
  hyper: "Hyper",
  serde: "Serde",
  sqlx: "SQLx",
  diesel: "Diesel",
  clap: "Clap",
};

/** go.mod require → framework/library label. */
const FRAMEWORK_BY_GO: Record<string, string> = {
  "github.com/gin-gonic/gin": "Gin",
  "github.com/labstack/echo": "Echo",
  "github.com/gofiber/fiber": "Fiber",
  "github.com/go-chi/chi": "Chi",
  "github.com/beego/beego": "Beego",
  "github.com/gorilla/mux": "Gorilla Mux",
  "google.golang.org/grpc": "gRPC",
};

/** Lockfile (root level) → package manager, in priority order. */
const LOCKFILE_PACKAGE_MANAGER: Array<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["deno.lock", "deno"],
  ["poetry.lock", "poetry"],
  ["uv.lock", "uv"],
  ["Pipfile.lock", "pipenv"],
  ["requirements.txt", "pip"],
  ["Cargo.lock", "cargo"],
  ["go.sum", "go modules"],
  ["composer.lock", "composer"],
  ["Gemfile.lock", "bundler"],
  ["mix.lock", "mix"],
  ["pubspec.lock", "pub"],
];

/** Recognized config file basenames reported in `configFiles`. */
const CONFIG_FILE_NAMES = new Set([
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "webpack.config.js",
  "webpack.config.ts",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "nuxt.config.ts",
  "nuxt.config.js",
  "svelte.config.js",
  "tailwind.config.js",
  "tailwind.config.ts",
  "tailwind.config.cjs",
  "postcss.config.js",
  "postcss.config.cjs",
  "babel.config.js",
  ".babelrc",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierrc.json",
  "prettier.config.js",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
  "vitest.config.js",
  "playwright.config.ts",
  "cypress.config.js",
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  "Makefile",
  "CMakeLists.txt",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "Gemfile",
  "mix.exs",
  "pubspec.yaml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "go.work",
  "lerna.json",
  "turbo.json",
  "nx.json",
  "pnpm-workspace.yaml",
]);

const CI_MARKERS: Array<[string, string]> = [
  [".github/workflows", "github-actions"],
  [".gitlab-ci.yml", "gitlab-ci"],
  [".circleci/config.yml", "circleci"],
  ["Jenkinsfile", "jenkins"],
  [".travis.yml", "travis-ci"],
  ["azure-pipelines.yml", "azure-pipelines"],
  ["azure-pipelines.yaml", "azure-pipelines"],
  [".drone.yml", "drone"],
  ["cloudbuild.yaml", "cloud-build"],
  [".cloudbuilds", "cloud-build"],
];

/** Files whose presence implies a test framework (plus dependency detection). */
const TEST_FILE_MARKERS: Array<[string, string]> = [
  ["vitest.config.ts", "Vitest"],
  ["vitest.config.js", "Vitest"],
  ["jest.config.js", "Jest"],
  ["jest.config.ts", "Jest"],
  ["playwright.config.ts", "Playwright"],
  ["playwright.config.js", "Playwright"],
  ["cypress.config.js", "Cypress"],
  ["cypress.config.ts", "Cypress"],
  ["pytest.ini", "pytest"],
  ["tox.ini", "tox"],
  [".mocharc.yml", "Mocha"],
  [".mocharc.json", "Mocha"],
  ["phpunit.xml", "PHPUnit"],
  ["phpunit.xml.dist", "PHPUnit"],
];

const TEST_PACKAGE_HINTS: Record<string, string> = {
  vitest: "Vitest",
  jest: "Jest",
  mocha: "Mocha",
  "@playwright/test": "Playwright",
  playwright: "Playwright",
  cypress: "Cypress",
  "@testing-library/react": "Testing Library",
  ava: "Ava",
  tap: "tap",
  uvu: "uvu",
  "node:test": "node:test",
};

const TEST_PYTHON_HINTS: Record<string, string> = {
  pytest: "pytest",
  "pytest-cov": "pytest",
  nose: "nose",
  tox: "tox",
  hypothesis: "Hypothesis",
};

const LICENSE_PATTERNS: Array<[RegExp, string]> = [
  [/\bMIT\b/i, "MIT"],
  [/Apache License(?:\s*,?\s*Version\s*2\.0)?/i, "Apache-2.0"],
  [/GNU (?: Lesser |Affero )?General Public License/i, "GPL"],
  [/\bBSD(?:-[23]-Clause)?\b/i, "BSD"],
  [/\bISC\b/i, "ISC"],
  [/Mozilla Public License/i, "MPL-2.0"],
  [/\bUnlicense\b/i, "Unlicense"],
  [/Creative Commons/i, "CC"],
];

/** Candidate entry points, in priority order (checked against the file set). */
const ENTRY_POINT_CANDIDATES = [
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/main.ts",
  "src/main.tsx",
  "src/main.js",
  "src/app.ts",
  "src/app.js",
  "src/server.ts",
  "src/server.js",
  "index.ts",
  "index.tsx",
  "index.js",
  "index.mjs",
  "main.ts",
  "main.js",
  "server.js",
  "app.py",
  "main.py",
  "manage.py",
  "src/main.rs",
  "main.go",
  "cmd/server/main.go",
  "public/index.html",
  "index.html",
];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Strip credentials (https://user:pass@…) from a git remote URL. */
export function redactGitUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@:]+(?::[^/@]*)?@/i, "$1").replace(/^(ssh:\/\/)[^/@:]+(?::[^/@]*)?@/i, "$1");
}

/** Extract the first meaningful paragraph from a README as a description. */
function descriptionFromReadme(text: string): string | undefined {
  const stripped = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#-]/g, " ");
  const paragraphs = stripped
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 40);
  const first = paragraphs[0];
  return first ? first.slice(0, 240) : undefined;
}

function licenseFromText(text: string): string | undefined {
  for (const [re, label] of LICENSE_PATTERNS) {
    if (re.test(text)) return label;
  }
  return undefined;
}

/** Parse a small JSON document defensively. */
function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort TOML string-field read: `name = "value"` inside an optional section. */
function tomlStringField(text: string, section: RegExp | null, field: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let inSection = !section;
  for (const line of lines) {
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) {
      inSection = !section || section.test(sec[1]);
      continue;
    }
    if (!inSection) continue;
    const m = line.match(new RegExp(`^\\s*${field}\\s*=\\s*"([^"]*)"`));
    if (m && m[1]) return m[1];
  }
  return undefined;
}

/** Keys of a TOML table section (`[dependencies]`, `[tool.poetry.dependencies]`, …). */
function tomlSectionKeys(text: string, section: RegExp): string[] {
  const keys: string[] = [];
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) {
      inSection = section.test(sec[1]);
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

interface WalkResult {
  files: Set<string>;
  truncated: boolean;
  warnings: string[];
  symlinkCount: number;
  topEntries: string[];
}

export class ProjectAnalyzerService {
  private readonly fs: FilesystemService;
  private readonly defaultMaxFiles: number;
  private readonly defaultMaxDepth: number;

  constructor(options: ProjectAnalyzerOptions = {}) {
    this.fs = options.filesystem ?? new FilesystemService();
    this.defaultMaxFiles = options.maxFiles ?? envInt("CODEVIA_FS_SCAN_MAX_FILES", 20000);
    this.defaultMaxDepth = options.maxDepth ?? envInt("CODEVIA_FS_SCAN_MAX_DEPTH", 16);
  }

  async scan(rootPath: string, options: ScanOptions = {}): Promise<ProjectAnalysis> {
    const maxFiles = options.maxFiles ?? this.defaultMaxFiles;
    const maxDepth = options.maxDepth ?? this.defaultMaxDepth;
    const resolvedRoot = await this.analyzerSafeRoot(rootPath);

    const walk = await this.walk(resolvedRoot, maxFiles, maxDepth);
    const warnings = walk.warnings;
    const has = (rel: string): boolean => walk.files.has(rel);

    // ---------- manifests ----------
    const pkg = await this.readJson(resolvedRoot, "package.json");
    const pyproject = await this.readText(resolvedRoot, "pyproject.toml");
    const cargo = await this.readText(resolvedRoot, "Cargo.toml");
    const gomod = await this.readText(resolvedRoot, "go.mod");
    const composer = await this.readJson(resolvedRoot, "composer.json");

    // ---------- name / description ----------
    const folderName = path.basename(resolvedRoot) || resolvedRoot;
    let name: string | undefined = (pkg && str(pkg.name)) || undefined;
    if (!name && pyproject) {
      name = tomlStringField(pyproject, /^project$/i, "name") ?? tomlStringField(pyproject, /^tool\.poetry$/i, "name");
    }
    if (!name && cargo) name = tomlStringField(cargo, /^package$/i, "name");
    if (!name && gomod) {
      const m = gomod.match(/^module\s+(\S+)/m);
      name = m ? m[1].split("/").pop() : undefined;
    }
    if (!name && composer) name = str(composer.name)?.split("/").pop() || undefined;
    // Last resort per spec: the folder name itself.
    if (!name) name = folderName;

    let description: string | undefined = (pkg && str(pkg.description)) || undefined;
    if (!description && composer) description = str(composer.description) || undefined;
    if (!description) {
      const readme = await this.readReadme(resolvedRoot);
      if (readme) description = descriptionFromReadme(readme);
    }

    // ---------- languages ----------
    const langCounts = new Map<string, number>();
    for (const file of walk.files) {
      const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
      const lang = EXT_LANGUAGES[ext];
      if (lang && file.lastIndexOf(".") > 0) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
    }
    const languages = [...langCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([lang]) => lang);

    // ---------- frameworks / libraries ----------
    const frameworks = new Set<string>();
    const dependencies: string[] = [];
    const devDependencies: string[] = [];
    if (pkg) {
      const deps = recordField(pkg.dependencies);
      const devDeps = recordField(pkg.devDependencies) ?? recordField(pkg.dev_dependencies);
      for (const dep of Object.keys(deps ?? {})) {
        dependencies.push(dep);
        const label = FRAMEWORK_BY_PACKAGE[dep];
        if (label) frameworks.add(label);
      }
      for (const dep of Object.keys(devDeps ?? {})) {
        devDependencies.push(dep);
        const label = FRAMEWORK_BY_PACKAGE[dep];
        if (label && !TEST_PACKAGE_HINTS[dep]) frameworks.add(label);
      }
    }
    let pythonDeps: string[] = [];
    if (pyproject) {
      pythonDeps = [
        ...tomlSectionKeys(pyproject, /^(project\.?dependencies|tool\.poetry\.dependencies)$/i),
        ...matchQuotedList(pyproject, /^dependencies\s*=\s*\[/m),
      ];
      const unique = new Set(pythonDeps.map((d) => d.toLowerCase().replace(/[-_]/g, "-")));
      for (const dep of unique) {
        const label = FRAMEWORK_BY_PYTHON[dep];
        if (label) frameworks.add(label);
      }
    }
    if (cargo) {
      for (const dep of tomlSectionKeys(cargo, /^dependencies$/i)) {
        const label = FRAMEWORK_BY_CARGO[dep];
        if (label) frameworks.add(label);
      }
    }
    if (gomod) {
      for (const m of gomod.matchAll(/^\s*(?:require\s+)?(?:_\s+)?([\w./-]+)\s+v[\w.-]+/gm)) {
        const label = FRAMEWORK_BY_GO[m[1]];
        if (label) frameworks.add(label);
      }
    }
    // Marker files add frameworks even without manifests (e.g. plain Next.js repo).
    for (const file of walk.files) {
      if (file === "next.config.js" || file === "next.config.mjs" || file === "next.config.ts")
        frameworks.add("Next.js");
      if (file === "angular.json") frameworks.add("Angular");
      if (file.startsWith("vite.config.")) frameworks.add("Vite");
      if (file === "svelte.config.js") frameworks.add("Svelte");
      if (file === "nuxt.config.ts" || file === "nuxt.config.js") frameworks.add("Nuxt");
      if (file === "tailwind.config.js" || file === "tailwind.config.ts" || file === "tailwind.config.cjs")
        frameworks.add("Tailwind CSS");
    }

    // ---------- package manager ----------
    let packageManager: string | undefined = pkg && str(pkg.packageManager)?.split("@")[0];
    if (!packageManager) {
      for (const [lockfile, pm] of LOCKFILE_PACKAGE_MANAGER) {
        if (has(lockfile)) {
          packageManager = pm;
          break;
        }
      }
    }
    if (!packageManager) {
      if (pkg) packageManager = "npm";
      else if (pyproject) packageManager = tomlSectionKeys(pyproject, /^tool\.poetry$/i).length ? "poetry" : "pip";
      else if (cargo) packageManager = "cargo";
      else if (gomod) packageManager = "go modules";
      else if (composer) packageManager = "composer";
    }

    // ---------- monorepo / workspaces ----------
    let isMonorepo = false;
    const workspaces: string[] = [];
    if (pkg) {
      const ws = pkg.workspaces;
      const patterns = Array.isArray(ws) ? (ws as unknown[]) : recordField(ws)?.packages;
      if (Array.isArray(patterns)) {
        isMonorepo = true;
        for (const p of patterns) if (typeof p === "string") workspaces.push(p);
      }
    }
    if (has("pnpm-workspace.yaml")) {
      isMonorepo = true;
      workspaces.push("packages/*");
    }
    if (has("lerna.json") || has("turbo.json") || has("nx.json") || has("go.work")) isMonorepo = true;
    if (cargo && /^\s*\[workspace\]/m.test(cargo)) isMonorepo = true;

    // ---------- scripts ----------
    const scripts: Record<string, string> = {};
    if (pkg) {
      const s = recordField(pkg.scripts);
      if (s) {
        for (const [k, v] of Object.entries(s)) if (typeof v === "string") scripts[k] = v;
      }
    }
    if (pyproject) {
      const scriptKeys = tomlSectionKeys(pyproject, /^(project\.scripts|tool\.poetry\.scripts)$/i);
      for (const k of scriptKeys) {
        const v = tomlStringField(pyproject, /^(project\.scripts|tool\.poetry\.scripts)$/i, k);
        if (v) scripts[k] = v;
      }
    }

    // ---------- entry points ----------
    const entryPoints: string[] = [];
    if (pkg) {
      for (const field of ["main", "module", "browser"]) {
        const v = str(pkg[field]);
        if (v) entryPoints.push(v);
      }
      const bin = pkg.bin;
      const binNames =
        typeof bin === "string"
          ? [bin]
          : Array.isArray(bin)
            ? (bin as unknown[])
            : Object.values(recordField(bin) ?? {});
      for (const b of binNames) if (typeof b === "string" && !entryPoints.includes(b)) entryPoints.push(b);
      const exportsField = recordField(pkg.exports);
      const dot = recordField(exportsField?.["."]);
      const exportMain = str(dot?.default ?? dot?.import ?? dot?.require);
      if (exportMain && !entryPoints.includes(exportMain)) entryPoints.push(exportMain);
    }
    for (const candidate of ENTRY_POINT_CANDIDATES) {
      if (entryPoints.length >= 6) break;
      if (has(candidate) && !entryPoints.includes(candidate)) entryPoints.push(candidate);
    }

    // ---------- config files ----------
    const configFiles = [...walk.files]
      .filter((f) => CONFIG_FILE_NAMES.has(f))
      .sort()
      .slice(0, 200);

    // ---------- env file NAMES (never values) ----------
    const envFiles = [...walk.files]
      .filter((f) => isSensitivePath(f) && (f.startsWith(".env") || f.endsWith(".env")))
      .sort()
      .slice(0, 50);

    // ---------- license ----------
    let license: string | undefined = pkg && str(pkg.license) ? String(pkg.license) : undefined;
    if (!license && composer && str(composer.license)) license = str(composer.license) || undefined;
    if (!license) {
      const text = await this.readLicense(resolvedRoot);
      if (text) license = licenseFromText(text);
    }

    // ---------- git ----------
    const git = await this.gitFacts(resolvedRoot);

    // ---------- docker / ci / tests ----------
    const docker = [...walk.files].some(
      (f) =>
        /^dockerfile(\..*)?$/i.test(f) ||
        /^docker-compose[\w.-]*\.ya?ml$/i.test(f) ||
        /^compose[\w.-]*\.ya?ml$/i.test(f),
    );
    const ci: string[] = [];
    for (const [marker, label] of CI_MARKERS) {
      const hit =
        marker.endsWith("/config.yml") || marker.includes("/workflows")
          ? [...walk.files].some((f) => f.startsWith(marker + "/"))
          : has(marker);
      if (hit && !ci.includes(label)) ci.push(label);
    }
    const tests = new Set<string>();
    for (const [marker, label] of TEST_FILE_MARKERS) if (has(marker)) tests.add(label);
    const allDeps = [...dependencies, ...devDependencies].map((d) => d.toLowerCase());
    for (const dep of allDeps) {
      const label = TEST_PACKAGE_HINTS[dep];
      if (label) tests.add(label);
    }
    for (const dep of pythonDeps.map((d) => d.toLowerCase())) {
      const label = TEST_PYTHON_HINTS[dep.replace(/[-_]/g, "-")];
      if (label) tests.add(label);
    }
    if ([...walk.files].some((f) => /_test\.go$/.test(f))) tests.add("go test");
    if (walk.files.has("tests/main.rs") || [...walk.files].some((f) => f.startsWith("tests/") && f.endsWith(".rs")))
      tests.add("cargo test");
    if ([...walk.files].some((f) => /\.test\.[jt]sx?$/.test(f) || /\.spec\.[jt]sx?$/.test(f))) {
      if (!tests.has("Vitest") && !tests.has("Jest")) tests.add("test files");
    }
    if ([...walk.files].some((f) => /^tests?\/.+\.(py|ts|js)$/.test(f)) && tests.size === 0) tests.add("tests/");

    // ---------- warnings from the walk ----------
    if (walk.truncated) warnings.push(`Scan stopped at the file limit (${maxFiles}) — results may be partial`);
    if (walk.symlinkCount > 0) warnings.push(`${walk.symlinkCount} symlink(s) skipped (never followed)`);
    for (const manifest of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
      if (has(manifest) && !(pkg || pyproject || cargo || gomod)) warnings.push(`Could not parse ${manifest}`);
    }

    const suggestions = this.suggest({
      folderName,
      name,
      description,
      languages,
      frameworks: [...frameworks],
      packageManager,
      scripts,
      docker,
      isMonorepo,
      hasBuild: !!scripts.build || !!cargo || has("Dockerfile"),
    });

    return {
      rootPath: resolvedRoot,
      name,
      description,
      languages,
      frameworks: [...frameworks].slice(0, 10),
      packageManager,
      scripts,
      dependencies: dependencies.length ? dependencies.slice(0, 200) : undefined,
      devDependencies: devDependencies.length ? devDependencies.slice(0, 200) : undefined,
      isMonorepo,
      workspaces: workspaces.length ? workspaces : undefined,
      entryPoints: entryPoints.length ? entryPoints.slice(0, 6) : undefined,
      configFiles: configFiles.length ? configFiles : undefined,
      envFiles: envFiles.length ? envFiles : undefined,
      license,
      git,
      docker,
      ci,
      tests: [...tests],
      warnings: [...new Set(warnings)].slice(0, 20),
      suggestions,
      scannedAt: new Date().toISOString(),
      fileCount: walk.files.size,
      truncated: walk.truncated,
    };
  }

  /** ---------- internals ---------- */

  /** Validate the scan root: must exist, be a directory, and be inside allowed roots. */
  private async analyzerSafeRoot(rootPath: string): Promise<string> {
    const stat = await this.fs.statPath(rootPath);
    if (stat.kind === "symlink" || stat.kind === "other" || stat.kind === "file") {
      // statPath follows symlinks; a symlink *to* a directory reports "symlink".
      if (stat.kind === "symlink") {
        const real = await this.fs.isDirectory(rootPath);
        if (!real) {
          const err = new Error(`Scan root is not a directory: ${path.basename(rootPath)}`);
          Object.assign(err, { statusCode: 400 });
          throw err;
        }
        return stat.path;
      }
      const err = new Error(`Scan root is not a directory: ${path.basename(rootPath)}`);
      Object.assign(err, { statusCode: 400 });
      throw err;
    }
    if (!stat.readable) {
      const err = new Error(`Scan root is not readable: ${path.basename(rootPath)}`);
      Object.assign(err, { statusCode: 403 });
      throw err;
    }
    return stat.path;
  }

  private async walk(root: string, maxFiles: number, maxDepth: number): Promise<WalkResult> {
    const files = new Set<string>();
    const warnings: string[] = [];
    let truncated = false;
    let symlinkCount = 0;
    const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: "", depth: 0 }];

    while (queue.length > 0) {
      const { dir, rel, depth } = queue.shift()!;
      let dirents;
      try {
        dirents = await this.rawReaddir(dir);
      } catch (err) {
        warnings.push(`Could not read directory ${rel || "."}: ${reason(err)}`);
        continue;
      }
      for (const d of dirents) {
        if (files.size >= maxFiles) {
          truncated = true;
          queue.length = 0;
          break;
        }
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        if (d.isSymbolicLink()) {
          symlinkCount++;
          continue;
        }
        if (d.isDirectory()) {
          if (IGNORE_DIRS.has(d.name)) continue;
          if (depth + 1 > maxDepth) {
            warnings.push(`Depth limit (${maxDepth}) reached at ${childRel} — subtree skipped`);
            continue;
          }
          queue.push({ dir: path.join(dir, d.name), rel: childRel, depth: depth + 1 });
        } else if (d.isFile()) {
          files.add(childRel);
        }
      }
    }
    return { files, truncated, warnings, symlinkCount, topEntries: [] };
  }

  /** Raw readdir — the root was already validated; children are walked by name only. */
  private async rawReaddir(dir: string): Promise<Dirent[]> {
    return fsp.readdir(dir, { withFileTypes: true });
  }

  private async readText(root: string, rel: string): Promise<string | undefined> {
    try {
      return (await this.fs.readFile(path.join(root, rel))).content;
    } catch {
      return undefined; // missing or blocked — the walk result already reflects presence
    }
  }

  private async readJson(root: string, rel: string): Promise<Record<string, unknown> | undefined> {
    const text = await this.readText(root, rel);
    return text ? parseJson(text) : undefined;
  }

  private async readReadme(root: string): Promise<string | undefined> {
    for (const name of ["README.md", "readme.md", "README.markdown", "README.rst", "README.txt", "README"]) {
      const text = await this.readText(root, name);
      if (text) return text.slice(0, 8192);
    }
    return undefined;
  }

  private async readLicense(root: string): Promise<string | undefined> {
    for (const name of ["LICENSE", "LICENCE", "LICENSE.md", "LICENSE.txt", "COPYING"]) {
      const text = await this.readText(root, name);
      if (text) return text.slice(0, 512);
    }
    return undefined;
  }

  /** Git facts read straight from `.git` — no subprocess, no secrets. */
  private async gitFacts(root: string): Promise<ProjectAnalysis["git"]> {
    const gitDir = path.join(root, ".git");
    try {
      await fsp.access(gitDir);
    } catch {
      return undefined;
    }
    const out: NonNullable<ProjectAnalysis["git"]> = {};
    // branch (HEAD may be detached)
    try {
      const head = (await fsp.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
      const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      out.branch = m ? m[1] : head.slice(0, 12) || undefined;
    } catch {
      /* ignore */
    }
    // remote (credentials redacted)
    try {
      const config = await fsp.readFile(path.join(gitDir, "config"), "utf8");
      const remoteMatch =
        config.match(/\[remote\s+"origin"\][^[]*?url\s*=\s*(\S+)/s) ??
        config.match(/\[remote\s+"[^"]+"\][^[]*?url\s*=\s*(\S+)/s);
      if (remoteMatch) out.remote = redactGitUrl(remoteMatch[1]);
    } catch {
      /* ignore */
    }
    // last commit: ref file → packed-refs; subject from the reflog when present
    try {
      let sha: string | undefined;
      if (out.branch) {
        try {
          sha = (await fsp.readFile(path.join(gitDir, "refs", "heads", ...out.branch.split("/")), "utf8")).trim();
        } catch {
          const packed = await fsp.readFile(path.join(gitDir, "packed-refs"), "utf8");
          const m = packed.match(new RegExp(`^([0-9a-f]{40}) refs/heads/${escapeRegExp(out.branch)}$`, "m"));
          sha = m?.[1];
        }
      }
      let subject: string | undefined;
      try {
        const log = await fsp.readFile(path.join(gitDir, "logs", "HEAD"), "utf8");
        const lines = log.trim().split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = lines[i].match(/\tcommit[^:]*:\s*(.+)$/);
          if (m) {
            subject = m[1].trim();
            break;
          }
        }
      } catch {
        /* no reflog */
      }
      if (sha || subject) {
        out.lastCommit = [sha?.slice(0, 7), subject].filter(Boolean).join(" ") || undefined;
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  private suggest(input: {
    folderName: string;
    name?: string;
    description?: string;
    languages: string[];
    frameworks: string[];
    packageManager?: string;
    scripts: Record<string, string>;
    docker: boolean;
    isMonorepo: boolean;
    hasBuild: boolean;
  }): ProjectAnalysisSuggestions {
    const s: ProjectAnalysisSuggestions = {};
    s.name = input.name ?? input.folderName;
    s.description = input.description;
    s.language = input.languages[0];
    s.framework = input.frameworks[0];
    s.packageManager = input.packageManager;

    const f = input.frameworks;
    const l = input.languages;
    if (
      f.includes("Next.js") ||
      f.includes("Nuxt") ||
      f.includes("Astro") ||
      f.includes("Gatsby") ||
      f.includes("Remix")
    )
      s.type = "web";
    else if (f.includes("React Native") || f.includes("Expo")) s.type = "mobile";
    else if (f.includes("Electron") || f.includes("Tauri")) s.type = "desktop";
    else if (
      f.includes("Express") ||
      f.includes("Fastify") ||
      f.includes("NestJS") ||
      f.includes("FastAPI") ||
      f.includes("Django") ||
      f.includes("Flask") ||
      f.includes("Axum") ||
      f.includes("Actix Web") ||
      f.includes("Gin")
    )
      s.type = "api";
    else if (l.includes("HTML")) s.type = "web";
    else if (Object.keys(input.scripts).some((k) => k === "bin" || k.startsWith("cli"))) s.type = "cli";
    else if (input.languages.length > 0) s.type = "application";

    const pm = input.packageManager;
    const run = (script: string): string | undefined => {
      if (!input.scripts[script]) return undefined;
      switch (pm) {
        case "pnpm":
          return `pnpm ${script}`;
        case "yarn":
          return `yarn ${script}`;
        case "bun":
          return `bun run ${script}`;
        case "npm":
        case undefined:
          return `npm run ${script}`;
        case "poetry":
          return `poetry run ${script}`;
        case "cargo":
          return `cargo ${script === "build" ? "build" : script}`;
        default:
          return input.scripts[script];
      }
    };
    s.devCommand = run("dev");
    s.buildCommand = run("build");
    s.startCommand = run("start") ?? (input.hasBuild && pm === "npm" ? "node dist/index.js" : undefined);
    s.testCommand = run("test");

    const tags = new Set<string>();
    for (const lang of input.languages.slice(0, 3)) tags.add(lang.toLowerCase());
    for (const fw of input.frameworks.slice(0, 4)) tags.add(fw.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    if (input.docker) tags.add("docker");
    if (input.isMonorepo) tags.add("monorepo");
    if (pm) tags.add(pm);
    s.tags = [...tags].slice(0, 10);

    return s;
  }
}

/** ---------- small utilities ---------- */

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function recordField(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reason(err: unknown): string {
  const e = err as { code?: string };
  if (e?.code === "EACCES" || e?.code === "EPERM") return "permission denied";
  return err instanceof Error ? err.message : String(err);
}

/** Extract quoted strings from a TOML array assignment (`dependencies = ["a", "b"]`). */
function matchQuotedList(text: string, re: RegExp): string[] {
  const m = text.match(re);
  if (!m) return [];
  const listPart = text.slice(m.index ?? 0).split("]")[0];
  return [...listPart.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}
