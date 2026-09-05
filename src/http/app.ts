import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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
import { registerBackupRoutes } from "./routes/backup.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerAuthRoutes } from "./routes/auth.js";
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
        { name: "auth", description: "GitHub OAuth login & sessions" },
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
  const io = new SocketIOServer(app.server, {
    cors: { origin: true, credentials: true },
    transports: ["websocket", "polling"],
    allowUpgrades: true,
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1 * 1024 * 1024,
  });
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
  // Exact URL paths of the files in /public (e.g. "/app.js", "/app.css",
  // "/index.html"). Used by the auth guard to keep the SPA shell reachable.
  const staticAssetPaths = await listStaticAssetPaths(publicDir);

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
    registerAuthRoutes(app, container);
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
    registerBackupRoutes(app, container);
    registerApprovalRoutes(app, container);
  });

  // Global auth guard for everything not whitelisted. Public/unauthenticated
  // endpoints (health, docs, webhooks, the OAuth handshake, session
  // introspection) are skipped; everything else attaches the current user
  // context for permission checks.
  // Keep the public allowlist path-based and exact. `request.url` can contain a
  // query string (and some proxies can pass an absolute URL); comparing the raw
  // value made it too easy for a legitimate `/auth/me?…` request to miss the
  // allowlist and receive a 401 before its handler ran.
  const PUBLIC_PATHS = new Set([
    "/health",
    "/ready",
    "/live",
    "/docs",
    "/webhooks/github",
    "/integrations/telegram/webhook",
    "/auth/github/login",
    "/auth/github/callback",
    "/auth/github/status",
    // Session introspection must never 401: the SPA calls /auth/me on every
    // load to learn whether it is logged in, and /auth/logout is idempotent.
    // Both resolve the user from the session directly in their handlers and
    // answer `{ authenticated: false }` when logged out, so the UI can render
    // a login button instead of tripping the browser's 401 console noise.
    "/auth/me",
    "/auth/logout",
    "/integrations/github/status",
  ]);
  // Socket.io and Swagger expose subpaths below these public roots.
  // `/integrations/telegram/webhook/<accountId>` is a per-user bot webhook:
  // Telegram posts to it with no session cookie, so it must be public too.
  const PUBLIC_PATH_PREFIXES = ["/docs/", "/socket.io/", "/integrations/telegram/webhook/"];
  const requestPath = (url: string): string => {
    const raw = url.split("?")[0];
    if (/^https?:\/\//i.test(raw)) {
      try { return new URL(raw).pathname; } catch { /* use raw below */ }
    }
    return raw;
  };
  const isPublicPath = (url: string): boolean => {
    const pathname = requestPath(url);
    return PUBLIC_PATHS.has(pathname) || PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p));
  };
  // The SPA shell + its assets must always load, otherwise nobody can reach the
  // login button (and a 401 on /app.js renders a blank page). Data still goes
  // through the guarded API, so this exposes nothing beyond the static files.
  const isStaticAsset = (request: { method: string; url: string }): boolean => {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    return staticAssetPaths.has(requestPath(request.url));
  };
  const isSpaNavigation = (request: { method: string; url: string; headers: Record<string, unknown> }): boolean => {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    const pathname = requestPath(request.url);
    if (pathname.startsWith("/api")) return false;
    const accept = String(request.headers.accept ?? "");
    // Real browser navigations ask for HTML; API clients (fetch/XHR) don't.
    return accept.includes("text/html");
  };
  app.addHook("onRequest", async (request, reply) => {
    if (requestPath(request.url) === "/" || isPublicPath(request.url)) {
      return;
    }
    if (isStaticAsset(request) || (request.is404 && isSpaNavigation(request))) {
      return;
    }
    await authMiddleware({ container })(request, reply);
  });

  return { app, io };
}

export function getWebBaseUrl(): string {
  return getEnv().PUBLIC_WEB_BASE_URL ?? getEnv().WEB_BASE_URL;
}

/** Recursively list the files under `root` as URL paths ("/app.js", "/img/x.png"). */
async function listStaticAssetPaths(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch (err) {
    logger.warn("static asset directory not readable", { root, err: String(err) });
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // `parentPath` (Node ≥ 20.12) is the directory containing the entry; fall
    // back to the deprecated `path` alias on older runtimes.
    const parent = (entry as Dirent & { parentPath?: string }).parentPath ?? entry.path ?? root;
    const abs = join(parent, entry.name);
    const rel = relative(root, abs).split(sep).join("/");
    if (!rel || rel.startsWith("..")) continue;
    out.add("/" + rel);
  }
  return out;
}
