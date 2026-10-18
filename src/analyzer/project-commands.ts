import type { ProjectCommands } from "../domain/entities.js";

export interface ProjectManifestFiles {
  files: Iterable<string>;
  packageJson?: Record<string, unknown>;
  pyprojectToml?: string;
  requirementsTxt?: string;
  goMod?: string;
  cargoToml?: string;
  composerJson?: Record<string, unknown>;
  dockerfile?: string;
}

export interface DetectedProjectStack {
  languages: string[];
  packageManager?: string;
  commands: ProjectCommands;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const scriptNames = (value: unknown): Set<string> => {
  const scripts = isRecord(value) ? value : {};
  return new Set(
    Object.entries(scripts)
      .filter(([, command]) => typeof command === "string" && command.trim())
      .map(([name]) => name),
  );
};

const lockfilePackageManager = (files: Set<string>): string | undefined => {
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  if (files.has("package-lock.json") || files.has("npm-shrinkwrap.json")) return "npm";
  return undefined;
};

function nodePackageManager(pkg: Record<string, unknown>, files: Set<string>): string {
  const declaration = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0].toLowerCase() : "";
  if (["npm", "pnpm", "yarn", "bun"].includes(declaration)) return declaration;
  return lockfilePackageManager(files) ?? "npm";
}

function nodeCommands(
  pkg: Record<string, unknown>,
  files: Set<string>,
): { packageManager: string; commands: ProjectCommands } {
  const pm = nodePackageManager(pkg, files);
  const names = scriptNames(pkg.scripts);
  const scripts = (name: string): string | undefined => {
    if (!names.has(name)) return undefined;
    if (pm === "npm") return name === "test" ? "npm test" : `npm run ${name}`;
    if (pm === "pnpm") return `pnpm run ${name}`;
    if (pm === "yarn") return `yarn ${name}`;
    return `bun run ${name}`;
  };
  let install: string;
  if (pm === "npm")
    install = files.has("package-lock.json") || files.has("npm-shrinkwrap.json") ? "npm ci" : "npm install";
  else if (pm === "pnpm") install = files.has("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : "pnpm install";
  else if (pm === "yarn") {
    const berry = files.has(".yarnrc.yml") || /yarn@(?:[2-9]|[1-9]\d)\./i.test(String(pkg.packageManager ?? ""));
    install = berry ? "yarn install --immutable" : "yarn install --frozen-lockfile";
  } else install = files.has("bun.lock") || files.has("bun.lockb") ? "bun install --frozen-lockfile" : "bun install";
  return {
    packageManager: pm,
    commands: {
      install,
      build: scripts("build"),
      test: scripts("test"),
      lint: scripts("lint"),
      start: scripts("start"),
    },
  };
}

function hasTomlSection(text: string | undefined, name: string): boolean {
  return !!text && new RegExp(`^\\s*\\[${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\]\\s*$`, "im").test(text);
}

function pythonCommands(
  files: Set<string>,
  pyproject: string | undefined,
  requirements: string | undefined,
): ProjectCommands {
  const hasUvLock = files.has("uv.lock");
  const hasPoetryLock = files.has("poetry.lock") || hasTomlSection(pyproject, "tool.poetry");
  const install = hasUvLock
    ? "uv sync --frozen"
    : hasPoetryLock
      ? "poetry install --no-interaction"
      : files.has("requirements.txt")
        ? "python -m pip install --disable-pip-version-check -r requirements.txt"
        : "python -m pip install --disable-pip-version-check -e .";
  const tests = [...files].some((p) => /(^|\/)(tests?|test_[^/]+\.py|[^/]+_test\.py)(\/|$)/i.test(p));
  const usesPytest = /(^|[\s"'])pytest([<=>~\x5b]|[\s"']|$)/i.test(`${pyproject ?? ""}\n${requirements ?? ""}`);
  const hasRuff =
    /(^|[\s"'])ruff([<=>~\x5b]|[\s"']|$)/i.test(`${pyproject ?? ""}\n${requirements ?? ""}`) ||
    files.has("ruff.toml") ||
    files.has(".ruff.toml") ||
    hasTomlSection(pyproject, "tool.ruff");
  const commands: ProjectCommands = {
    install,
    build: hasTomlSection(pyproject, "build-system") ? "python -m build" : undefined,
    test: tests || usesPytest ? "python -m pytest" : undefined,
    lint: hasRuff ? "ruff check ." : undefined,
  };
  for (const candidate of ["main.py", "app.py", "manage.py"])
    if (files.has(candidate)) {
      commands.start = candidate === "manage.py" ? "python manage.py runserver 0.0.0.0:8000" : `python ${candidate}`;
      break;
    }
  return commands;
}

function goCommands(files: Set<string>): ProjectCommands {
  return {
    install: "go mod download",
    build: "go build ./...",
    test: "go test ./...",
    lint: files.has(".golangci.yml") || files.has(".golangci.yaml") ? "golangci-lint run" : undefined,
    start: "go run .",
  };
}

function rustCommands(files: Set<string>): ProjectCommands {
  const locked = files.has("Cargo.lock") ? " --locked" : "";
  return {
    install: `cargo fetch${locked}`,
    build: `cargo build${locked}`,
    test: `cargo test${locked}`,
    lint: "cargo clippy --all-targets --all-features -- -D warnings",
    start: "cargo run",
  };
}

function composerCommands(files: Set<string>, composer: Record<string, unknown>): ProjectCommands {
  const names = scriptNames(composer.scripts);
  const run = (name: string): string | undefined => (names.has(name) ? `composer run-script ${name}` : undefined);
  return {
    install: "composer install --no-interaction --prefer-dist",
    build: run("build"),
    test: run("test") ?? (files.has("phpunit.xml") || files.has("phpunit.xml.dist") ? "vendor/bin/phpunit" : undefined),
    lint:
      run("lint") ??
      (files.has("phpstan.neon") || files.has("phpstan.neon.dist") ? "vendor/bin/phpstan analyse" : undefined),
    start: run("start") ?? (files.has("public/index.php") ? "php -S 0.0.0.0:8000 -t public" : undefined),
  };
}

/**
 * Detect likely runtime stack and conservative lifecycle commands from fixed
 * manifest names only. This function never runs a discovered command.
 */
export function detectProjectStack(input: ProjectManifestFiles): DetectedProjectStack {
  const files = new Set([...input.files].map((f) => f.replaceAll("\\", "/")));
  const languages: string[] = [];
  let packageManager: string | undefined;
  let commands: ProjectCommands = {};

  if (input.packageJson) {
    languages.push("JavaScript");
    const detected = nodeCommands(input.packageJson, files);
    packageManager = detected.packageManager;
    commands = detected.commands;
  }
  if (input.pyprojectToml !== undefined || files.has("requirements.txt")) {
    languages.push("Python");
    packageManager ??= files.has("uv.lock") ? "uv" : files.has("poetry.lock") ? "poetry" : "pip";
    commands = { ...pythonCommands(files, input.pyprojectToml, input.requirementsTxt), ...commands };
  }
  if (input.goMod !== undefined) {
    languages.push("Go");
    packageManager ??= "go modules";
    commands = { ...goCommands(files), ...commands };
  }
  if (input.cargoToml !== undefined) {
    languages.push("Rust");
    packageManager ??= "cargo";
    commands = { ...rustCommands(files), ...commands };
  }
  if (input.composerJson) {
    languages.push("PHP");
    packageManager ??= "composer";
    commands = { ...composerCommands(files, input.composerJson), ...commands };
  }
  if (input.dockerfile !== undefined || [...files].some((f) => /^dockerfile(?:\..*)?$/i.test(f))) {
    if (!languages.length) languages.push("Docker");
  }
  return { languages, packageManager, commands };
}

/** Return only configured commands whose values are valid user-editable strings. */
export function normalizeProjectCommands(value: unknown): ProjectCommands | undefined {
  if (!isRecord(value)) return undefined;
  const out: ProjectCommands = {};
  for (const key of ["install", "build", "test", "lint", "start"] as const) {
    const command = value[key];
    if (command === undefined || command === null || command === "") continue;
    if (typeof command !== "string" || command.length > 1000 || command.includes("\0"))
      throw Object.assign(new Error(`Invalid ${key} command (must be a string up to 1000 characters)`), {
        statusCode: 400,
      });
    out[key] = command.trim();
  }
  return out;
}
