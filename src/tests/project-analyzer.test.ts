import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { FilesystemService } from "../filesystem/filesystem-service.js";
import { ProjectAnalyzerService } from "../analyzer/project-analyzer.js";

/* ------------------------------------------------------------------ *
 * ProjectAnalyzerService — folder scanning:
 *   - manifests (package.json / pyproject / Cargo / go.mod / composer)
 *   - languages, frameworks, package manager, monorepo, scripts,
 *     entry points, config files, license, docker, CI, tests
 *   - git facts without secrets (branch, redacted remote, last commit)
 *   - secret canaries never leak into the analysis JSON
 *   - scan budgets (maxFiles) and permission warnings
 * ------------------------------------------------------------------ */

let root: string;
let analyzer: ProjectAnalyzerService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "analyzer-"));
  const fs = new FilesystemService({ allowedRoots: [root], maxFileSizeBytes: 64 * 1024 });
  analyzer = new ProjectAnalyzerService({ filesystem: fs });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function w(rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

const isRoot = () => (typeof process.getuid === "function" ? process.getuid() === 0 : false);

describe("Node/TypeScript project", () => {
  beforeEach(() => {
    w(
      "package.json",
      JSON.stringify(
        {
          name: "shop-backend",
          description: "A small shop backend used for analyzer tests",
          main: "src/index.ts",
          scripts: { dev: "tsx src/index.ts", build: "tsc -p .", start: "node dist/index.js", test: "vitest run" },
          dependencies: { express: "^4.0.0", react: "^18.0.0" },
          devDependencies: { vitest: "^2.0.0" },
        },
        null,
        2,
      ),
    );
    w("package-lock.json", "{}");
    w(
      "README.md",
      "# Shop Backend\n\nA longer description paragraph for the analyzer to pick up as the project description.\n",
    );
    w("LICENSE", "MIT License\n\nCopyright (c) 2026");
    w("src/index.ts", "export {};".repeat(50));
    w("src/routes/users.ts", "export {};".repeat(30));
    w("src/app.tsx", "export {};".repeat(20));
    w("tsconfig.json", "{}");
    w("vitest.config.ts", "export default {};");
    w("Dockerfile", "FROM node:22");
    w("docker-compose.yml", "services: {}");
    w(".github/workflows/ci.yml", "name: CI");
    w("tests/users.test.ts", "it('works', () => {})");
    w(".env", "CANARY_ENV_VALUE=hunter2");
    w("id_rsa", "CANARY_PRIVATE_KEY");
  });

  it("detects name, description, language, scripts", async () => {
    const a = await analyzer.scan(root);
    expect(a.name).toBe("shop-backend");
    expect(a.description).toMatch(/shop backend/i);
    expect(a.languages[0]).toBe("TypeScript");
    expect(a.scripts).toMatchObject({ dev: "tsx src/index.ts", build: "tsc -p ." });
  });

  it("detects frameworks from dependencies", async () => {
    const a = await analyzer.scan(root);
    expect(a.frameworks).toContain("React");
    expect(a.frameworks).toContain("Express");
  });

  it("detects the package manager from lockfiles", async () => {
    const a = await analyzer.scan(root);
    expect(a.packageManager).toBe("npm");
  });

  it("detects entry points from package.json and common files", async () => {
    const a = await analyzer.scan(root);
    expect(a.entryPoints).toContain("src/index.ts");
  });

  it("detects config files, license, docker, CI and tests", async () => {
    const a = await analyzer.scan(root);
    expect(a.configFiles).toContain("tsconfig.json");
    expect(a.license).toBe("MIT");
    expect(a.docker).toBe(true);
    expect(a.ci).toContain("github-actions");
    expect(a.tests).toContain("Vitest");
  });

  it("collects env file NAMES but never their values", async () => {
    const a = await analyzer.scan(root);
    expect(a.envFiles).toContain(".env");
    expect(JSON.stringify(a)).not.toContain("CANARY_ENV_VALUE");
    expect(JSON.stringify(a)).not.toContain("CANARY_PRIVATE_KEY");
  });

  it("fills suggestions with commands for the detected manager", async () => {
    const a = await analyzer.scan(root);
    expect(a.suggestions.name).toBe("shop-backend");
    expect(a.suggestions.language).toBe("TypeScript");
    expect(a.suggestions.buildCommand).toBe("npm run build");
    expect(a.suggestions.devCommand).toBe("npm run dev");
    expect(a.suggestions.type).toBe("api");
    expect(a.suggestions.tags).toContain("docker");
  });

  it("ignores heavy folders (node_modules, dist, .git objects are not scanned as files)", async () => {
    w("node_modules/dep/index.js", "x".repeat(100));
    w("dist/bundle.js", "x".repeat(100));
    w("coverage/lcov.info", "x".repeat(100));
    const a = await analyzer.scan(root);
    expect(a.fileCount).toBe(15); // 15 real files; node_modules/dist/coverage are ignored
    expect(JSON.stringify(a)).not.toContain("node_modules");
  });
});

describe("pnpm monorepo", () => {
  beforeEach(() => {
    w("package.json", JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*"] }));
    w("pnpm-lock.yaml", "");
    w("packages/web/package.json", JSON.stringify({ name: "@mono/web" }));
    w("packages/web/src/main.tsx", "export {};");
  });

  it("detects workspaces and pnpm", async () => {
    const a = await analyzer.scan(root);
    expect(a.isMonorepo).toBe(true);
    expect(a.workspaces).toContain("packages/*");
    expect(a.packageManager).toBe("pnpm");
    expect(a.suggestions.buildCommand).toBeUndefined(); // no build script at root
  });
});

describe("Python (poetry) project", () => {
  beforeEach(() => {
    w(
      "pyproject.toml",
      [
        "[tool.poetry]",
        'name = "data-pipeline"',
        'version = "0.1.0"',
        "",
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'fastapi = "^0.110"',
        'pytest = "^8.0"',
        "",
        "[tool.poetry.scripts]",
        'pipeline = "data_pipeline.main:run"',
        "",
      ].join("\n"),
    );
    w("poetry.lock", "");
    w("README.md", "# Data Pipeline\n\nSome longer description of the data pipeline project goes right here.\n");
    w("data_pipeline/main.py", "def run():\n    pass\n");
    w("tests/test_main.py", "def test_run():\n    pass\n");
  });

  it("detects name, language, framework, package manager and tests", async () => {
    const a = await analyzer.scan(root);
    expect(a.name).toBe("data-pipeline");
    expect(a.languages[0]).toBe("Python");
    expect(a.frameworks).toContain("FastAPI");
    expect(a.packageManager).toBe("poetry");
    expect(a.tests).toContain("pytest");
    expect(a.scripts.pipeline).toContain("data_pipeline.main:run");
  });
});

describe("Rust project", () => {
  beforeEach(() => {
    w(
      "Cargo.toml",
      ["[package]", 'name = "imgproc"', 'version = "0.1.0"', "", "[dependencies]", 'axum = "0.7"', ""].join("\n"),
    );
    w("src/main.rs", "fn main() {}\n");
    w("tests/integration.rs", "#[test]\nfn t() {}\n");
  });

  it("detects Cargo, Rust, Axum and cargo test", async () => {
    const a = await analyzer.scan(root);
    expect(a.name).toBe("imgproc");
    expect(a.languages[0]).toBe("Rust");
    expect(a.frameworks).toContain("Axum");
    expect(a.packageManager).toBe("cargo");
    expect(a.tests).toContain("cargo test");
    expect(a.entryPoints).toContain("src/main.rs");
  });
});

describe("Go project", () => {
  beforeEach(() => {
    w("go.mod", "module github.com/example/api-server\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.0\n");
    w("go.sum", "");
    w("cmd/server/main.go", "package main\n\nfunc main() {}\n");
    w("handler_test.go", "package main\n");
  });

  it("detects module name, Go, Gin and go test", async () => {
    const a = await analyzer.scan(root);
    expect(a.name).toBe("api-server");
    expect(a.languages[0]).toBe("Go");
    expect(a.frameworks).toContain("Gin");
    expect(a.packageManager).toBe("go modules");
    expect(a.tests).toContain("go test");
  });
});

describe("git metadata", () => {
  it("reads branch, redacted remote and last commit without secrets", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    // A remote URL with embedded credentials must be redacted in the analysis.
    execFileSync("git", ["remote", "add", "origin", "https://user:SuperSecretToken123@github.com/example/repo.git"], {
      cwd: root,
    });
    w("README.md", "# gitrepo\n\nA description long enough to be used as the project description.\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: root });

    const a = await analyzer.scan(root);
    expect(a.git?.branch).toBe("main");
    expect(a.git?.remote).toBe("https://github.com/example/repo.git");
    expect(a.git?.remote).not.toContain("SuperSecretToken123");
    expect(a.git?.lastCommit).toMatch(/^[0-9a-f]{7} initial commit$/);
    expect(JSON.stringify(a)).not.toContain("SuperSecretToken123");
  }, 30000);

  it("omits git facts when there is no .git", async () => {
    w("package.json", JSON.stringify({ name: "plain" }));
    const a = await analyzer.scan(root);
    expect(a.git).toBeUndefined();
  });
});

describe("scan behavior", () => {
  it("falls back to the folder name and reports nothing broken on an empty folder", async () => {
    const a = await analyzer.scan(root);
    expect(a.name).toBe(baseName(root));
    expect(a.languages).toEqual([]);
    expect(a.truncated).toBe(false);
  });

  it("stops at the file budget and flags truncation", async () => {
    for (let i = 0; i < 30; i++) w(`file-${String(i).padStart(2, "0")}.txt`, "x");
    const a = await analyzer.scan(root, { maxFiles: 10 });
    expect(a.truncated).toBe(true);
    expect(a.fileCount).toBeLessThanOrEqual(10);
    expect(a.warnings.join(" ")).toMatch(/file limit/i);
  });

  it("skips symlinks without following them", async () => {
    const { symlinkSync } = await import("node:fs");
    w("real.txt", "x");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    const a = await analyzer.scan(root);
    expect(a.fileCount).toBe(1);
    expect(a.warnings.join(" ")).toMatch(/symlink/i);
  });

  it("warns on unreadable directories instead of failing", async () => {
    if (isRoot()) return; // root ignores file modes
    mkdirSync(join(root, "locked"));
    writeFileSync(join(root, "locked", "x.txt"), "x");
    chmodSync(join(root, "locked"), 0o000);
    try {
      const a = await analyzer.scan(root);
      expect(a.warnings.join(" ")).toMatch(/permission denied/);
    } finally {
      chmodSync(join(root, "locked"), 0o755);
    }
  });

  it("rejects scan roots outside the allowed roots", async () => {
    const outside = mkdtempSync(join(tmpdir(), "analyzer-out-"));
    try {
      await expect(analyzer.scan(outside)).rejects.toMatchObject({ code: "FS_PATH_OUTSIDE_ROOTS" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a file as the scan root", async () => {
    w("only-a-file.txt", "x");
    await expect(analyzer.scan(join(root, "only-a-file.txt"))).rejects.toMatchObject({ statusCode: 400 });
  });
});

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}
