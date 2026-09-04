import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import {
  buildAuthorizeUrl,
  buildClearSessionCookie,
  buildSessionCookie,
  createOAuthState,
  exchangeCodeForToken,
  fetchGitHubUser,
  getOAuthConfig,
  getOAuthRedirectUri,
  isGitHubOAuthConfigured,
  SESSION_TTL_MS,
  signSession,
  verifyOAuthState,
} from "../../auth/github-oauth.js";
import { getEnv } from "../../config/env.js";
import { logger } from "../../logger.js";

/**
 * GitHub OAuth login + session routes.
 *
 *   GET  /auth/github/status    — is OAuth configured? + current user
 *   GET  /auth/github/login     — 302 redirect to github.com (or {url} as JSON)
 *   GET  /auth/github/callback  — code exchange -> session cookie -> redirect to UI
 *   GET  /auth/me               — current user (demo when logged out)
 *   POST /auth/logout           — clear session cookie
 */
export function registerAuthRoutes(app: FastifyInstance, container: Container): void {
  app.get("/auth/github/status", { schema: { tags: ["auth"] } }, async (req) => {
    const cfg = getOAuthConfig();
    const user = (req as typeof req & { authenticated?: boolean }).authenticated
      ? req.user
      : undefined;
    return {
      configured: !!cfg,
      redirectUri: cfg?.redirectUri ?? getOAuthRedirectUri(),
      scope: cfg?.scope ?? getEnv().GITHUB_OAUTH_SCOPE,
      authenticated: !!(req as typeof req & { authenticated?: boolean }).authenticated,
      user: user ?? null,
      setupHint: cfg
        ? undefined
        : "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (see docs/GITHUB_SETUP.md), then restart.",
    };
  });

  app.get("/auth/github/login", { schema: { tags: ["auth"] } }, async (req, reply) => {
    const cfg = getOAuthConfig();
    if (!cfg) {
      reply.code(503);
      return {
        error: "GitHub OAuth is not configured",
        hint: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, then restart. See docs/GITHUB_SETUP.md.",
      };
    }
    const state = createOAuthState();
    const url = buildAuthorizeUrl({
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      scope: cfg.scope,
      state,
    });
    const wantsJson =
      String((req.query as Record<string, unknown> | undefined)?.format ?? "") === "json" ||
      String(req.headers.accept ?? "").includes("application/json");
    if (wantsJson) return { url, state };
    reply.redirect(url, 302);
    return reply;
  });

  app.get("/auth/github/callback", { schema: { tags: ["auth"] } }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const code = String(q.code ?? "");
    const state = String(q.state ?? "");
    const oauthError = q.error ? String(q.error) : "";

    const fail = (message: string, detail?: string) => {
      logger.warn("github oauth callback failed", { message, detail });
      const wantsJson = String(req.headers.accept ?? "").includes("application/json");
      if (wantsJson) {
        reply.code(400);
        return { error: message, detail };
      }
      reply.redirect(`/#/github?login=error&reason=${encodeURIComponent(message)}`, 302);
      return reply;
    };

    if (oauthError) return fail(`GitHub rejected the login (${oauthError})`, String(q.error_description ?? ""));
    if (!isGitHubOAuthConfigured()) return fail("GitHub OAuth is not configured on this server");
    if (!code) return fail("Missing ?code — restart the login from CodeVia");
    if (!verifyOAuthState(state)) return fail("Invalid or expired login state — please try again");

    try {
      const { accessToken } = await exchangeCodeForToken(code);
      const profile = await fetchGitHubUser(accessToken);
      const { user, created } = container.userRepo.upsertGitHubUser(profile);
      await container.auditRepo.record({
        userId: user.id,
        action: created ? "auth.github.signup" : "auth.github.login",
        result: "success",
        source: "web",
        correlationId: `auth-${Date.now()}`,
        metadata: { login: profile.login, githubId: profile.id },
      });
      const token = signSession(user.id);
      const secure = getEnv().NODE_ENV === "production";
      reply.header("Set-Cookie", buildSessionCookie(token, { secure, maxAgeMs: SESSION_TTL_MS }));
      logger.info(`github login: ${profile.login} (${user.role})`);
      const wantsJson = String(req.headers.accept ?? "").includes("application/json");
      if (wantsJson) return { ok: true, token, user, created };
      reply.redirect("/#/github?login=success", 302);
      return reply;
    } catch (err) {
      return fail("GitHub login failed", err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/auth/me", { schema: { tags: ["auth"] } }, async (req) => {
    const authenticated = !!(req as typeof req & { authenticated?: boolean }).authenticated;
    return { authenticated, user: req.user };
  });

  app.post("/auth/logout", { schema: { tags: ["auth"] } }, async (_req, reply) => {
    reply.header("Set-Cookie", buildClearSessionCookie());
    return { ok: true };
  });
}
