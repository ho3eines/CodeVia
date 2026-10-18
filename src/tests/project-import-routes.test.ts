import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Container } from "../app/container.js";
import { buildServer } from "../http/app.js";
import { freshDb } from "./test-helpers.js";
import { getEnvFresh } from "../config/env.js";
import { makeZip } from "./zip-fixture.js";

/* ------------------------------------------------------------------ *
 * ZIP/RAR import and "new local project" through the HTTP layer:
 *   POST /projects/import, POST /projects/new-local
 *
 * An imported archive becomes a real local Git repository with one atomic
 * initial commit, so the agent can work on it immediately — and secret-bearing
 * files are excluded before anything is written.
 * ------------------------------------------------------------------ */

let app: FastifyInstance | undefined;
let container: Container;
let root: string;
let reposDir: string;
let cleanupDb: () => void;
const savedEnv: Record<string, string | undefined> = {};

const BOUNDARY = "----codevia-test-boundary";

function multipart(
  file: { filename: string; content: Buffer },
  fields: Record<string, string> = {},
  extraFiles: Array<{ filename: string; content: Buffer }> = [],
): { payload: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"),
    );
  }
  for (const item of [file, ...extraFiles]) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${item.filename}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
        "utf8",
      ),
      item.content,
      Buffer.from("\r\n", "utf8"),
    );
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, "utf8"));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "project-import-"));
  reposDir = join(root, "repos");
  for (const key of ["CODEVIA_ALLOWED_ROOTS", "LOCAL_REPOS_DIR", "LOCAL_GIT_OWNER", "REQUIRE_AUTH"])
    savedEnv[key] = process.env[key];
  process.env.CODEVIA_ALLOWED_ROOTS = root;
  process.env.LOCAL_REPOS_DIR = reposDir;
  process.env.LOCAL_GIT_OWNER = "local";
  delete process.env.REQUIRE_AUTH;
  getEnvFresh();
  cleanupDb = freshDb().cleanup;
  container = new Container();
  await container.ensureSeed();
  const built = await buildServer(container);
  app = built.app;
  await app.ready();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  cleanupDb();
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key]!;
  }
  getEnvFresh();
});

const packageJson = JSON.stringify({
  name: "imported-demo",
  scripts: { build: "tsc", test: "vitest run" },
  dependencies: { fastify: "^5.0.0" },
});

describe("POST /projects/import", () => {
  it("imports a ZIP as a local Git project with one initial commit", async () => {
    const zip = makeZip([
      { path: "demo-main/package.json", content: packageJson },
      { path: "demo-main/src/index.ts", content: "export {};" },
      { path: "demo-main/README.md", content: "# Demo" },
      { path: "demo-main/.env", content: "CANARY_SECRET=do-not-commit" },
    ]);
    const body = multipart({ filename: "demo-main.zip", content: zip });
    const res = await app!.inject({
      method: "POST",
      url: "/projects/import",
      headers: { "content-type": body.contentType },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(201);
    const project = res.json();
    expect(project.name).toBe("demo");
    expect(project.sourceType).toBe("local");
    expect(project.configRepo).toMatch(/^local\//);
    expect(project.analysis.languages.join(",")).toMatch(/JavaScript|TypeScript/);
    expect(project.commands.test).toBe("npm test");
    expect(project.commands.build).toBe("npm run build");

    // The wrapper directory is stripped and the secret file never lands on disk.
    const repoDir = join(reposDir, project.configRepo);
    expect(readFileSync(join(repoDir, "package.json"), "utf8")).toBe(packageJson);
    expect(existsSync(join(repoDir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(repoDir, "demo-main"))).toBe(false);
    expect(existsSync(join(repoDir, ".env"))).toBe(false);
    expect(project.analysis.warnings.join("\n")).toMatch(/secret-bearing file/i);

    // And it is a real Git repository with a committed tree.
    const branches = await container.localGit.listBranches({ owner: "local", name: project.configRepo.split("/")[1] });
    expect(branches.length).toBeGreaterThan(0);

    const detail = await app!.inject({ method: "GET", url: `/projects/${project.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(project.id);
  });

  it("accepts an explicit name/slug and rejects unsupported archives", async () => {
    const zip = makeZip([{ path: "README.md", content: "# x" }]);
    const ok = multipart({ filename: "archive.zip", content: zip }, { name: "My Import", slug: "my-import" });
    const created = await app!.inject({
      method: "POST",
      url: "/projects/import",
      headers: { "content-type": ok.contentType },
      payload: ok.payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().slug).toBe("my-import");

    const txt = multipart({ filename: "archive.txt", content: zip });
    const rejected = await app!.inject({
      method: "POST",
      url: "/projects/import",
      headers: { "content-type": txt.contentType },
      payload: txt.payload,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toMatch(/only \.zip and \.rar/i);
  });

  it("rejects more than one uploaded file", async () => {
    const zip = makeZip([{ path: "README.md", content: "# x" }]);
    const body = multipart({ filename: "a.zip", content: zip }, {}, [{ filename: "b.zip", content: zip }]);
    const res = await app!.inject({
      method: "POST",
      url: "/projects/import",
      headers: { "content-type": body.contentType },
      payload: body.payload,
    });
    // @fastify/multipart enforces `limits.files: 1` before the handler runs.
    expect(res.statusCode).toBe(413);
  });

  it("rejects a non-multipart request", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/projects/import",
      headers: { "content-type": "application/json" },
      payload: { filename: "x.zip" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/multipart/i);
  });
});

describe("POST /projects/new-local", () => {
  it("creates an empty local Git project with a README commit", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/projects/new-local",
      payload: { name: "Fresh Project", description: "start here" },
    });
    expect(res.statusCode).toBe(201);
    const project = res.json();
    expect(project.slug).toBe("fresh-project");
    expect(project.configRepo).toBeTruthy();
    const repoDir = join(reposDir, project.configRepo);
    expect(readFileSync(join(repoDir, "README.md"), "utf8")).toContain("# Fresh Project");
  });

  it("validates the name and rejects a duplicate slug", async () => {
    const bad = await app!.inject({ method: "POST", url: "/projects/new-local", payload: { name: "" } });
    expect(bad.statusCode).toBe(400);

    const first = await app!.inject({ method: "POST", url: "/projects/new-local", payload: { name: "Same Name" } });
    expect(first.statusCode).toBe(201);
    const second = await app!.inject({ method: "POST", url: "/projects/new-local", payload: { name: "Same Name" } });
    expect(second.statusCode).toBe(409);
  });
});
