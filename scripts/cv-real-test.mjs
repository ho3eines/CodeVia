#!/usr/bin/env node
/*
 * cv-real-test.mjs — REAL provider/model test for a running CodeVia instance.
 *
 * Runs against the platform's own test API, so the production instance does
 * the actual network calls with its own stored (encrypted) keys. Nothing
 * secret ever touches this script or this machine.
 *
 * What it does:
 *   1. health check
 *   2. for each target provider: live catalog test (GET the provider's real
 *      model-catalog endpoint, read-only, ~1 request)
 *   3. for every saved model of the target providers: ONE real chat
 *      completion ("Reply with exactly: OK") via POST /models/:id/test
 *   4. prints a readable report + writes <out.json>
 *
 * Usage (Node 18+):
 *   node cv-real-test.mjs [base-url] [options]
 *   base-url   defaults to https://codevia-production.up.railway.app
 *   --names A,B,C        provider names to test (default: OpenRouter,nvidia,Qween)
 *   --filter substring   only test models whose id contains this
 *   --limit N            cap on number of model chat tests
 *   --conc N             concurrency for model tests (default 4)
 *   --out FILE           results JSON path (default ./cv-real-test-results.json)
 *   --timeout MS         per-request timeout (default 20000)
 *   SESSION_TOKEN=...    set this env var ONLY if the instance uses strict
 *                        auth (REQUIRE_AUTH=true) — a GitHub-login session token
 */

const BASE = (process.argv[2] ?? "https://codevia-production.up.railway.app").replace(/\/+$/, "");
const args = process.argv.slice(3);
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const NAMES = opt("--names", "OpenRouter,nvidia,Qween")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FILTER = opt("--filter", "");
const LIMIT = Number(opt("--limit", "0")) || Infinity;
const CONC = Math.max(1, Number(opt("--conc", "4")) || 4);
const OUT = opt("--out", "./cv-real-test-results.json");
const SESSION = process.env.SESSION_TOKEN;

let aborted = false;
const ctrl = new AbortController();
setTimeout(
  () => {
    aborted = true;
    ctrl.abort();
  },
  10 * 60 * 1000,
).unref(); // hard stop 10 min

async function api(path, method = "GET", body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(SESSION ? { authorization: `Bearer ${SESSION}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: ctrl.signal,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

function short(s, n = 160) {
  s = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function main() {
  const report = {
    at: new Date().toISOString(),
    base: BASE,
    providers: [],
    models: [],
    errors: [],
  };

  // 1. health
  const h = await api("/health");
  console.log(`[health] ${h.status} ${short(h.text, 120)}`);
  if (h.status === 401) {
    console.error("401 — instance uses strict auth. Re-run with SESSION_TOKEN=<github-login session token>");
    process.exit(2);
  }
  if (h.status >= 500 || h.status === 404) throw new Error(`instance not reachable/healthy: HTTP ${h.status}`);

  // 2. providers
  const stP = await api("/providers");
  const pList = Array.isArray(stP.json) ? stP.json : (stP.json?.providers ?? []);
  const targets = pList.filter((p) => NAMES.includes(p.name));
  if (!targets.length)
    throw new Error(
      `none of the requested providers found: ${NAMES.join(",")} (have: ${pList.map((p) => p.name).join(", ")})`,
    );
  for (const t of targets)
    console.log(
      `[provider] ${t.name} -> ${t.baseUrl} (secretRef=${t.secretRef || "none"}, keyPresent=${t.keyPresent})`,
    );

  // 3. models of the targets
  const stM = await api("/models");
  const mAll = Array.isArray(stM.json) ? stM.json : (stM.json?.models ?? []);
  const pids = new Set(targets.map((t) => t.id));
  let models = mAll.filter((m) => pids.has(m.providerId) && (!FILTER || m.modelId.includes(FILTER)));
  const total = models.length;
  if (models.length > LIMIT) models = models.slice(0, LIMIT);
  const pName = Object.fromEntries(targets.map((t) => [t.id, t.name]));
  console.log(
    `[plan] catalog tests=${targets.length}, model chat tests=${models.length} of ${total} (concurrency ${CONC})`,
  );

  // 4. catalog tests (one per provider, uses that provider's first model id)
  for (const t of targets) {
    const first = mAll.find((m) => m.providerId === t.id);
    const row = { provider: t.name, baseUrl: t.baseUrl };
    try {
      const r = await api("/models/test", "POST", { providerId: t.id, modelId: first ? first.modelId : "probe" });
      row.catalog = r.json;
      report.providers.push(row);
      const c = r.json ?? {};
      console.log(
        `[catalog] ${t.name}: ok=${c.ok} checked=${c.checked} status=${c.status ?? "-"} latency=${c.latencyMs ?? "-"}ms modelsFound=${Array.isArray(c.models) ? c.models.length : "-"} :: ${short(c.message)}`,
      );
    } catch (e) {
      row.error = String(e);
      report.providers.push(row);
      console.log(`[catalog] ${t.name}: ERROR ${short(e.message)}`);
    }
  }

  // 5. model chat tests — one REAL completion each
  let i = 0,
    done = 0;
  report.models = new Array(models.length);
  const t0 = Date.now();
  async function worker() {
    while (!aborted) {
      const idx = i++;
      if (idx >= models.length) return;
      const m = models[idx];
      const row = { provider: pName[m.providerId], modelId: m.modelId, id: m.id };
      try {
        const r = await api(`/models/${encodeURIComponent(m.id)}/test`, "POST", {});
        const c = r.json ?? {};
        row.http = r.status;
        row.ok = c.ok;
        row.checked = c.checked;
        row.transport = c.transport;
        row.status = c.status;
        row.latencyMs = c.latencyMs;
        row.keyPresent = c.keyPresent;
        row.url = c.url;
        row.message = c.message;
        row.responseText = c.responseText;
        row.usage = c.usage;
      } catch (e) {
        row.error = String(e);
      }
      report.models[idx] = row;
      done++;
      const mark = row.ok ? "✔" : row.checked ? "✘" : "◌";
      console.log(
        `${mark} ${row.provider}/${row.modelId}  ok=${row.ok ?? "-"} http=${row.http ?? "-"} status=${row.status ?? "-"} ${row.latencyMs != null ? row.latencyMs + "ms" : ""}  ${short(row.responseText ? "reply: " + row.responseText : (row.message ?? row.error), 110)}`,
      );
      if (done % 25 === 0)
        console.log(`  …${done}/${models.length} (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // 6. summary
  const by = {};
  for (const r of report.models) {
    const k = r.provider ?? "?";
    by[k] ??= { total: 0, ok: 0, networkFail: 0, notChecked: 0, byStatus: {} };
    by[k].total++;
    if (r.ok) by[k].ok++;
    else if (r.checked) {
      by[k].networkFail++;
      by[k].byStatus[r.status ?? "err"] = (by[k].byStatus[r.status ?? "err"] ?? 0) + 1;
    } else by[k].notChecked++;
  }
  console.log("\n=== SUMMARY ===");
  for (const [k, v] of Object.entries(by)) {
    console.log(
      `${k}: ok=${v.ok}/${v.total} networkFail=${v.networkFail} notChecked=${v.notChecked} statuses=${JSON.stringify(v.byStatus)}`,
    );
  }
  const fs = await import("node:fs");
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nfull JSON report: ${OUT}`);
  if (aborted) console.log("WARNING: hard time limit hit — results may be incomplete.");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
