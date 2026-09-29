import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ *
 * The SPA registers /sw.js, which answers every same-origin GET —
 * including navigations — with respondWith(fetch(request)). The OAuth
 * login route 302-redirects to github.com, and a service worker that
 * answers a navigation with a (cross-origin) redirected response makes
 * the browser abort that navigation as a network error: the page
 * silently stays put, so "Redirecting to GitHub in 0s…" never leaves
 * the app and the write scope is never granted.
 *
 * These tests pin the fix: the worker must NOT answer /auth/* requests
 * (no respondWith → the browser performs the handshake natively) while
 * it keeps handling the app shell.
 * ------------------------------------------------------------------ */

type FetchListener = (event: {
  request: { url: string; method: string; mode: string; destination: string };
  respondWith: (p: Promise<unknown>) => Promise<unknown>;
}) => void;

function loadServiceWorker() {
  const listeners: Record<string, FetchListener[]> = {};
  const selfShim = {
    location: { origin: "http://codevia.test" },
    addEventListener: (name: string, fn: FetchListener) => {
      (listeners[name] ??= []).push(fn);
    },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const cacheStore = new Map<string, unknown>();
  const cachesShim = {
    open: async () => ({ put: async (req: unknown, res: unknown) => void cacheStore.set(String(req), res) }),
    keys: async () => [],
    match: async () => undefined,
    delete: async () => true,
  };
  const code = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  new Function("self", "caches", "fetch", "skipWaiting", "clients", code)(
    selfShim,
    cachesShim,
    async () => new Response("network", { status: 200 }),
    selfShim.skipWaiting,
    selfShim.clients,
  );
  return listeners;
}

describe("service worker vs the OAuth handshake", () => {
  const listeners = loadServiceWorker();

  /** Fire a synthetic fetch event; true when the worker called respondWith. */
  const handled = (url: string, mode = "navigate", destination = "document") => {
    let responded = false;
    const event = {
      request: { url, method: "GET", mode, destination },
      respondWith: () => {
        responded = true;
        return Promise.resolve(new Response("handled"));
      },
    };
    for (const fn of listeners.fetch ?? []) fn(event as never);
    return responded;
  };

  it("never answers the GitHub login navigation (the 302 to github.com must reach the browser)", () => {
    expect(handled("http://codevia.test/auth/github/login?scope=write&next=%23%2Fchat")).toBe(false);
  });

  it("never answers the OAuth callback navigation either", () => {
    expect(handled("http://codevia.test/auth/github/callback?code=x&state=y")).toBe(false);
  });

  it("leaves every other /auth request to the browser (session introspection, status)", () => {
    expect(handled("http://codevia.test/auth/me", "cors", "")).toBe(false);
    expect(handled("http://codevia.test/auth/github/status", "cors", "")).toBe(false);
  });

  it("still handles app-shell navigations (offline fallback keeps working)", () => {
    expect(handled("http://codevia.test/")).toBe(true);
    expect(handled("http://codevia.test/#/chat")).toBe(true);
  });

  it("still handles same-origin static assets", () => {
    expect(handled("http://codevia.test/app.js", "no-cors", "script")).toBe(true);
    expect(handled("http://codevia.test/app.css", "no-cors", "style")).toBe(true);
  });

  it("ignores non-GET requests and other origins as before", () => {
    const fired = (url: string, method: string) => {
      let responded = false;
      const event = {
        request: { url, method, mode: "cors", destination: "" },
        respondWith: () => {
          responded = true;
          return Promise.resolve(new Response("handled"));
        },
      };
      for (const fn of listeners.fetch ?? []) fn(event as never);
      return responded;
    };
    expect(fired("http://codevia.test/auth/logout", "POST")).toBe(false);
    expect(fired("https://github.com/login/oauth/authorize?x=1", "GET")).toBe(false);
  });
});
