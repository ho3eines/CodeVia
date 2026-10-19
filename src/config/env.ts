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
const blankToUndefined = (v: unknown): unknown => (typeof v === "string" && v.trim() === "" ? undefined : v);

const envEnum = <T extends readonly [string, ...string[]]>(values: T, defaultValue: T[number]) =>
  z.preprocess(blankToUndefined, z.enum(values).default(defaultValue));

const envNumber = (defaultValue: number, min?: number) =>
  z.preprocess((v) => {
    const u = blankToUndefined(v);
    if (u === undefined) return undefined;
    const n = Number(u);
    if (!Number.isFinite(n)) return u; // let zod report the error
    if (min !== undefined && n < min) return min;
    return n;
  }, z.coerce.number().default(defaultValue));

/** Optional string where a blank value means "unset", never "". */
const blankString = () => z.preprocess(blankToUndefined, z.string().optional());

/**
 * Environment variable contract. All secrets come from environment variables /
 * secret management (Railway Variables, Railway Secrets, Secret Manager). They are
 * NEVER stored in the Git repository or in project config — only secret *refs* are.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  /** API rate limit per client IP per minute (0 disables). Webhooks/health are exempt. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(600),
  /** Add security headers (HSTS only when behind TLS / in production). */
  SECURITY_HEADERS: z.enum(["true", "false"]).default("true"),

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
  // Allow a loopback webhook URL (local/tunnel testing against a Bot API double).
  TELEGRAM_WEBHOOK_ALLOW_LOOPBACK: envBoolean(false),
  // Keep `http://` webhook URLs for public hosts (Telegram normally rejects
  // them; only set this when an HTTPS-terminating proxy is not in front).
  TELEGRAM_WEBHOOK_INSECURE: envBoolean(false),
  // Long-poll hold time in seconds (Telegram allows 0-60; 25 is a good default).
  TELEGRAM_POLL_TIMEOUT: envNumber(25, 0),
  // Telegram Bot API base. Only change it when a proxy/mirror is required — or
  // to point at scripts/mock-telegram-api.mjs to exercise the bot offline.
  TELEGRAM_API_BASE: z.string().default("https://api.telegram.org"),

  // Platform control
  ENABLE_TELEGRAM: envBoolean(false),
  ENABLE_SIMULATION_MODE: envBoolean(true),
  MOCK_AI_DEFAULT: envBoolean(true),

  // File patching — existing files at or below this many bytes may be replaced
  // by a full model rewrite instead of an {"edits":[…]} patch (step-1 ladder).
  PATCH_FULL_REWRITE_MAX_BYTES: envNumber(8192, 0),

  // ---- Docker sandbox for project lifecycle commands ----
  // Project code is NEVER executed on the CodeVia host. Configured
  // install/build/test/lint/start commands run only inside a disposable,
  // resource-limited Docker container (`src/projects/sandbox-runner.ts`).
  // The container gets a read-only root FS, no capabilities, no-new-privileges
  // and `--network=none` unless the project explicitly opts in.
  /**
   * Master switch. When off, project commands are never run in a container;
   * run_tests/run_build use GitHub CI evidence (the pre-sandbox behaviour).
   * Deployments without Docker, and the automated test/smoke harness, set this
   * to false.
   */
  PROJECT_SANDBOX_ENABLED: envBoolean(true),
  /** Docker CLI to spawn. Use an absolute path when it is not on PATH. */
  PROJECT_SANDBOX_DOCKER_BIN: blankString(),
  /** Image override; unset = chosen from the project language (node/python/go/rust/php). */
  PROJECT_SANDBOX_IMAGE: blankString(),
  /** Hard wall-clock limit for one sandbox execution (ms). */
  PROJECT_SANDBOX_TIMEOUT_MS: envNumber(8 * 60_000, 1000),
  /** Memory cap for the container (MiB). */
  PROJECT_SANDBOX_MEMORY_MB: envNumber(1024, 128),
  /** CPU quota for the container. */
  PROJECT_SANDBOX_CPUS: envNumber(1, 1),
  /** Maximum process count inside the container (fork-bomb guard). */
  PROJECT_SANDBOX_PIDS_LIMIT: envNumber(128, 16),
  /** How many trailing bytes of stdout/stderr are kept for the run evidence. */
  PROJECT_SANDBOX_LOG_TAIL_BYTES: envNumber(12_000, 1000),
  /** Scratch root for exported source trees (default: the OS temp directory). */
  PROJECT_SANDBOX_DIR: blankString(),
  /**
   * Sandbox image availability policy, applied before `docker run` (which still
   * uses `--pull=never`):
   *   "never"   — do not touch the image; a missing one fails with the exact
   *               `docker pull <image>` command to run (default);
   *   "missing" — `docker image inspect`, then `docker pull` only when absent;
   *   "always"  — `docker pull` before every execution.
   * Pulling needs host/daemon network access; the container's own network stays
   * governed by `settings.sandboxNetworkAccess`.
   */
  PROJECT_SANDBOX_IMAGE_PULL: envEnum(["never", "missing", "always"] as const, "never"),

  // ---- Project import (.zip / .rar) ----
  // Bounded, streaming-free archive parsing: no archive entry is ever written
  // to disk before its path, size and CRC are validated.
  PROJECT_IMPORT_MAX_UPLOAD_BYTES: envNumber(25 * 1024 * 1024, 1024),
  PROJECT_IMPORT_MAX_FILES: envNumber(5000, 1),
  PROJECT_IMPORT_MAX_FILE_BYTES: envNumber(25 * 1024 * 1024, 1024),
  PROJECT_IMPORT_MAX_TOTAL_BYTES: envNumber(200 * 1024 * 1024, 1024),
  PROJECT_IMPORT_MAX_COMPRESSION_RATIO: envNumber(500, 1),
  /** 7z/7zz binary used to read `.rar` archives; unset = probe PATH. */
  PROJECT_IMPORT_7Z_BIN: blankString(),

  // ---- Local Git CLI mode (100% local, no GitHub API) ----
  // See docs/LOCAL-GIT-MODE.md. Declared here so a portable backup carries the
  // configuration of the machine it was taken on.
  LOCAL_GIT_MODE: envBoolean(false),
  /** Root holding `<owner>/<repo>` working copies and bare repositories. */
  LOCAL_REPOS_DIR: blankString(),
  /** Owner reported for flat repositories and for the viewer identity. */
  LOCAL_GIT_OWNER: blankString(),
  /** Path to the git executable when it is not on PATH. */
  LOCAL_GIT_BIN: blankString(),
  /** Fetch from the configured remote before repository reads (default off). */
  LOCAL_GIT_AUTO_FETCH: envBoolean(false),
  /** Push every agent commit/merge with the host's own git credentials. */
  LOCAL_GIT_AUTO_PUSH: envBoolean(false),
  /** Remote name used by LOCAL_GIT_AUTO_PUSH / LOCAL_GIT_AUTO_FETCH. */
  LOCAL_GIT_REMOTE: blankString(),
  /**
   * LEGACY / NOT EXECUTED ON THE HOST: a shell command used as the
   * `local-verify` check. Kept for compatibility, but local mode now refuses to
   * run it and points at the Docker sandbox instead.
   */
  LOCAL_GIT_VERIFY_CMD: blankString(),
  /** A git lock older than this is treated as stale after a crash (ms). */
  LOCAL_GIT_STALE_LOCK_MS: envNumber(600_000, 1000),

  // ---- Local folder projects (server filesystem) ----
  /** Comma-separated roots the server may scan; unset = CodeVia install dir only. */
  CODEVIA_ALLOWED_ROOTS: blankString(),

  // State commits — CodeVia saves every project update (task/run status,
  // memory, agents, conversations…) as a commit that only touches `CodeVia/**`.
  // GitHub skips workflow runs whose head commit message carries a skip marker,
  // so a project's (possibly red or expensive) gate no longer runs — and no
  // "all jobs have failed" mail is sent — for every state save. Set to false
  // when a project genuinely needs CI to run on state commits too.
  STATE_COMMIT_SKIP_CI: envBoolean(true),

  // Model routing — how requests are spread over the registered models.
  //   adaptive            (default) benchmark quality + fair share, discounted
  //                                 by live load and models that keep failing
  //   round-robin                     strict rotation: one request per model
  //   weighted-round-robin            rotation weighted by loadWeight × score
  //   least-loaded                    fewest in-flight / lowest rate usage first
  //   sticky                          always the single best model (legacy)
  MODEL_ROUTING_POLICY: envEnum(
    ["adaptive", "round-robin", "weighted-round-robin", "least-loaded", "sticky"] as const,
    "adaptive",
  ),
  // In-flight calls one model may carry before the router prefers its peers
  // (0 = unlimited; a per-model value on the Model overrides this one).
  MODEL_ROUTING_MAX_CONCURRENCY_PER_MODEL: envNumber(0, 0),
  // Consecutive failures that cool a model down for a while. 0 disables the
  // circuit breaker (a failing model then keeps getting traffic every round).
  MODEL_ROUTING_FAILURE_THRESHOLD: envNumber(3, 0),
  // Base cooldown for a cooled-down model; doubles per trip up to 8×.
  MODEL_ROUTING_COOLDOWN_MS: envNumber(60000, 1000),
  // How long one conversation keeps the model it was first given
  // (0 = rotate on every message, which is what spreads chat load best).
  MODEL_ROUTING_SESSION_STICKY_MS: envNumber(0, 0),
  // How long one agent run keeps its model, so a run does not switch voice
  // between steps while different runs still spread across the registry.
  MODEL_ROUTING_RUN_STICKY_MS: envNumber(900000, 0),

  // Web UI
  WEB_BASE_URL: z.string().default("http://localhost:8080"),
  PUBLIC_WEB_BASE_URL: z.string().optional(),

  // ---- Full system backup (Admin → System Backup) ----
  // A backup is a *complete* point-in-time copy of the installation: every
  // runtime row AND the environment that produced it, so a brand-new server can
  // be brought up from one file. That includes credentials — see BACKUP_INCLUDE_SECRETS.
  /** Capture the platform's environment variables into every backup. */
  BACKUP_INCLUDE_ENV: envBoolean(true),
  /**
   * Capture credentials in the backup: API keys, GitHub/Telegram tokens, the
   * per-user GitHub OAuth tokens and AUTH_SECRET — as plaintext, so a restore on
   * a server with a different AUTH_SECRET still brings every integration back.
   * Set false to keep the old behaviour (database rows only, secrets left in
   * their AUTH_SECRET-bound encrypted form and never exported).
   */
  BACKUP_INCLUDE_SECRETS: envBoolean(true),
  /** Also write every backup to disk next to the database (survives without GitHub). */
  BACKUP_LOCAL_COPY: envBoolean(true),
  /** Where local copies go. Default: `<dirname(DATABASE_PATH)>/backups`. */
  BACKUP_LOCAL_DIR: z.string().optional(),
  /** How many local snapshot directories to keep (oldest pruned after each run). */
  BACKUP_LOCAL_RETAIN: envNumber(30, 1),
  /**
   * Optional passphrase protecting the *stored* secret bundle (GitHub repo +
   * local copy). When set, `secrets.enc.json` (scrypt + AES-256-GCM) is written
   * instead of plaintext `secrets.json`, and a restore needs the same
   * passphrase. The file an admin explicitly downloads stays plaintext.
   * Never itself captured into a backup.
   */
  BACKUP_PASSPHRASE: z.string().optional(),
  /** Extra environment variable names to capture (comma-separated). */
  BACKUP_EXTRA_ENV: z.string().optional(),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

/**
 * Every environment variable the platform's contract knows about. The full
 * system backup captures these (plus provider `secretRef` names and
 * BACKUP_EXTRA_ENV) so a restored server behaves exactly like the source one.
 */
export const ENV_CONTRACT_KEYS: string[] = Object.keys(EnvSchema.shape);

let cached: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (cached) return cached;
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    // Collect a readable summary of what's wrong.
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
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
