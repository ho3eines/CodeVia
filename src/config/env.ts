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

/** Blank or whitespace-only env values mean "unset", not "" or 0. */
const blankToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const envEnum = <T extends readonly [string, ...string[]]>(values: T, defaultValue: T[number]) =>
  z.preprocess(blankToUndefined, z.enum(values).default(defaultValue));

const envNumber = (defaultValue: number, min?: number) =>
  z.preprocess(
    (v) => {
      const u = blankToUndefined(v);
      if (u === undefined) return undefined;
      const n = Number(u);
      if (!Number.isFinite(n)) return u; // let zod report the error
      if (min !== undefined && n < min) return min;
      return n;
    },
    z.coerce.number().default(defaultValue),
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
  // GitHub OAuth login (user sign-in via github.com). Blank = platform default
  // ("repo read:user user:email" — `repo` is needed to list private repos).
  GITHUB_OAUTH_SCOPE: z.string().default(""),
  GITHUB_OAUTH_CALLBACK_URL: z.string().optional(),

  // Platform auth sessions (HMAC-signed opaque tokens for GitHub-login users)
  AUTH_SECRET: z.string().optional(),
  // Strict mode: unauthenticated API calls get 401. Accepts true/false, 1/0,
  // yes/no, on/off (blank = default false).
  REQUIRE_AUTH: envBoolean(false),

  // Telegram Bot
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  // Public webhook URL the bot receives updates on. Telegram requires HTTPS.
  // Set this explicitly when deploying (e.g. https://<app>.up.railway.app).
  // If unset, it is derived from PUBLIC_WEB_BASE_URL (falling back to WEB_BASE_URL).
  TELEGRAM_WEBHOOK_URL: z.string().optional(),
  // How the bot RECEIVES updates:
  //   auto    — webhook when a public HTTPS URL is reachable, long polling otherwise
  //             (this is what makes a token-only setup work with zero extra config)
  //   polling — always long-poll getUpdates (no public URL / no tunnel needed)
  //   webhook — always setWebhook (fails loudly when there is no public HTTPS URL)
  //   off     — never receive updates (send-only, e.g. notifications from CI)
  TELEGRAM_MODE: envEnum(["auto", "polling", "webhook", "off"] as const, "auto"),
  // Long-poll hold time in seconds (Telegram allows 0-60; 25 is a good default).
  TELEGRAM_POLL_TIMEOUT: envNumber(25, 0),
  // Telegram Bot API base. Only change it when a proxy/mirror is required — or
  // to point at scripts/mock-telegram-api.mjs to exercise the bot offline.
  TELEGRAM_API_BASE: z.string().default("https://api.telegram.org"),

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
