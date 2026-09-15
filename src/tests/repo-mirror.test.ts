import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoMirrorService, type MirrorGitResult, type MirrorRunner } from "../github/repo-mirror.js";

/* ------------------------------------------------------------------ *
 * Read-only local mirror (the "clone the project first" half of the
 * request). These tests run the real `git` binary against a local
 * fixture repository — no network, no GitHub, no code execution.
 *
 * The mirror must:
 *  - give the platform the whole tree, any file and a real `git grep`
 *    without spending GitHub requests,
 *  - never run repository code (plumbing only, fixed argv, no shell),
 *  - never persist or log the credential,
 *  - never serve one account's private clone to another account.
 * ------------------------------------------------------------------ */

let tmp = "";
let fixture = "";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "codevia-mirror-"));
  fixture = join(tmp, "fixture");
  mkdirSync(fixture, { recursive: true });
  git(["init", "-b", "main"], fixture);
  git(["config", "user.email", "fixture@codevia.test"], fixture);
  git(["config", "user.name", "Fixture"], fixture);
  writeFileSync(join(fixture, "README.md"), "# Tarazin\nFive-layer ERP.\n");
  writeFileSync(join(fixture, "package.json"), '{ "name": "fixture", "version": "1.0.0" }\n');
  mkdirSync(join(fixture, "src/Data"), { recursive: true });
  writeFileSync(join(fixture, "src/Data/DbContext.cs"), "public class DbContext {\n  public void Save() { }\n}\n");
  writeFileSync(join(fixture, "src/program.ts"), "export const secretSauce = 42;\n");
  mkdirSync(join(fixture, ".github/workflows"), { recursive: true });
  writeFileSync(join(fixture, ".github/workflows/ci.yml"), "name: ci\non: [push]\n");
  git(["add", "-A"], fixture);
  git(["commit", "-q", "-m", "fixture: initial"], fixture);
  git(["branch", "release-9"], fixture);
}, 60000);

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** A mirror service rooted in a temp dir, cloning from the local fixture. */
function makeMirror(opts: { scopeRoot?: string; run?: MirrorRunner; refreshMs?: number; enabled?: boolean } = {}) {
  const root = join(tmp, opts.scopeRoot ?? `mirrors-${Math.random().toString(36).slice(2, 8)}`);
  return new RepoMirrorService({
    root,
    enabled: opts.enabled ?? true,
    urlTemplate: `file://${fixture}`,
    refreshMs: opts.refreshMs ?? 300_000,
    timeoutMs: 30_000,
    readTimeoutMs: 15_000,
    run: opts.run,
  });
}

/** Recording runner: captures argv + env so credential handling can be asserted. */
function recordingRunner(): { run: MirrorRunner; calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const run: MirrorRunner = async (args, opts) => {
    calls.push({ args, env: opts.env ?? {} });
    return new Promise<MirrorGitResult>((res) => {
      execFileLike(args, opts, res);
    });
  };
  return { run, calls };
}

/** Same as the service's default runner, but exposed for the recording wrapper. */
function execFileLike(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number },
  res: (r: MirrorGitResult) => void,
): void {
  try {
    const stdout = execFileSync(args[0]!, args.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    res({ stdout: String(stdout ?? ""), stderr: "", code: 0 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    res({
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
      code: typeof e.status === "number" ? e.status : 1,
    });
  }
}

describe("repository mirror — local, read-only, whole-repository", () => {
  it("clones once and then answers tree/file/grep locally", async () => {
    const mirror = makeMirror();
    const state = await mirror.sync("acme/widget", { scope: "user-1" });
    expect(state.ready, JSON.stringify(state)).toBe(true);
    expect(state.exists).toBe(true);
    expect(state.defaultBranch).toBe("main");
    expect(state.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(state.sizeMb).toBeGreaterThanOrEqual(0);
    expect(state.path!.endsWith("acme/widget.git")).toBe(true);

    const files = await mirror.listFiles("acme/widget", { scope: "user-1", branch: "main" });
    expect(files).toContain("README.md");
    expect(files).toContain("src/Data/DbContext.cs");
    expect(files).toContain(".github/workflows/ci.yml");

    const subset = await mirror.listFiles("acme/widget", { scope: "user-1", branch: "main", prefix: "src" });
    expect(subset!.every((p) => p.startsWith("src/"))).toBe(true);

    const readme = await mirror.readFile("acme/widget", "README.md", { scope: "user-1", branch: "main" });
    expect(readme).toContain("Five-layer ERP");

    // What the REST API cannot do at all: a real content search with line numbers.
    const hits = await mirror.search("acme/widget", "secretSauce", { scope: "user-1", branch: "main" });
    expect(hits!.length).toBeGreaterThan(0);
    expect(hits![0].path).toBe("src/program.ts");
    expect(hits![0].line).toBe(1);
    expect(hits![0].text).toContain("secretSauce = 42");

    // Another branch of the same mirror, with no second clone.
    const other = await mirror.listFiles("acme/widget", { scope: "user-1", branch: "release-9" });
    expect(other).toContain("README.md");
  }, 90000);

  it("reads nothing when the branch does not exist (instead of guessing a ref)", async () => {
    const mirror = makeMirror();
    await mirror.sync("acme/widget", { scope: "user-1" });
    expect(await mirror.listFiles("acme/widget", { scope: "user-1", branch: "nope" })).toBeUndefined();
    expect(await mirror.readFile("acme/widget", "README.md", { scope: "user-1", branch: "nope" })).toBeUndefined();
  }, 60000);

  it("does not re-fetch while the mirror is fresh, and does on force", async () => {
    const { run, calls } = recordingRunner();
    const mirror = makeMirror({ run, refreshMs: 60_000 });
    await mirror.sync("acme/widget", { scope: "user-1" });
    const afterClone = calls.filter((c) => c.args.includes("remote") || c.args.includes("clone")).length;
    expect(afterClone).toBe(1); // exactly one clone

    await mirror.listFiles("acme/widget", { scope: "user-1", branch: "main" });
    await mirror.readFile("acme/widget", "README.md", { scope: "user-1", branch: "main" });
    expect(calls.filter((c) => c.args.includes("clone") || c.args.includes("remote")).length).toBe(1);

    await mirror.sync("acme/widget", { scope: "user-1", force: true });
    expect(calls.filter((c) => c.args.includes("remote")).length).toBe(1); // one refresh
  }, 90000);

  it("keeps one mirror per account scope — a private clone is never shared", async () => {
    const mirror = makeMirror();
    const a = await mirror.sync("acme/widget", { scope: "user-a" });
    const b = await mirror.sync("acme/widget", { scope: "user-b" });
    expect(a.path).not.toBe(b.path);
    expect(a.scope).not.toBe(b.scope);
    const anon = await mirror.sync("acme/widget");
    expect(anon.scope).toBe("public");
    expect(anon.path).not.toBe(a.path);
  }, 90000);

  it("passes the credential through git config env only — never in argv, never in the clone config", async () => {
    const { run, calls } = recordingRunner();
    const mirror = makeMirror({ run });
    const token = "ghp_supersecrettoken123";
    const state = await mirror.sync("acme/widget", { scope: "user-1", token });
    expect(state.ready).toBe(true);
    const clone = calls.find((c) => c.args.includes("clone"))!;
    expect(clone.args.join(" ")).not.toContain(token);
    expect(clone.env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(clone.env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: bearer ${token}`);
    expect(clone.env.GIT_TERMINAL_PROMPT).toBe("0");
    // The mirrored repository's own config must not contain the credential.
    const config = execFileSync("git", ["config", "--local", "--list"], {
      cwd: state.path!,
      encoding: "utf8",
    });
    expect(config).not.toContain(token);
    expect(config).toContain(`url=file://${fixture}`);
  }, 90000);

  it("refuses unsafe repository names, refs and paths", async () => {
    const mirror = makeMirror();
    expect((await mirror.sync("../escape", { scope: "u" })).blocker).toBe("invalid-repo");
    expect((await mirror.sync("acme/../../etc", { scope: "u" })).blocker).toBe("invalid-repo");
    expect(mirror.mirrorPath("acme/..")).toBeUndefined();
    await mirror.sync("acme/widget", { scope: "user-1" });
    expect(
      await mirror.readFile("acme/widget", "../../etc/passwd", { scope: "user-1", branch: "main" }),
    ).toBeUndefined();
    expect(
      await mirror.readFile("acme/widget", "--upload-pack=evil", { scope: "user-1", branch: "main" }),
    ).toBeUndefined();
    expect(await mirror.listFiles("acme/widget", { scope: "user-1", branch: "-x" })).toBeUndefined();
    expect(await mirror.search("acme/widget", "", { scope: "user-1", branch: "main" })).toBeUndefined();
  }, 90000);

  it("is disabled cleanly, and refuses an over-cap repository without cloning", async () => {
    const off = makeMirror({ enabled: false });
    const state = await off.sync("acme/widget", { scope: "u" });
    expect(state.enabled).toBe(false);
    expect(state.ready).toBe(false);
    expect(state.blocker).toBe("disabled");
    expect(await off.listFiles("acme/widget", { scope: "u" })).toBeUndefined();

    const mirror = makeMirror();
    const huge = await mirror.sync("acme/widget", { scope: "u", sizeKb: 5 * 1024 * 1024 });
    expect(huge.blocker).toBe("too-large");
    expect(huge.ready).toBe(false);
    expect(existsSync(huge.path!)).toBe(false);
  }, 60000);

  it("reports a failed clone as a blocker and leaves nothing on disk", async () => {
    const run: MirrorRunner = async (args, opts) => {
      if (args.includes("clone")) return { stdout: "", stderr: "fatal: repository not found", code: 128 };
      return execFileLikeResult(args, opts);
    };
    const mirror = makeMirror({ run });
    const state = await mirror.sync("acme/ghost", { scope: "u" });
    expect(state.ready).toBe(false);
    expect(state.blocker).toBe("clone-failed");
    expect(state.error).toContain("repository not found");
    expect(existsSync(state.path!)).toBe(false);
  }, 60000);

  it("keeps serving the current copy when a refresh fails", async () => {
    const mirror = makeMirror();
    const first = await mirror.sync("acme/widget", { scope: "user-1" });
    expect(first.ready).toBe(true);
    // Break the network for the refresh only.
    const broken = new RepoMirrorService({
      root: mirror.mirrorRoot,
      // Explicit: under `vitest` the mirror defaults to OFF (a clone is a real
      // operation), and this case is about a failing refresh, not a disabled one.
      enabled: true,
      urlTemplate: `file://${fixture}`,
      run: async (args, opts) =>
        args.includes("remote")
          ? { stdout: "", stderr: "fatal: unable to access remote", code: 1 }
          : execFileLikeResult(args, opts),
    });
    const state = await broken.sync("acme/widget", { scope: "user-1", force: true });
    expect(state.ready).toBe(true); // stale but usable
    const files = await broken.listFiles("acme/widget", { scope: "user-1", branch: "main" });
    expect(files).toContain("README.md");
  }, 90000);

  it("removes a mirror on demand (privacy / disk hygiene)", async () => {
    const mirror = makeMirror();
    const state = await mirror.sync("acme/widget", { scope: "user-1" });
    expect(existsSync(state.path!)).toBe(true);
    expect(await mirror.remove("acme/widget", "user-1")).toBe(true);
    expect(existsSync(state.path!)).toBe(false);
    expect(await mirror.remove("acme/widget", "user-1")).toBe(false);
    expect(mirror.diskUsageMb()).toBeGreaterThanOrEqual(0);
  }, 60000);
});

function execFileLikeResult(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number },
): Promise<MirrorGitResult> {
  return new Promise((res) => execFileLike(args, opts, res));
}
