import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.js";
import { verifyGithubSignature, getWebhookSecret } from "../../github/webhook.js";
import { eventBus, generateCorrelationId } from "../../events/bus.js";
import { logger } from "../../logger.js";

export function registerGithubRoutes(app: FastifyInstance, container: Container): void {
  app.get("/integrations/github/status", { schema: { tags: ["github"] } }, async (req) => {
    const kind = container.github.kind;
    const repoCount = kind === "mock" ? 0 : 0;
    const { isGitHubOAuthConfigured } = await import("../../auth/github-oauth.js");
    const authenticated = !!(req as typeof req & { authenticated?: boolean }).authenticated;
    return {
      connected: kind === "real",
      kind,
      repoCount,
      sourceOfTruth: true,
      oauthConfigured: isGitHubOAuthConfigured(),
      authenticated,
      user: authenticated ? req.user : null,
    };
  });

  app.get("/github/repositories", { schema: { tags: ["github"] } }, async () => {
    try {
      return await container.github.listRepositories();
    } catch (err) {
      return { error: String(err) };
    }
  });

  app.get("/github/repositories/:owner/:name/branches", { schema: { tags: ["github"] } }, async (req) => {
    const { owner, name } = req.params as { owner: string; name: string };
    try {
      return await container.github.listBranches({ owner, name });
    } catch (err) {
      return { error: String(err) };
    }
  });

  app.get("/github/repositories/:owner/:name/commits", { schema: { tags: ["github"] } }, async (req) => {
    const { owner, name } = req.params as { owner: string; name: string };
    const q = req.query as { branch?: string };
    try {
      return await container.github.listCommits({ owner, name }, q.branch);
    } catch (err) {
      return { error: String(err) };
    }
  });

  app.post("/github/repositories/:owner/:name/branches", { schema: { tags: ["github"] } }, async (req) => {
    const { owner, name } = req.params as { owner: string; name: string };
    const b = req.body as Record<string, unknown>;
    try {
      return await container.github.createBranch({ owner, name }, String(b.name), String(b.baseSha));
    } catch (err) {
      return { error: String(err) };
    }
  });

  app.post("/github/repositories/:owner/:name/pull-requests", { schema: { tags: ["github"] } }, async (req) => {
    const { owner, name } = req.params as { owner: string; name: string };
    const b = req.body as Record<string, unknown>;
    try {
      return await container.github.createPullRequest(
        { owner, name },
        String(b.title),
        String(b.body ?? ""),
        String(b.head),
        String(b.base),
      );
    } catch (err) {
      return { error: String(err) };
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
    await eventBus.publish(normalizeEvent(event), {
      event,
      body: parsed,
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
