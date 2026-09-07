import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { getEnvFresh } from "../config/env.js";
import { freshDb } from "./test-helpers.js";
import type { FastifyInstance } from "fastify";

/* ------------------------------------------------------------------ *
 * Regression tests for the fail-closed GitHub webhook route:
 *   - with no GITHUB_WEBHOOK_SECRET configured, deliveries are rejected
 *     (503) and never trigger agent automation;
 *   - with a secret, valid signatures are accepted (202 + automation)
 *     and invalid signatures are rejected (401).
 * ------------------------------------------------------------------ */

const SECRET = "test-webhook-secret-for-fail-closed-0123456789";

let savedEnv: Record<string, string | undefined>;
let cleanup: (() => void) | undefined;
let app: FastifyInstance | undefined;
let container: Container;

async function boot(): Promise<FastifyInstance> {
  container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
  return app;
}

function setWebhookSecret(value: string | undefined): void {
  if (value === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = value;
  getEnvFresh();
}

function signedHeaders(event: string, body: string, secret: string, delivery = "delivery-1"): Record<string, string> {
  return {
    "x-github-event": event,
    "x-github-delivery": delivery,
    "content-type": "application/json",
    "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
  };
}

beforeEach(() => {
  savedEnv = { GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET };
  cleanup = freshDb().cleanup;
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  container?.githubAutomation.stop();
  if (savedEnv.GITHUB_WEBHOOK_SECRET === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = savedEnv.GITHUB_WEBHOOK_SECRET;
  getEnvFresh();
  cleanup?.();
});

describe("GitHub webhook route fails closed without a signing secret", () => {
  it("rejects deliveries with 503 and runs no automation", async () => {
    setWebhookSecret(undefined);
    const srv = await boot();
    const project = await container.agentManager.createProject({ name: "Hook", description: "x", configRepo: "acme/hook" });
    const res = await srv.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "push", "x-github-delivery": "u1", "content-type": "application/json" },
      payload: { repository: { full_name: "acme/hook" }, ref: "refs/heads/main" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().ok).toBe(false);
    // The unauthenticated delivery must not have triggered agent automation.
    expect(container.taskRepo.byProject(project.id)).toHaveLength(0);
  });
});

describe("GitHub webhook route with a signing secret configured", () => {
  beforeEach(() => {
    setWebhookSecret(SECRET);
  });

  it("accepts a validly signed delivery and routes the event", async () => {
    const srv = await boot();
    const project = await container.agentManager.createProject({ name: "Signed", description: "x", configRepo: "acme/signed" });
    const body = JSON.stringify({ repository: { full_name: "acme/signed" }, ref: "refs/heads/main" });
    const res = await srv.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: signedHeaders("push", body, SECRET),
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().ok).toBe(true);
    expect(container.taskRepo.byProject(project.id).length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a tampered delivery with 401 and runs no automation", async () => {
    const srv = await boot();
    const project = await container.agentManager.createProject({ name: "Tamper", description: "x", configRepo: "acme/tamper" });
    const body = JSON.stringify({ repository: { full_name: "acme/tamper" }, ref: "refs/heads/main" });
    const res = await srv.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: signedHeaders("push", body + " ", SECRET), // signed over a different body
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().ok).toBe(false);
    expect(container.taskRepo.byProject(project.id)).toHaveLength(0);
  });
});
