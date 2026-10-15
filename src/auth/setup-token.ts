import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { getEnv } from "../config/env.js";
import { getEffectiveOAuthConfig } from "./admin-settings.js";
import { logger } from "../logger.js";

/* ------------------------------------------------------------------ *
 * Admin bootstrap window (production)
 *
 * In production the platform is fail-closed: with strict auth on and no
 * GitHub login configured it answers 503 instead of silently handing out
 * owner permissions. That would also lock the operator out of the Admin →
 * GitHub Login page needed to finish onboarding, so a *narrow* bootstrap
 * window stays open while (and only while) login is unconfigured:
 *
 *   - GET  /admin/settings          (read the current login config)
 *   - PUT  /admin/settings/github   (store Client ID / callback / scope)
 *
 * Reachable only when the caller is unauthenticated AND either connects
 * from loopback or presents the one-time setup token printed at boot.
 * The window closes the moment GitHub login becomes configured; it never
 * exposes secrets (the Client Secret and AUTH_SECRET stay env-only) and
 * never grants any other admin route.
 * ------------------------------------------------------------------ */

/** Operator override for deterministic deployment (must be >= 8 chars). */
const SETUP_TOKEN_ENV = "CV_SETUP_TOKEN";

/** Paths reachable through the bootstrap window. */
const BOOTSTRAP_GET_PATHS = new Set(["/admin/settings"]);
const BOOTSTRAP_PUT_PATHS = new Set(["/admin/settings/github"]);

let provisionedToken: string | undefined;
let announced = false;

export function isProduction(env: { NODE_ENV: string } = getEnv()): boolean {
  return env.NODE_ENV === "production";
}

/** Normalize "::ffff:127.0.0.1" and case so loopback checks are reliable. */
function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

/** True for the loopback interface only (IPv4, IPv6 and the "localhost" name). */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const a = normalizeAddress(address);
  return a === "::1" || a === "localhost" || a.startsWith("127.");
}

/** The one-time setup token: env override, otherwise minted once per process. */
export function getSetupToken(): string {
  const override = process.env[SETUP_TOKEN_ENV]?.trim();
  if (override && override.length >= 8) return override;
  if (!provisionedToken) provisionedToken = randomBytes(24).toString("base64url");
  return provisionedToken;
}

/** Constant-time comparison of a candidate against the setup token. */
export function isValidSetupToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(getSetupToken(), "utf8");
  const got = Buffer.from(candidate, "utf8");
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

/** Path of a request URL, tolerating query strings and absolute-form URLs. */
function pathOf(url: string): string {
  const raw = url.split("?")[0];
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).pathname;
    } catch {
      /* fall through to raw */
    }
  }
  return raw;
}

/** The socket address, deliberately NOT the X-Forwarded-For–derived `req.ip`. */
function socketAddress(req: FastifyRequest): string | undefined {
  const raw = req.raw as { socket?: { remoteAddress?: string } } | undefined;
  return raw?.socket?.remoteAddress ?? (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress;
}

/**
 * Is this request coming from loopback? Because the server runs with
 * `trustProxy: true`, `req.ip` is attacker-controllable through
 * `X-Forwarded-For`, so that header disqualifies loopback outright: behind a
 * proxy the caller must present the setup token instead. Otherwise we fall back
 * to the real socket address (then `req.ip`, which inject() populates).
 */
function isLoopbackRequest(req: FastifyRequest): boolean {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  if (headers["x-forwarded-for"]) return false;
  return isLoopbackAddress(socketAddress(req) ?? req.ip);
}

/** Read the setup token from the standard headers only (never a query param). */
function candidateToken(req: FastifyRequest): string | undefined {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const raw = headers["x-codevia-setup-token"];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const auth = headers.authorization;
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return undefined;
}

/** GitHub login is configured (Client ID + Client Secret both present). */
export function isLoginConfigured(container: Container): boolean {
  try {
    return !!getEffectiveOAuthConfig(container.kv);
  } catch {
    // kv unavailable — fail closed: assume configured so bootstrap is off.
    return true;
  }
}

/**
 * Is this request allowed through the production bootstrap window? Never true
 * for an authenticated caller, outside production, on any other path, or once
 * GitHub login is configured.
 */
export function isBootstrapAdminRequest(req: FastifyRequest, container: Container, authenticated: boolean): boolean {
  if (authenticated || !isProduction()) return false;
  const method = req.method.toUpperCase();
  const path = pathOf(req.url);
  const allowedPath =
    (method === "GET" && BOOTSTRAP_GET_PATHS.has(path)) || (method === "PUT" && BOOTSTRAP_PUT_PATHS.has(path));
  if (!allowedPath) return false;
  if (isLoginConfigured(container)) return false;
  if (isLoopbackRequest(req)) return true;
  return isValidSetupToken(candidateToken(req));
}

/**
 * Print the one-time setup token at boot when production would otherwise be
 * unreachable: login being unconfigured in production is exactly the situation
 * the operator must be able to fix from the Admin page. Emitted at most once
 * per process; a no-op outside production or once login is configured.
 */
export function announceSetupToken(container: Container): void {
  if (announced || !isProduction() || isLoginConfigured(container)) return;
  announced = true;
  const token = getSetupToken();
  logger.warn(
    "GitHub login is not configured in production. The Admin → GitHub Login settings are temporarily reachable " +
      `from loopback or with this one-time setup token: ${token} — the window closes as soon as login is configured.`,
  );
}
