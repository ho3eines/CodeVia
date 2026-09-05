import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Container } from "../../app/container.js";
import { verifyGithubSignature, getWebhookSecret } from "../../github/webhook.js";
import { GitHubAuthError } from "../../github/real-service.js";
import { resolveGitHubForUser, isServerGitHubEnabled } from "../../github/registry.js";
import type { ResolvedGitHub } from "../../github/registry.js";
import { eventBus, generateCorrelationId } from "../../events/bus.js";
import { logger } from "../../logger.js";
import { resolveRequestUser } from "../auth.js";
import { describeUserGitHubToken } from "../../auth/github-tokens.js";
import { getEnv } from "../../config/env.js";

function fail(reply: FastifyReply, status: number, message: string, extra: Record<string, unknown> = {}): { error: string } {
  reply.code(status);
  return { error: message, ...extra };
}

/** Map a GitHub failure to a proper HTTP status + actionable message (never a 200 with `{error}`). */
function githubError(reply: FastifyReply, err: unknown, resolved?: ResolvedGitHub): { error: string; source?: string; hint?: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GitHubAuthError) {
    reply.code(err.status === 403 ? 403 : 401);
    const hint =
      resolved?.source === "user-oauth"
        ? "GitHub rejected your login token (revoked or expired). Log out and log in with GitHub again."
        : "GitHub rejected the server token. Check GITHUB_TOKEN (PAT / installation token) — GITHUB_CLIENT_SECRET is not a token.";
    return { error: message, source: resolved?.source, hint };
  }
  reply.code(502);
  return { error: message, source: resolved?.source, hint: "GitHub API request failed — see server logs." };
}

export function registerGithubRoutes(app: FastifyInstance, container: Container): void {
  const resolveFor = (req: FastifyRequest): ResolvedGitHub & { userId?: string; authenticated: boolean } => {
    const { user, authenticated } = resolveRequestUser(req, container);
    const r = resolveGitHubForUser({ kv: container.kv, userId: user.id, authenticated, fallback: container.github });
    return { ...r, userId: user.id, authenticated };
  };

  app.get("/integrations/github/status", { schema: { tags: ["github"] } }, async (req) => {
    const kind = container.github.kind;
    const { isGitHubOAuthConfigured } = await import("../../auth/github-oauth.js");
    const { user, authenticated } = resolveRequestUser(req, container);
    const resolved = resolveFor(req);
    const userToken = authenticated ? describeUserGitHubToken(container.kv, user.id) : { stored: false, scopes: [], canReadPrivateRepos: false };
    let repoCount = 0;
    let repoError: string | undefined;
    let viewer: { login: string; name?: string; scopes: string[] } | undefined;
    // This endpoint is public (the SPA needs it before login). Never spend the
    // server token's rate limit — or reveal its owner — for anonymous callers
    // in strict mode.
    const allowLive = authenticated || !getEnv().REQUIRE_AUTH;
    if (resolved.source !== "mock" && allowLive) {
      try {
        viewer = await resolved.service.getViewer();
        repoCount = (await resolved.service.listRepositories({ limit: 300 })).length;
      } catch (err) {
        repoError = err instanceof Error ? err.message : String(err);
      }
    } else {
      repoCount = (await resolved.service.listRepositories()).length;
    }
    return {
      connected: kind === "real" || resolved.source === "user-oauth",
      kind,
      /** Which credential the repo picker uses for this request. */
      source: resolved.source,
      sourceHint: resolved.hint,
      serverTokenEnabled: isServerGitHubEnabled(),
      repoCount,
      repoError,
      viewer,
      userToken,
      sourceOfTruth: true,
      oauthConfigured: isGitHubOAuthConfigured(),
      authenticated,
      user: authenticated ? user : null,
    };
  });

  /**
   * Repositories visible to the current session. Query params:
   *   ?q=substring   filter on owner/name/description
   *   ?limit=N       cap (default 300)
   * Response: { repositories, source, hint, viewer? }
   */
  app.get("/github/repositories", { schema: { tags: ["github"] } }, async (req, reply) => {
    const q = req.query as { q?: string; limit?: string };
    const resolved = resolveFor(req);
    try {
      const repositories = await resolved.service.listRepositories({
        query: q.q,
        limit: q.limit ? Number(q.limit) : undefined,
      });
      return { repositories, source: resolved.source, scopes: resolved.scopes, hint: resolved.hint, count: repositories.length };
    } catch (err) {
      return githubError(reply, err, resolved);
    }
  });

  /** Create a new repository on the connected account (user can then pick it). */
  app.post("/github/repositories", { schema: { tags: ["github"] } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return fail(reply, 400, "Repository name is required and can only contain letters, digits, '.', '_', '-'");
    const resolved = resolveFor(req);
    try {
      const repo = await resolved.service.createRepository({
        name,
        owner: typeof b.owner === "string" && b.owner.trim() ? b.owner.trim() : undefined,
        description: typeof b.description === "string" ? b.description.trim() : undefined,
        private: b.private === true,
        autoInit: b.autoInit !== false,
        defaultBranch: typeof b.defaultBranch === "string" && b.defaultBranch.trim() ? b.defaultBranch.trim() : "main",
      });
      reply.code(201);
      return { repository: repo, source: resolved.source };
    } catch (err) {
      return githubError(reply, err, resolved);
    }
  });

  app.get("/github/repositories/:owner/:name/files", { schema: { tags: ["github"] } }, async (req, reply) => {
    const { owner, name } = req.params as { owner: string; name: string };
    const q = req.query as { branch?: string; path?: string };
    const resolved = resolveFor(req);
    try {
      const files = await resolved.service.listFiles({ owner, name }, q.branch, q.path);
      return { files, source: resolved.source, count: files.length };
    } catch (err) {
      return githubError(reply, err, resolved);
    }
  });

  app.get("/github/repositories/:owner/:name/branches", { schema: { tags: ["github"] } }, async (req, reply) => {
    const { owner, name } = req.params as { owner: string; name: string };
    const resolved = resolveFor(req);
    try {
      return await resolved.service.listBranches({ owner, name });
    } catch (err) {
      return githubError(reply, err, resolved);
    }
  });

  app.get("/github/repositories/:owner/:name/commits", { schema: { tags: ["github"] } }, async (req, reply) => {
    const { owner, name } = req.params as { owner: string; name: string };
    const q = req.query as { branch?: string };
    const resolved = resolveFor(req);
    try {
      return await resolved.service.listCommits({ owner, name }, q.branch);
    } catch (err) {
      return githubError(reply, err, resolved);
    }
  });

  app.post("/github/repositories/:owner/:name/branches", { schema: { tags: ["github"] } }, async (req, reply) => {
    const { owner, name } = req.params as { owner: string; name: string };
    const b = req.body as Record<string, unknown>;
    const resolved = resolveFor(req);
    try {
      return await resolved.service.createBranch({ owner, name }, String(b.name), String(b.baseSha));
    } catch (err) {
      return githubError(reply, err, resolved);
    }
  });

  app.post("/github/repositories/:owner/:name/pull-requests", { schema: { tags: ["github"] } }, async (req, reply) => {
    const { owner, name } = req.params as { owner: string; name: string };
    const b = req.body as Record<string, unknown>;
    const resolved = resolveFor(req);
    try {
      return await resolved.service.createPullRequest(
        { owner, name },
        String(b.title),
        String(b.body ?? ""),
        String(b.head),
        String(b.base),
      );
    } catch (err) {
      return githubError(reply, err, resolved);
    }
  });

  // Incoming GitHub webhook — signature validated.
  app.post("/webhooks/github", { schema: { tags: ["github"] } }, async (req, reply) => {
    const raw = (req.body as unknown) as string | Record<string, unknown>;
    const headers = req.headers;
    const rawBody = typeof raw === "string" ? raw : JSON.stringify(raw);
    const signature = String(headers["x-hub-signature-256"] ?? "");
    const secret = getWebhookSecret();
    const event = String(headers["x-github-event"] ?? "");
    if (secret && !verifyGithubSignature(secret, signature, rawBody)) {
      logger.warn("github webhook signature invalid");
      reply.code(401);
      return { ok: false, error: "invalid signature" };
    }
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const deliveryId = String(headers["x-github-delivery"] ?? "") || undefined;
    await eventBus.publish(normalizeEvent(event), {
      event,
      body: parsed,
      deliveryId,
    }, { correlationId: generateCorrelationId(), projectId: (parsed as { repository?: { full_name?: string } })?.repository?.full_name });
    reply.code(202);
    return { ok: true, event };
  });
}

function normalizeEvent(event: string): "github.push" | "github.pull_request" | "github.issue" | "github.release" | "github.workflow_completed" {
  if (event === "push") return "github.push";
  if (event === "pull_request") return "github.pull_request";
  if (event === "issues") return "github.issue";
  if (event === "release") return "github.release";
  return "github.workflow_completed";
}
