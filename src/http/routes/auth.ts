import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import {
  buildAuthorizeUrl,
  buildClearSessionCookie,
  buildSessionCookie,
  createOAuthState,
  exchangeCodeForToken,
  fetchGitHubUser,
  readOAuthState,
  sanitizeNextLocation,
  SESSION_TTL_MS,
  signSession,
} from "../../auth/github-oauth.js";
import {
  getEffectiveGitHubLoginSettings,
  getEffectiveOAuthConfig,
} from "../../auth/admin-settings.js";
import { resolveRequestUser } from "../auth.js";
import { getEnv } from "../../config/env.js";
import { logger } from "../../logger.js";
import { deleteUserGitHubToken, describeUserGitHubToken, storeUserGitHubToken } from "../../auth/github-tokens.js";

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
    const eff = getEffectiveGitHubLoginSettings(container.kv);
    // Public endpoint: the auth hook is skipped, so resolve the session here
    // instead of relying on middleware-attached flags.
    const session = resolveRequestUser(req, container);
    const user = session.authenticated ? session.user : undefined;
    return {
      configured: eff.configured,
      redirectUri: eff.redirectUri,
      redirectUriSource: eff.redirectUriSource,
      scope: eff.scope,
      scopeSource: eff.scopeSource,
      clientId: eff.clientId ? `${eff.clientId.slice(0, 4)}••••${eff.clientId.slice(-4)}` : undefined,
      clientIdSource: eff.clientIdSource,
      clientSecretConfigured: eff.clientSecretConfigured,
      secrets: eff.secrets,
      diagnostics: eff.diagnostics,
      authenticated: session.authenticated,
      user: user ?? null,
      setupHint: eff.setupHint,
      setupSteps: eff.setupSteps,
    };
  });

  app.get("/auth/github/login", { schema: { tags: ["auth"] } }, async (req, reply) => {
    const eff = getEffectiveGitHubLoginSettings(container.kv);
    const cfg = getEffectiveOAuthConfig(container.kv);
    if (!cfg) {
      reply.code(503);
      return {
        error: "GitHub OAuth is not configured",
        hint: eff.setupHint ?? "An admin can set the Client ID in Admin → GitHub Login; GITHUB_CLIENT_SECRET must be set in the environment. See docs/GITHUB_SETUP.md.",
        diagnostics: {
          clientIdMissing: eff.diagnostics.clientIdMissing,
          clientSecretMissing: eff.diagnostics.clientSecretMissing,
          authSecretMissing: eff.diagnostics.authSecretMissing,
          redirectUri: eff.redirectUri,
          clientIdSource: eff.clientIdSource,
          clientSecretConfigured: eff.clientSecretConfigured,
        },
        setupSteps: eff.setupSteps,
      };
    }
    const q = (req.query ?? {}) as Record<string, unknown>;
    // Optional in-app destination after login (hash routes only — see sanitizeNextLocation).
    const state = createOAuthState(undefined, { next: sanitizeNextLocation(q.next) });
    const url = buildAuthorizeUrl({
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      scope: cfg.scope,
      state,
    });
    const wantsJson =
      String(q.format ?? "") === "json" ||
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

    const cfg = getEffectiveOAuthConfig(container.kv);
    if (oauthError) {
      // Surface the most common misconfiguration with an actionable message.
      const detail = String(q.error_description ?? "");
      if (oauthError === "redirect_uri_mismatch") {
        return fail(
          `GitHub rejected the login (redirect_uri_mismatch): the OAuth App's "Authorization callback URL" must be exactly ${cfg?.redirectUri ?? "<PUBLIC_WEB_BASE_URL>/auth/github/callback"}`,
          detail,
        );
      }
      return fail(`GitHub rejected the login (${oauthError})`, detail);
    }
    if (!cfg) return fail("GitHub OAuth is not configured on this server");
    if (!code) return fail("Missing ?code — restart the login from CodeVia");
    const parsedState = readOAuthState(state);
    if (!parsedState) return fail("Invalid or expired login state — please try again");
    const next = parsedState.next ?? "#/github";

    try {
      const { accessToken, scope } = await exchangeCodeForToken(code, {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        redirectUri: cfg.redirectUri,
      });
      const profile = await fetchGitHubUser(accessToken);
      const { user, created } = container.userRepo.upsertGitHubUser(profile);
      // Keep the user's GitHub token (encrypted) so the platform can list and
      // work with *their* repositories — previously it was discarded here,
      // which is why the repository picker was always empty.
      try {
        storeUserGitHubToken(container.kv, user.id, accessToken, { scopes: scope, login: profile.login });
      } catch (err) {
        logger.warn("could not persist user GitHub token", { err: String(err) });
      }
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
      const sep = next.includes("?") ? "&" : "?";
      reply.redirect(`/${next}${sep}login=success`, 302);
      return reply;
    } catch (err) {
      return fail("GitHub login failed", err instanceof Error ? err.message : String(err));
    }
  });

  // Session introspection: always 200, even when logged out (or when strict
  // mode is on). Callers use `{ authenticated: false }` to render a login
  // button instead of treating a 401 as an error. The response also carries
  // the effective strict-mode config so the SPA can decide *upfront* whether
  // protected API calls would 401 — letting it show the login screen without
  // ever firing a request that fails (avoids guaranteed 401 console noise).
  app.get("/auth/me", { schema: { tags: ["auth"] } }, async (req) => {
    const { user, authenticated } = resolveRequestUser(req, container);
    const eff = getEffectiveGitHubLoginSettings(container.kv);
    const gh = authenticated ? describeUserGitHubToken(container.kv, user.id) : { stored: false, scopes: [], canReadPrivateRepos: false };
    return {
      authenticated,
      user,
      /** Whether this session can list the user's own GitHub repositories. */
      githubToken: { stored: gh.stored, scopes: gh.scopes, canReadPrivateRepos: gh.canReadPrivateRepos, login: gh.login },
      // Login config + strict mode (env REQUIRE_AUTH, overridden by the Admin
      // panel toggle). `loginEnabled` matches what the guard actually enforces:
      // strict mode only rejects when OAuth is configured (otherwise the
      // platform falls back to demo mode so nobody is locked out).
      loginConfigured: eff.configured,
      requireAuth: eff.requireAuth && eff.configured,
      redirectUri: eff.redirectUri,
    };
  });

  app.post("/auth/logout", { schema: { tags: ["auth"] } }, async (req, reply) => {
    // Drop the stored GitHub token together with the session.
    const { user, authenticated } = resolveRequestUser(req, container);
    if (authenticated) {
      try {
        deleteUserGitHubToken(container.kv, user.id);
      } catch {
        /* best effort */
      }
    }
    reply.header("Set-Cookie", buildClearSessionCookie());
    return { ok: true };
  });
}
