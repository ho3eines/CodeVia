import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Server as SocketIOServer } from "socket.io";
import type { Container } from "../app/container.js";
import { live } from "../realtime/live.js";
import { logger } from "../logger.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerModelRoutes } from "./routes/models-providers.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerTaskRoutes } from "./routes/tasks-runs.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerTelegramRoutes } from "./routes/telegram.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { authMiddleware } from "./auth.js";
import { getEnv } from "../config/env.js";

export interface BuildServerResult {
  app: FastifyInstance;
  io: SocketIOServer;
}

/**
 * Builds the Fastify server (REST + Swagger) and ties the Socket.io realtime bus
 * to the `live` broadcaster. Routes expose the platform's resources; a small auth
 * middleware attaches the current user for permission checks.
 */
export async function buildServer(container: Container): Promise<BuildServerResult> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  // Accept empty JSON bodies (e.g. POST /tasks/:id/run, /projects/:id/activate)
  // so body-less requests with a `Content-Type: application/json` header (as the
  // SPA sends) don't trip Fastify's `FST_ERR_CTP_EMPTY_JSON_BODY`.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = body == null ? "" : String(body);
      if (!text.trim()) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await app.register(cors, { origin: true });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "CodeVia — AI Engineering Agent Platform API",
        description: "Multi-project, GitHub-centric, multi-agent, multi-model, Telegram-controlled platform.",
        version: "0.1.0",
      },
      tags: [
        { name: "health", description: "Health & readiness" },
        { name: "dashboard", description: "Dashboards" },
        { name: "projects", description: "Projects & AI onboarding" },
        { name: "agents", description: "Agent registry & execution" },
        { name: "models", description: "Model registry" },
        { name: "providers", description: "Model providers" },
        { name: "skills", description: "Skill marketplace" },
        { name: "workflows", description: "Workflow engine" },
        { name: "tasks", description: "Tasks & runs" },
        { name: "runs", description: "AI run console" },
        { name: "memory", description: "GitHub-backed memory" },
        { name: "github", description: "GitHub integration & webhooks" },
        { name: "telegram", description: "Telegram integration" },
        { name: "conversations", description: "Conversations" },
        { name: "settings", description: "Settings, import/export, backup" },
        { name: "search", description: "Global search" },
        { name: "observability", description: "Cost, audit, notifications" },
        { name: "admin", description: "Admin & health" },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  // Realtime: Socket.io broadcast; only observable status/step/result, never CoT.
  const io = new SocketIOServer(app.server, { cors: { origin: "*" }, transports: ["websocket", "polling"] });
  live.bind({
    emit: (event) => io.emit(event.type, event),
  });
  io.on("connection", (socket) => {
    logger.debug("client connected", { socketId: socket.id });
    socket.on("disconnect", () => logger.debug("client disconnected", { socketId: socket.id }));
  });

  // Serve the SPA + static assets from /public.
  const publicDir = resolve(process.cwd(), "public");
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    wildcard: false,
  });

  // SPA fallback: unknown non-API GET routes render index.html (hash routing).
  app.setNotFoundHandler(async (request, reply) => {
    const url = request.url.split("?")[0];
    if (request.method === "GET" && !url.startsWith("/api") && !url.startsWith("/docs")) {
      const html = await readFile(resolve(publicDir, "index.html"), "utf8");
      reply.type("text/html");
      return reply.send(html);
    }
    reply.code(404);
    return { error: "not found", url };
  });

  // All routes except health and docs require an authenticated user context.
  const guarded = (handler: (app: FastifyInstance) => void) => {
    handler(app);
  };

  registerHealthRoutes(app, container);
  guarded(() => {
    registerDashboardRoutes(app, container);
    registerProjectRoutes(app, container);
    registerAgentRoutes(app, container);
    registerModelRoutes(app, container);
    registerSkillRoutes(app, container);
    registerWorkflowRoutes(app, container);
    registerTaskRoutes(app, container);
    registerMemoryRoutes(app, container);
    registerGithubRoutes(app, container);
    registerTelegramRoutes(app, container);
    registerConversationRoutes(app, container);
    registerSettingsRoutes(app, container);
    registerSearchRoutes(app, container);
    registerObservabilityRoutes(app, container);
    registerAdminRoutes(app, container);
  });

  // Global auth guard for everything not whitelisted. Public/unauthenticated
  // endpoints (health, docs, webhooks) are skipped; everything else attaches the
  // current user context for permission checks.
  const PUBLIC_PREFIXES = ["/health", "/ready", "/live", "/docs", "/webhooks/github", "/integrations/telegram/webhook"];
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url;
    if (url === "/" || PUBLIC_PREFIXES.some((p) => url.startsWith(p))) {
      return;
    }
    await authMiddleware({ container })(request, reply);
  });

  return { app, io };
}

export function getWebBaseUrl(): string {
  return getEnv().PUBLIC_WEB_BASE_URL ?? getEnv().WEB_BASE_URL;
}
