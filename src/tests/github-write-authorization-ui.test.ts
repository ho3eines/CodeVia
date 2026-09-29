import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ *
 * SPA side of "automatically request GitHub write access": when the user's
 * token cannot write, or a request answers with `githubAuthorization`, the UI
 * opens the consent prompt that links to `/auth/github/login?scope=write`
 * and returns to the current page afterwards.
 * ------------------------------------------------------------------ */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function boot(opts: { me: unknown; hash?: string; failing?: string }) {
  const pub = resolve(process.cwd(), "public");
  const dom = new JSDOM(readFileSync(resolve(pub, "index.html"), "utf8"), {
    url: `http://codevia.test/${opts.hash ?? "#/projects/p1"}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, any>;
  win.fetch = async (u: string) => {
    const path = String(u);
    if (path.startsWith("/auth/me")) return json(opts.me);
    if (opts.failing && path.startsWith(opts.failing)) {
      return json(
        {
          error: "sync failed",
          code: "github_authorization_required",
          githubAuthorization: {
            code: "github_authorization_required",
            reason: "no-token",
            message: "authorize",
            requiredScopes: ["repo"],
            grantedScopes: [],
            authorizeUrl: "/auth/github/login?scope=write",
          },
        },
        403,
      );
    }
    return json([]);
  };
  win.console.error = () => {};
  win.eval(readFileSync(resolve(pub, "app.js"), "utf8"));
  await new Promise((r) => setTimeout(r, 900));
  return { win, doc: win.document as Document };
}

const readOnlyMe = {
  authenticated: true,
  loginConfigured: true,
  requireAuth: false,
  user: { id: "u1", name: "alice", role: "admin" },
  githubToken: {
    stored: true,
    scopes: ["public_repo"],
    canWrite: false,
    writeAuthorizeUrl: "/auth/github/login?scope=write",
  },
};

describe("GitHub write-access prompt", () => {
  it("asks a signed-in user whose token is read-only to grant write access", async () => {
    const { doc } = await boot({ me: readOnlyMe });
    const box = doc.getElementById("gh-write-auth");
    expect(box, "write-access prompt opened").toBeTruthy();
    const link = doc.getElementById("gh-write-auth-go") as HTMLAnchorElement;
    const href = new URL(link.getAttribute("href") ?? "", "http://codevia.test");
    expect(href.pathname).toBe("/auth/github/login");
    expect(href.searchParams.get("scope")).toBe("write");
    expect(href.searchParams.get("next")).toBe("#/projects/p1");
  });

  it("does not prompt when the token can already write", async () => {
    const { doc } = await boot({ me: { ...readOnlyMe, githubToken: { ...readOnlyMe.githubToken, canWrite: true } } });
    expect(doc.getElementById("gh-write-auth")).toBeNull();
  });

  it("opens the prompt (with auto-redirect countdown) when a request needs authorization", async () => {
    const { doc } = await boot({
      me: { ...readOnlyMe, githubToken: { ...readOnlyMe.githubToken, canWrite: true } },
      hash: "#/projects",
      failing: "/projects",
    });
    expect(doc.getElementById("gh-write-auth"), "prompt opened from the 403").toBeTruthy();
    expect(doc.getElementById("gh-write-auth-seconds")).toBeTruthy();
    // "Later" closes it and stops the countdown.
    (doc.getElementById("gh-write-auth-later") as HTMLButtonElement).click();
    expect((doc.getElementById("modal-backdrop") as HTMLElement).hidden).toBe(true);
  });
});
