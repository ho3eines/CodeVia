import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/* ------------------------------------------------------------------ *
 * `.env` file support.
 *
 * The platform reads its whole contract from `process.env` (see `env.ts`). On a
 * PaaS those variables come from the dashboard; on a VPS / Docker host they come
 * from a file. A **full system backup** therefore has to be able to write that
 * file back, otherwise a restore on a new server brings back every project but
 * loses the API keys that only ever lived in the environment.
 *
 * Precedence rule (deliberate): an already-set process variable ALWAYS wins.
 * A restored `.env` fills the gaps on a fresh machine; it never overrides what
 * the hosting platform injects (PORT, DATABASE_PATH, Railway variables…).
 * ------------------------------------------------------------------ */

/** Values that must never be captured from / written to a `.env` file. */
const FORBIDDEN_KEYS = new Set(["PATH", "HOME", "PWD", "SHELL", "USER", "HOSTNAME", "SHLVL", "_"]);

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key) || /^(?:npm_|NODE_|INIT_CWD|VITEST)/.test(key);
}

/** Unquote/unescape one raw `.env` value. */
function decodeValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  // Unquoted: a ` #` starts a trailing comment (dotenv behaviour).
  const commentAt = value.indexOf(" #");
  return (commentAt === -1 ? value : value.slice(0, commentAt)).trim();
}

/**
 * Parse `.env` content. Supports `export KEY=VALUE`, comments, blank lines,
 * single/double-quoted values and `\n` escapes inside double quotes — which is
 * how a PEM (`GITHUB_APP_PRIVATE_KEY`) has to survive a round-trip.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || isForbiddenKey(key)) continue;
    out[key] = decodeValue(withoutExport.slice(eq + 1));
  }
  return out;
}

/** Quote one value so `parseEnvFile` reads it back byte-for-byte. */
function encodeValue(value: string): string {
  if (value === "") return '""';
  const needsQuotes = /[\s#"'\\]|^\s|\s$/.test(value);
  if (!needsQuotes) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/** Render a `.env` file body (values are sorted, secrets grouped and flagged). */
export function renderEnvFile(
  vars: Record<string, string>,
  opts: { header?: string[]; secretKeys?: string[] } = {},
): string {
  const secretKeys = new Set(opts.secretKeys ?? []);
  const keys = Object.keys(vars)
    .filter((key) => !isForbiddenKey(key))
    .sort((a, b) => {
      const sa = secretKeys.has(a) ? 1 : 0;
      const sb = secretKeys.has(b) ? 1 : 0;
      return sa - sb || a.localeCompare(b);
    });
  const lines: string[] = [];
  if (opts.header?.length) {
    lines.push(...opts.header.map((line) => (line.startsWith("#") || line === "" ? line : `# ${line}`)));
    lines.push("");
  }
  let inSecrets = false;
  for (const key of keys) {
    const isSecret = secretKeys.has(key);
    if (isSecret && !inSecrets) {
      lines.push("# ---- Credentials (restored by CodeVia — treat this file like a secret) ----");
      inSecrets = true;
    }
    lines.push(`${key}=${encodeValue(vars[key])}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Merge parsed file values into `process.env` without overriding set values. */
export function applyEnvFileValues(vars: Record<string, string>): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (isForbiddenKey(key)) continue;
    const current = process.env[key];
    if (current !== undefined && current !== "") continue;
    process.env[key] = value;
    applied.push(key);
  }
  return applied.sort();
}

/** Candidate `.env` locations, most specific first. */
export function defaultEnvFilePaths(databasePath?: string): string[] {
  const candidates: string[] = [];
  if (databasePath) candidates.push(resolve(dirname(resolve(databasePath)), ".env"));
  candidates.push(resolve(process.cwd(), ".env"));
  // De-duplicate while keeping order.
  return candidates.filter((path, index) => candidates.indexOf(path) === index);
}

export interface LoadedEnvFiles {
  files: string[];
  keys: string[];
}

/**
 * Load `.env` files into `process.env` at boot. Called before `getEnv()` so a
 * restored deployment starts with the API keys its backup carried. Existing
 * process variables always win, and unreadable files are skipped silently —
 * a missing `.env` is the normal case on a PaaS.
 */
export function loadEnvFiles(paths = defaultEnvFilePaths(process.env.DATABASE_PATH)): LoadedEnvFiles {
  const loadedFiles: string[] = [];
  const loadedKeys = new Set<string>();
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const applied = applyEnvFileValues(parseEnvFile(content));
    loadedFiles.push(path);
    applied.forEach((key) => loadedKeys.add(key));
  }
  return { files: loadedFiles, keys: [...loadedKeys].sort() };
}

/** Write a `.env` file next to the database (best-effort, reports failures). */
export function writeEnvFile(path: string, content: string): { ok: boolean; path: string; error?: string } {
  const target = resolve(path);
  try {
    writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, path: target, error: err instanceof Error ? err.message : String(err) };
  }
}
