import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getEnvFresh } from "../config/env.js";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";

/* The SPA shell is edited constantly in development. When @fastify/static
 * answered conditional requests with 304, browsers kept a stale app.css/app.js
 * forever and UI changes appeared not to deploy. These tests pin the fix. */

let cleanup: (() => void) | undefined;
let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.REQUIRE_AUTH;
  getEnvFresh();
  cleanup = freshDb().cleanup;
  const container = new Container();
  await container.ensureSeed();
  app = (await buildServer(container)).app;
  await app.ready();
}, 30000);

afterAll(async () => {
  await app?.close();
  cleanup?.();
});

describe("static shell caching (development)", () => {
  it("serves the shell with cache-busting asset URLs", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    // Each asset carries a hash of its own contents.
    const css = /\/app\.css\?v=([a-f0-9]{10})/.exec(res.body);
    const js = /\/app\.js\?v=([a-f0-9]{10})/.exec(res.body);
    expect(css, "app.css is not version-stamped").not.toBeNull();
    expect(js, "app.js is not version-stamped").not.toBeNull();
    expect(css![1]).not.toBe(js![1]);
    expect(res.body).not.toContain("?v=DEV");
  });

  it("never lets the browser cache the shell HTML", async () => {
    for (const url of ["/", "/index.html", "/#/dashboard"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(String(res.headers["cache-control"]), url).toContain("no-store");
    }
  });

  it("serves static assets uncached and without validators", async () => {
    for (const url of ["/app.css", "/app.js"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(String(res.headers["cache-control"]), url).toContain("no-store");
      // No ETag/Last-Modified means no conditional request can produce a 304.
      expect(res.headers.etag, `${url} still sends an ETag`).toBeUndefined();
      expect(res.headers["last-modified"], `${url} still sends Last-Modified`).toBeUndefined();
    }
  });

  it("answers a stale conditional request with fresh content, not 304", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/app.css",
      headers: { "if-none-match": 'W/"deadbeef"', "if-modified-since": "Wed, 01 Jan 2020 00:00:00 GMT" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(1000);
  });

  it("still serves the current stylesheet and script contents", async () => {
    const css = await app.inject({ method: "GET", url: "/app.css" });
    expect(css.body).toContain('[data-theme="light"]');
    expect(css.body).toContain(".theme-switch");
    const js = await app.inject({ method: "GET", url: "/app.js" });
    expect(js.body).toContain("live-label");
  });
});
