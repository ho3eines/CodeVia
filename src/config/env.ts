import { z } from "zod";

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);

/**
 * Lenient boolean parser for environment flags.
 *
 * `z.coerce.boolean()` runs `Boolean(value)`, so ANY non-empty string — including
 * `"false"` and `"0"` — becomes `true`. That turned `REQUIRE_AUTH=false` into a
 * strict-auth lockout in production. This helper understands the usual
 * spellings; blank/unset means "use the default"; anything else is returned
 * untouched so zod reports a clear validation error instead of guessing.
 */
export function parseEnvBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (s === "") return undefined;
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  return undefined;
}

function isRecognizedBoolean(value: unknown): boolean {
  if (value === undefined || value === null || typeof value === "boolean") return true;
  const s = String(value).trim().toLowerCase();
  return s === "" || TRUE_VALUES.has(s) || FALSE_VALUES.has(s);
}

const envBoolean = (defaultValue: boolean) =>
  z.preprocess(
    (v) => (isRecognizedBoolean(v) ? parseEnvBoolean(v) : v),
    z
      .boolean({
        invalid_type_error: 'expected a boolean ("true"/"false", "1"/"0", "yes"/"no", "on"/"off")',
      })
      .default(defaultValue),
  );

/**
 * Environment variable contract. All secrets come from environment variables /
 * secret management (Railway Variables, Railway Secrets, Secret Manager). They are
 * NEVER stored in the Git repository or in project config — only secret *refs* are.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "staging", "production", "test"])
    .default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  // Database (runtime state / cache / index — NOT the source of truth for projects)
  DATABASE_PATH: z.string().default("./data/codevia.db"),

  // Model provider secrets (Secret References)
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://127.0.0.1:11434"),

  // GitHub: OAuth App / GitHub App
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_ENABLED: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  // GitHub App webhook secret for signature validation
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  // GitHub OAuth login (user sign-in via github.com)
  GITHUB_OAUTH_SCOPE: z.string().default("read:user user:email"),
  GITHUB_OAUTH_CALLBACK_URL: z.string().optional(),

  // Platform auth sessions (HMAC-signed opaque tokens for GitHub-login users)
  AUTH_SECRET: z.string().optional(),
  // Strict mode: unauthenticated API calls get 401. Accepts true/false, 1/0,
  // yes/no, on/off (blank = default false).
  REQUIRE_AUTH: envBoolean(false),

  // Telegram Bot
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // Platform control
  ENABLE_TELEGRAM: envBoolean(false),
  ENABLE_SIMULATION_MODE: envBoolean(true),
  MOCK_AI_DEFAULT: envBoolean(true),

  // Web UI
  WEB_BASE_URL: z.string().default("http://localhost:8080"),
  PUBLIC_WEB_BASE_URL: z.string().optional(),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

let cached: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (cached) return cached;
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    // Collect a readable summary of what's wrong.
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = result.data;
  return cached;
}

export function getEnvFresh(): EnvConfig {
  cached = null;
  return getEnv();
}

/** Flag used to keep secret material out of logs. */
export function redactSecret(value: string | undefined): string {
  if (!value) return "";
  return value.slice(0, 4) + "••••••••" + (value.length > 14 ? value.slice(-4) : "");
}
