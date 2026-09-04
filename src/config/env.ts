import { z } from "zod";

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
  REQUIRE_AUTH: z.coerce.boolean().default(false),

  // Telegram Bot
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // Platform control
  ENABLE_TELEGRAM: z.coerce.boolean().default(false),
  ENABLE_SIMULATION_MODE: z.coerce.boolean().default(true),
  MOCK_AI_DEFAULT: z.coerce.boolean().default(true),

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
