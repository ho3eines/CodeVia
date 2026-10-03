import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyEnvFileValues,
  defaultEnvFilePaths,
  loadEnvFiles,
  parseEnvFile,
  renderEnvFile,
  writeEnvFile,
} from "../config/env-file.js";

/* ------------------------------------------------------------------ *\
 * `.env` support is what makes a restored backup survive a restart: the
 * restore writes the recovered API keys next to the database, and the
 * next boot has to read them back — without ever overriding a variable
 * the hosting platform injects.
 * ------------------------------------------------------------------ */

let dir: string;
let saved: Record<string, string | undefined> = {};

const KEYS = ["OPENAI_API_KEY", "CODEVIA_TEST_MARKER", "GITHUB_APP_PRIVATE_KEY", "DATABASE_PATH"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codevia-env-"));
  saved = {};
  for (const key of KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("env file parsing and rendering", () => {
  it("round-trips values, quotes, comments and a multi-line PEM key", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEline1\nMIIEline2\n-----END RSA PRIVATE KEY-----\n";
    const vars = {
      OPENAI_API_KEY: "sk-simple",
      GITHUB_APP_PRIVATE_KEY: pem,
      EMPTY: "",
      WITH_SPACES: "  padded value  ",
      WITH_HASH: "value # not a comment when quoted",
      EXPORTED: "from-export-line",
    };
    const text = renderEnvFile(vars, { header: ["written by a test"], secretKeys: ["OPENAI_API_KEY"] });
    expect(text.startsWith("# written by a test")).toBe(true);

    const parsed = parseEnvFile(`export EXPORTED=from-export-line\n${text}`);
    expect(parsed.OPENAI_API_KEY).toBe("sk-simple");
    expect(parsed.GITHUB_APP_PRIVATE_KEY).toBe(pem);
    expect(parsed.EMPTY).toBe("");
    expect(parsed.WITH_SPACES).toBe("  padded value  ");
    expect(parsed.WITH_HASH).toBe("value # not a comment when quoted");
    expect(parsed.EXPORTED).toBe("from-export-line");
  });

  it("ignores comments, blank lines, malformed lines and machine-local variables", () => {
    const parsed = parseEnvFile(
      ["# a comment", "", "   ", "NO_EQUALS_SIGN", "=no-key", "PATH=/usr/bin", "npm_config_cache=/tmp", "OK=1"].join(
        "\n",
      ),
    );
    expect(parsed).toEqual({ OK: "1" });
  });

  it("unquoted values stop at a trailing comment", () => {
    expect(parseEnvFile("KEY=value # trailing comment").KEY).toBe("value");
  });
});

describe("loading .env at boot", () => {
  it("fills unset variables and never overrides ones the platform provides", () => {
    process.env.OPENAI_API_KEY = "sk-provided-by-the-platform";
    delete process.env.CODEVIA_TEST_MARKER;
    writeFileSync(
      join(dir, ".env"),
      renderEnvFile({ OPENAI_API_KEY: "sk-from-file", CODEVIA_TEST_MARKER: "from-file" }),
    );

    const loaded = loadEnvFiles([join(dir, ".env")]);
    expect(loaded.files).toEqual([join(dir, ".env")]);
    expect(process.env.OPENAI_API_KEY).toBe("sk-provided-by-the-platform");
    expect(process.env.CODEVIA_TEST_MARKER).toBe("from-file");
    expect(loaded.keys).toEqual(["CODEVIA_TEST_MARKER"]);
  });

  it("derives the data-volume path from DATABASE_PATH and skips missing files", () => {
    const paths = defaultEnvFilePaths(join(dir, "codevia.db"));
    expect(paths[0]).toBe(join(dir, ".env"));
    expect(paths).toContain(resolve(process.cwd(), ".env"));
    expect(loadEnvFiles([join(dir, "does-not-exist.env")])).toEqual({ files: [], keys: [] });
  });

  it("writes the file with owner-only permissions", () => {
    const result = writeEnvFile(join(dir, ".env"), renderEnvFile({ CODEVIA_TEST_MARKER: "x" }));
    expect(result.ok).toBe(true);
    expect(readFileSync(result.path, "utf8")).toContain("CODEVIA_TEST_MARKER=x");
    if (process.platform !== "win32") {
      // 0600: a restored .env holds live API keys.
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
    }
  });

  it("reports an unwritable target instead of throwing", () => {
    const result = writeEnvFile(join(dir, "missing-subdir", ".env"), "A=1\n");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("applyEnvFileValues refuses machine-local keys", () => {
    expect(applyEnvFileValues({ PATH: "/evil", HOME: "/evil", npm_lifecycle_event: "x" })).toEqual([]);
  });
});

describe("entrypoints read .env before the environment contract is cached", () => {
  /**
   * `src/logger.ts` calls `getEnv()` at module scope and `getEnv()` memoizes the
   * parsed contract, so a `.env` read any later than the first import is
   * invisible for the whole process. A restore that writes recovered API keys to
   * `<db dir>/.env` would then produce a server that cannot decrypt anything.
   * This pins the import order that prevents it.
   */
  it("imports config/env-bootstrap first in every entrypoint", () => {
    for (const entry of ["src/index.ts", "src/backup/cli.ts"]) {
      const source = readFileSync(resolve(process.cwd(), entry), "utf8");
      const first = source.split("\n").find((line) => line.startsWith("import "));
      expect(first, `${entry}: the first import must be the env bootstrap`).toMatch(/config\/env-bootstrap\.js/);
    }
  });
});
