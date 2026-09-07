#!/usr/bin/env node
/**
 * CodeVia smoke test — one command, full end-to-end verification.
 *
 *   npm run smoke
 *
 * Boots the platform on an isolated port with a temp database + temp mock
 * GitHub snapshot, then verifies the whole product story: project creation
 * with selections → prompts built from selections → CodeVia/ folder in git →
 * autonomous task loop (research → build → QA) → commits/PRs/memory →
 * task files synced → pull/restore → restart persistence.
 *
 * Uses only node built-ins. Exits 1 on the first failed check.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT ?? 18080);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), "codevia-smoke-"));
const DB = join(TMP, "smoke.db");
const SNAP = join(TMP, "mock-github.json");

let server = null;
let serverLogs = "";
let failed = false;
const results = [];

function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "✅" : "❌"} ${name}${extra && !cond ? ` — ${extra}` : ""}`);
  if (!cond) {
    failed = true;
    throw new Error(`SMOKE FAILED: ${name}${extra ? ` (${extra})` : ""}`);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: res.status, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  server = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB, MOCK_GITHUB_PATH: SNAP, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverLogs += d.toString().slice(-4000)));
  server.stderr.on("data", (d) => (serverLogs += d.toString().slice(-4000)));
  const deadline = Date.now() + 45000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not boot in 45s\n" + serverLogs.slice(-2000));
    if (server.exitCode !== null) throw new Error(`server exited early (code ${server.exitCode})\n` + serverLogs.slice(-2000));
    await sleep(500);
  }
}

async function stopServer() {
  if (!server) return;
  server.kill("SIGTERM");
  const deadline = Date.now() + 10000;
  while (server.exitCode === null && Date.now() < deadline) await sleep(200);
  try {
    server.kill("SIGKILL");
  } catch {
    /* already dead */
  }
  server = null;
}

async function waitForTask(projectId, taskId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(`/projects/${projectId}/tasks`);
    const t = (r.json ?? []).find((x) => x.id === taskId);
    if (t && ["succeeded", "failed", "cancelled"].includes(t.status)) return t;
    if (Date.now() > deadline) return t ?? { status: "timeout" };
    await sleep(1500);
  }
}

async function main() {
  console.log(`🧪 CodeVia smoke — port ${PORT}, tmp ${TMP}`);
  try {
    await startServer();
    check("server boots + /health", true);

    // UI shell
    const idx = await api("/");
    check("UI index serves", idx.status === 200 && idx.text.includes("<!DOCTYPE") !== false, `status=${idx.status}`);
    const js = await api("/app.js");
    check("UI bundle serves", js.status === 200 && js.text.length > 10000, `status=${js.status}`);

    // Project with definition selections
    const created = await api("/projects", {
      method: "POST",
      body: {
        name: "Smoke Shop",
        description: "smoke verification project",
        configRepo: "demo/smoke",
        capabilities: {
          platforms: ["web", "mobile"],
          languages: ["csharp", "typescript"],
          frameworks: ["dotnet", "react"],
          databases: ["sqlserver"],
          deploymentTargets: ["docker"],
          features: ["auth", "payments"],
          integrations: ["telegram"],
        },
      },
    });
    check("create project with selections", created.status === 201, `status=${created.status}`);
    const pid = created.json.id;

    const ob = await api(`/projects/${pid}/onboard`, { method: "POST", body: {} });
    check("onboard generates roster", ob.status === 200 && ob.json.agents >= 10, JSON.stringify(ob.json));

    // Prompts built from selections
    const agents = (await api(`/projects/${pid}/agents`)).json ?? [];
    const research = agents.find((a) => a.type === "research");
    check("research unit exists + enabled", research?.enabled === true);
    check(
      "research prompt carries selections",
      research.systemPrompt.includes("Platforms: web, mobile") && research.systemPrompt.includes("Key features: auth, payments"),
    );

    // CodeVia/ folder in git
    const files = ((await api(`/projects/${pid}/files?path=CodeVia`)).json ?? []).map((f) => f.path);
    check("CodeVia/project.md synced", files.includes("CodeVia/project.md"), `${files.length} files`);
    check("CodeVia/agents/research.md synced", files.includes("CodeVia/agents/research.md"));
    check("CodeVia/skills.md + memory.md synced", files.includes("CodeVia/skills.md") && files.includes("CodeVia/memory.md"));

    // Autonomous task loop
    const ask = await api(`/projects/${pid}/ask`, {
      method: "POST",
      body: { title: "Add login page and API", description: "Build the login screen and the session endpoint", executionMode: "autonomous" },
    });
    check("autonomous ask accepted", ask.status === 200 && ask.json.task?.id, `status=${ask.status}`);
    const parent = await waitForTask(pid, ask.json.task.id);
    check("parent task completes", parent.status === "succeeded", `status=${parent.status} err=${parent.error ?? ""}`.slice(0, 200));

    const allTasks = (await api(`/projects/${pid}/tasks`)).json ?? [];
    const kids = allTasks.filter((t) => t.parentTaskId === parent.id);
    const types = kids.map((k) => k.agentType);
    const ordered = [...kids].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    check("research ran first", ordered.length > 0 && ordered[0].agentType === "research", ordered.map((k) => k.agentType).join(","));
    check("research → backend + frontend → QA", ["research", "backend-developer", "frontend-developer", "qa-test"].every((t) => types.includes(t)), types.join(","));
    check("every subtask succeeded", kids.every((k) => k.status === "succeeded"), kids.map((k) => `${k.agentType}=${k.status}`).join(","));

    const full = (await api(`/tasks/${parent.id}`)).json;
    const brief = full.input?.researchBrief ?? "";
    check("research brief stored on parent", brief.includes("Research brief for"), `${brief.length} chars`);
    check("brief embeds definition selections", brief.includes("Platforms: web, mobile") && brief.includes("Key features: auth, payments"));
    check(
      "every unit has an explicit duty",
      kids.filter((k) => k.agentType !== "research").every((k) => (k.description ?? "").includes("Your duty:")),
    );

    // Git artifacts
    const commits = (await api(`/projects/${pid}/commits?limit=20`)).json ?? [];
    check("implementers committed to git", commits.length >= 3, `${commits.length} commits`);
    const prs = (await api(`/projects/${pid}/pull-requests`)).json ?? [];
    check("implementers share one review PR", prs.length === 1, `${prs.length} PRs`);
    const mem = (await api(`/projects/${pid}/memory`)).json ?? [];
    check("research + QA saved memory", mem.length >= 2, `${mem.length} entries`);
    const taskFiles = ((await api(`/projects/${pid}/files?path=CodeVia/tasks`)).json ?? []).map((f) => f.path);
    check("task files synced to repo", taskFiles.length >= kids.length + 1, `${taskFiles.length} files`);
    const memFile = await api(`/projects/${pid}/file?path=CodeVia/memory.md`);
    check("CodeVia/memory.md manages memory", memFile.status === 200 && memFile.json.content.includes("### "), `status=${memFile.status}`);

    // Pull / restore
    const pull = await api(`/projects/${pid}/pull`, { method: "POST", body: {} });
    check("pull restores from git", pull.status === 200 && pull.json.agents > 0 && pull.json.tasks > 0, `status=${pull.status}`);

    // Continuity: merged work is extended, never overwritten
    const prsAll = (await api(`/projects/${pid}/pull-requests`)).json ?? [];
    const bePr = prsAll.find((p) => p.head.startsWith("agent-task-"));
    check("backend PR exists to merge", !!bePr);
    const be1 = kids.find((k) => k.agentType === "backend-developer");
    const mg = await api(`/projects/${pid}/pull-requests/${bePr.number}/merge`, { method: "POST", body: {} });
    check("merge brings code to main", mg.json?.merged === true, JSON.stringify(mg.json).slice(0, 120));
    const ask2 = await api(`/projects/${pid}/ask`, {
      method: "POST",
      body: { title: "Add login rate limiting", description: "Throttle login attempts per IP", executionMode: "autonomous" },
    });
    check("follow-up ask accepted", ask2.status === 200 && ask2.json.task?.id, `status=${ask2.status}`);
    const parent2 = await waitForTask(pid, ask2.json.task.id);
    check("follow-up completes", parent2.status === "succeeded", `status=${parent2.status}`);
    const prsNew = (await api(`/projects/${pid}/pull-requests`)).json ?? [];
    const v2 = await api(
      `/projects/${pid}/file?path=${encodeURIComponent("src/SmokeShop.Api/Controllers/LoginController.cs")}&branch=${encodeURIComponent(prsNew[0].head)}`,
    );
    const v2c = v2.json?.content ?? "";
    check("follow-up extends merged work (no overwrite)", v2c.includes("Existing implementation preserved") && v2c.includes(be1.id), `${v2c.length} chars`);
    check("follow-up adds its own TODOs", v2c.toLowerCase().includes("throttle"), `${v2c.length} chars`);
    const ctxFile = await api(`/projects/${pid}/file?path=${encodeURIComponent("CodeVia/context.md")}`);
    check("CodeVia/context.md tracks the entity", ctxFile.status === 200 && ctxFile.json.content.includes("LoginController.cs"), `status=${ctxFile.status}`);

    // Restart persistence: same DB + snapshot, zero re-onboard
    await stopServer();
    serverLogs = "";
    await startServer();
    const filesAfter = (await api(`/projects/${pid}/files?path=CodeVia`)).json ?? [];
    check("CodeVia/ folder survives restart", filesAfter.length >= files.length, `${filesAfter.length} vs ${files.length}`);
    const branches = await api(`/projects/${pid}/branches`);
    check("git history survives restart", branches.status === 200, `status=${branches.status}`);

    console.log(`\n🎉 SMOKE PASSED — ${results.filter((r) => r.ok).length}/${results.length} checks`);
  } finally {
    await stopServer();
    rmSync(TMP, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\n💥 ${err.message}`);
  if (failed) console.error("\n--- server log tail ---\n" + serverLogs.slice(-3000));
  stopServer()
    .catch(() => undefined)
    .finally(() => {
      rmSync(TMP, { recursive: true, force: true });
      process.exit(1);
    });
});
