import type { FastifyInstance } from "fastify";
import { getEnv } from "../config/env.js";

/**
 * Dependency-free HTTP hardening: security headers + a fixed-window per-IP
 * rate limiter for the API surface. Health probes, webhooks (GitHub/Telegram
 * retry on 429 which is worse than serving them) and the static UI are exempt.
 */
export function registerHardening(app: FastifyInstance): void {
  const env = getEnv();

  if (env.SECURITY_HEADERS !== "false") {
    const production = env.NODE_ENV === "production";
    app.addHook("onSend", async (request, reply, payload) => {
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("X-Frame-Options", "SAMEORIGIN");
      reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
      reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      reply.header("Cross-Origin-Opener-Policy", "same-origin");
      if (production && request.protocol === "https") {
        reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
      }
      // API responses are never cacheable by intermediaries.
      const ct = String(reply.getHeader("content-type") ?? "");
      if (ct.includes("application/json")) reply.header("Cache-Control", "no-store");
      return payload;
    });
  }

  const limit = env.RATE_LIMIT_PER_MINUTE;
  if (limit > 0) {
    const windowMs = 60_000;
    const buckets = new Map<string, { count: number; resetAt: number }>();
    const exemptPrefixes = ["/health", "/ready", "/live", "/webhooks/", "/integrations/telegram/webhook", "/docs", "/socket.io"];
    const exempt = (rawUrl: string, method: string) => {
      const url = rawUrl.split("?")[0];
      if (url === "/" || exemptPrefixes.some((p) => url.startsWith(p))) return true;
      // Static UI assets (GET with a file extension) are not API traffic.
      return method === "GET" && /\.[a-z0-9]{2,5}$/i.test(url);
    };
    // Periodic sweep so the map does not grow without bound.
    const sweeper = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }, windowMs);
    sweeper.unref?.();
    app.addHook("onClose", async () => clearInterval(sweeper));

    app.addHook("onRequest", async (request, reply) => {
      if (exempt(request.url, request.method)) return;
      const key = request.ip || "unknown";
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count++;
      const remaining = Math.max(0, limit - bucket.count);
      reply.header("X-RateLimit-Limit", String(limit));
      reply.header("X-RateLimit-Remaining", String(remaining));
      reply.header("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
      if (bucket.count > limit) {
        reply.header("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
        return reply.code(429).send({ error: "rate limit exceeded", retryAfterMs: bucket.resetAt - now });
      }
    });
  }
}
