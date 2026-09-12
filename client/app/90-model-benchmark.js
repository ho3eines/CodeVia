  /* ---------- Smart model routing — benchmark panel ---------- */
  // Benchmark runs execute in the background and are *paced* (one provider call
  // at a time with a multi-second pause), so instead of a silent blocking button
  // we POST /run, then poll /status every ~2s and render what is currently being
  // tested until the run reaches done/error/idle, at which point we stop and
  // refresh the aggregated scores table.
  let benchStatsCache = null;
  let benchPollTimer = null;   // setTimeout handle for the live poll loop
  let benchWatchRunId = null;  // runId we are currently watching

  function benchStopPolling() {
    if (benchPollTimer) { clearTimeout(benchPollTimer); benchPollTimer = null; }
    benchWatchRunId = null;
  }

  const benchModelName = (id) => { const m = modelsCache.find((x) => x.id === id); return m ? m.displayName : id; };

  /** Live progress card shown while a run is in flight. */
  function benchProgressCardHtml(p) {
    const total = Math.max(p.totalModels || 0, 0);
    const done = Math.max(p.completedModels || 0, 0);
    const modelPct = total ? Math.round((done / total) * 100) : 0;
    const probTotal = Math.max(p.totalProblems || 0, 0);
    const probDone = Math.max(p.completedProblems || 0, 0);
    const probPct = probTotal ? Math.round((probDone / probTotal) * 100) : 0;
    const cur = p.currentModelLabel || (p.currentModelId ? benchModelName(p.currentModelId) : null);
    const runShort = (p.runId || "").slice(0, 8);
    return `<div class="card card-body mt">
      <div class="card-title">🧪 Smart routing benchmark <span class="sub">benchmark running · <span class="mono">${esc(runShort || "…")}</span></span></div>
      <div class="flex" style="flex-wrap:wrap;gap:8px;align-items:center;margin:4px 0 6px">
        <span class="badge badge-info">⏳ running</span>
        <span style="font-size:13px">Testing <strong>all active models across every active provider</strong>, one at a time — a <span class="mono">${p.delayMs}ms</span> pause between calls so provider rate limits are never tripped.</span>
      </div>
      ${cur ? `<div class="meter-row"><span class="lbl">Now testing</span><span class="val" style="text-align:left">${esc(cur)}${p.currentModelId ? ` <span class="sub mono">${esc(String(p.currentModelId).slice(0, 20))}</span>` : ""}</span></div>` : ""}
      <div class="meter-row"><span class="lbl">Models</span><div class="bar"><span style="width:${modelPct}%"></span></div><span class="val">${done}/${total}</span></div>
      <div class="meter-row"><span class="lbl">Problems</span><div class="bar"><span style="width:${probPct}%"></span></div><span class="val">${probDone}/${probTotal}</span></div>
      <div class="meter-row"><span class="lbl">Results so far</span><span class="val">${p.resultCount || 0}</span></div>
      <p style="color:var(--text-muted);font-size:12px;margin-top:6px">This can take a while when several providers are configured — the page updates live and the ranking table refreshes automatically when it finishes.</p>
    </div>`;
  }

  function benchErrorCardHtml(p) {
    const runShort = (p.runId || "").slice(0, 8);
    return `<div class="card card-body mt">
      <div class="card-title">🧪 Smart routing benchmark <span class="sub"><span class="mono">${esc(runShort || "…")}</span></span></div>
      <div class="error-state"><h4>Benchmark run failed</h4><pre>${esc(p.error || "The run ended with an unexpected error.")}</pre></div>
      <div class="flex mt"><button class="btn btn-primary" onclick="runModelBenchmark()">↻ Try benchmark again</button></div>
    </div>`;
  }

  /** Filtered benchmark stats (search box on the Benchmark tab). */
  function filteredBenchStats() {
    const rows = benchStatsCache || [];
    const q = benchQuery.trim().toLowerCase();
    if (!q) return rows;
    const terms = q.split(/\s+/).filter(Boolean);
    return rows.filter((s) => {
      const m = modelsCache.find((x) => x.id === s.modelId);
      const hay = `${m?.displayName || ""} ${m?.modelId || ""} ${s.modelId} ${m?.providerId ? providerNameOf(m.providerId) : ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  /** Render the aggregated per-model ranking table (fresh stats — deleted models never linger). */
  async function benchRenderStats() {
    const el = $("#model-bench-card");
    if (!el) return;
    benchStatsCache = null;
    try {
      const r = await api("/models/benchmark/stats");
      benchStatsCache = r.stats || [];
    } catch (_) { benchStatsCache = []; }
    updateModelsTabCounts();
    // A fresh benchmark changes who counts as unresponsive — drop that cache.
    unrespCache = null;
    if (!benchStatsCache || !benchStatsCache.length) {
      el.innerHTML = `<div class="card card-body mt"><div class="card-title">🧪 Smart routing benchmark <span class="sub">no data yet</span></div>
        <p style="color:var(--text-muted);font-size:13px">The router picks the best model for each agent call based on real speed, accuracy and error rate. Run a quick math quiz across every active model to seed the data (uses temperature=0, short calls, paced to stay rate-limit friendly).</p>
        <div class="flex mt"><button class="btn btn-primary" onclick="runModelBenchmark()">▶ Run benchmark now</button></div></div>`;
      return;
    }
    benchPage = clampPage(benchPage, filteredBenchStats().length, benchPerPage);
    el.innerHTML = benchStatsCardHtml();
  }

  /** The ranking card with its own search + pager (page slice only). */
  function benchStatsCardHtml() {
    const rows = filteredBenchStats();
    const start = (benchPage - 1) * benchPerPage;
    const pageRows = rows.slice(start, start + benchPerPage);
    const hasQuery = benchQuery.trim().length > 0;
    return `<div class="card card-body mt">
        <div class="card-title">🧪 Smart routing benchmark <span class="sub">${rows.length} model(s) ranked by composite score</span></div>
        <p style="color:var(--text-muted);font-size:12px">Score = 60% accuracy · 20% reliability · 20% speed. Higher is better. Models with recent errors are demoted in the fallback chain.</p>
        <div class="model-search-row" style="margin-bottom:12px">
          <div class="model-search-box">
            <span class="model-search-icon">⌕</span>
            <input class="input" id="bench-search" placeholder="Filter ranking by model or provider…" value="${esc(benchQuery)}" autocomplete="off" oninput="benchSearch(this.value)"/>
          </div>
          <button class="btn btn-ghost" onclick="benchSearchClear()" ${hasQuery ? "" : "disabled"}>Clear</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Rank</th><th>Model</th><th>Score</th><th>Accuracy</th><th>Avg latency</th><th>p95 latency</th><th>Error rate</th><th>Avg cost</th><th>Attempts</th><th>Last tested</th></tr></thead>
          <tbody>${pageRows.map((s, k) => { const i = start + k; return `<tr${i===0?' style="background:var(--glass)"':""}>
            <td><strong>#${i+1}</strong></td><td><strong>${esc(benchModelName(s.modelId))}</strong><div class="sub mono">${esc(s.modelId.slice(0,20))}</div></td>
            <td><strong>${s.score.toFixed(3)}</strong></td>
            <td>${s.accuracy?`<span class="badge badge-${s.accuracy>.8?'ok':s.accuracy>.5?'warn':'err'}">${(s.accuracy*100).toFixed(0)}%</span>`:'<span class="badge badge-muted">—</span>'}</td>
            <td class="mono">${s.avgLatencyMs}ms</td>
            <td class="mono">${s.p95LatencyMs}ms</td>
            <td>${s.errorRate?`<span class="badge badge-${s.errorRate>.2?'err':'ok'}">${(s.errorRate*100).toFixed(0)}%</span>`:'<span class="badge badge-ok">0%</span>'}</td>
            <td class="mono">${s.avgCostUsd?'$'+s.avgCostUsd.toFixed(4):'—'}</td>
            <td>${s.totalAttempts}</td>
            <td class="sub">${s.lastTestedAt?timeAgo(s.lastTestedAt):'—'}</td>
          </tr>`; }).join("") || `<tr><td colspan="10">${emptyState("🔎", "No matching models", "Try a different filter or clear it.")}</td></tr>`}</tbody>
        </table></div>
        ${pagerHtml({ total: rows.length, page: benchPage, perPage: benchPerPage, pageFn: "benchPager", perFn: "benchPerPageSet", perOptions: [10, 15, 25, 50] })}
        <div class="flex mt"><button class="btn btn-primary" onclick="runModelBenchmark()">▶ Re-run benchmark (all active models)</button><span class="field-hint" style="margin-left:8px">Results persist and accumulate — re-running refines the scores.</span></div>
      </div>`;
  }

  function rerenderBenchCard() {
    const el = $("#model-bench-card");
    if (el && benchStatsCache) el.innerHTML = benchStatsCardHtml();
  }
  window.benchSearch = (value) => {
    benchQuery = value || "";
    benchPage = 1;
    const input = $("#bench-search");
    const start = input?.selectionStart ?? benchQuery.length;
    const end = input?.selectionEnd ?? benchQuery.length;
    rerenderBenchCard();
    const again = $("#bench-search");
    if (again) { again.focus(); try { again.setSelectionRange(start, end); } catch (_) {} }
  };
  window.benchSearchClear = () => {
    benchQuery = "";
    benchPage = 1;
    rerenderBenchCard();
    $("#bench-search")?.focus();
  };
  window.benchPager = (p) => {
    benchPage = clampPage(p, filteredBenchStats().length, benchPerPage);
    rerenderBenchCard();
    $("#model-bench-card")?.scrollIntoView?.({ block: "start" });
  };
  window.benchPerPageSet = (n) => {
    benchPerPage = [10, 15, 25, 50].includes(n) ? n : 15;
    benchPage = 1;
    rerenderBenchCard();
  };

  /** Render a running snapshot into the card; returns false if the card is gone. */
  function benchRenderRunning(p) {
    const el = $("#model-bench-card");
    if (!el) return false;
    el.innerHTML = benchProgressCardHtml(p);
    return true;
  }

  /** One poll iteration; returns true to keep polling, false to stop. */
  async function benchPollOnce() {
    // The benchmark card only exists on the Benchmark tab — when the user is
    // on another tab we keep polling silently and surface progress via the
    // tab's running dot instead of stopping the loop.
    const el = $("#model-bench-card");
    let st = null;
    try { st = await api("/models/benchmark/status"); } catch (_) {}
    const p = st && st.progress;
    // Server unreachable — stop rather than spin forever.
    if (!p) { benchStopPolling(); updateModelsTabCounts(); if (el) benchRenderStats(); return false; }
    if (p.status === "running") {
      // Follow whichever run the server is executing (a re-run in another tab
      // can swap runId underneath us — keep watching the current one).
      benchWatchRunId = p.runId || benchWatchRunId;
      updateModelsTabCounts();
      if (el) benchRenderRunning(p);
      return true;
    }
    // Terminal state: done / error / idle → abort polling.
    benchStopPolling();
    updateModelsTabCounts();
    if (p.status === "error") {
      toast("Benchmark failed", p.error || "The run ended with an error.", "err");
      if (el) el.innerHTML = benchErrorCardHtml(p);
    } else if (p.status === "done") {
      toast("Benchmark complete", `${p.completedModels || p.totalModels} model(s) · ${p.resultCount} results`, "ok");
      if (el) await benchRenderStats();
      else { benchStatsCache = null; unrespCache = null; updateModelsTabCounts(); }
    } else {
      // idle — nothing is running, just show the persisted ranking.
      if (el) await benchRenderStats();
    }
    return false;
  }

  /** Kick off the 2s poll loop (no-op if already polling). */
  function benchStartPolling() {
    if (benchPollTimer) return;
    const tick = async () => {
      benchPollTimer = null;
      const keep = await benchPollOnce();
      if (keep) benchPollTimer = setTimeout(tick, 2000);
    };
    benchPollTimer = setTimeout(tick, 0);
  }

  async function renderBenchmarkCard() {
    const el = $("#model-bench-card");
    if (!el) return;
    // Cancel any previous poll loop for this page so a re-render never stacks
    // duplicate timers, then re-evaluate the live state.
    benchStopPolling();
    let st = null;
    try { st = await api("/models/benchmark/status"); } catch (_) {}
    const p = st && st.progress;
    if (p && p.status === "running") {
      benchWatchRunId = p.runId || "";
      benchRenderRunning(p);
      benchStartPolling();
      return;
    }
    await benchRenderStats();
  }

  window.runModelBenchmark = async () => {
    // Benchmark progress lives on the Benchmark tab — jump there first so the
    // live card is visible while the run executes.
    if (location.hash.startsWith("#/models") && modelsTab !== "benchmark") {
      modelsTab = "benchmark";
      renderModelsPage();
    }
    const btn = document.activeElement;
    if (btn) btn.disabled = true;
    // Clear any stale poll loop before kicking a fresh run off.
    benchStopPolling();
    try {
      const r = await api("/models/benchmark/run", { method: "POST", body: { problemsPerModel: 6 } });
      if (r.alreadyRunning) {
        toast("Benchmark already running", "A benchmark is already in progress — showing its live progress.", "warn");
      } else if (!r.started || !r.totalModels) {
        toast("Nothing to benchmark", "No active models on active providers were found.", "warn");
        await benchRenderStats();
        return;
      } else {
        toast("Benchmark started", `${r.totalModels} model(s) · ${r.problemCount} problems each`, "");
      }
      // Watch the run the server is now executing until it reaches done/error.
      let st = null;
      try { st = await api("/models/benchmark/status"); } catch (_) {}
      const p = st && st.progress;
      if (p && p.status === "running") {
        benchWatchRunId = p.runId || r.runId;
        benchRenderRunning(p);
        benchStartPolling();
      } else {
        await benchRenderStats();
      }
    } catch (e) {
      toast("Benchmark failed", e.message, "err");
      await benchRenderStats();
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  function modelSearchSummary() {
    const q = modelSearchQuery.trim();
    if (!modelsCache.length) return "No models in the registry yet.";
    const totalPages = Math.max(1, Math.ceil(modelVisibleCache.length / modelsPerPage));
    const pageBit = modelVisibleCache.length > modelsPerPage ? ` · page ${modelsPage}/${totalPages}` : "";
    if (!q) return `Showing all ${modelsCache.length} model(s)${pageBit}. Search supports multiple words, provider names, capabilities like code or vision, and active/inactive status.`;
    return `Showing ${modelVisibleCache.length} of ${modelsCache.length} model(s) for “${esc(q)}”${pageBit}.`;
  }

  window.modelSearch = (value) => {
    modelSearchQuery = value || "";
    const input = $("#model-search");
    const start = input?.selectionStart ?? modelSearchQuery.length;
    const end = input?.selectionEnd ?? modelSearchQuery.length;
    modelVisibleCache = filteredModels();
    modelsPage = 1;
    const groups = $("#model-groups"); if (groups) groups.innerHTML = modelGroupsInnerHtml();
    const pg = $("#model-pager"); if (pg) pg.innerHTML = modelsPagerHtml();
    const summary = $("#model-search-summary");
    if (summary) summary.innerHTML = modelSearchSummary();
    const clear = $("#model-search-clear");
    if (clear) clear.disabled = !modelSearchQuery.trim();
    renderBulkBar();
    if (input) { input.focus(); try { input.setSelectionRange(start, end); } catch {} }
  };

  window.modelSearchClear = () => {
    modelSearchQuery = "";
    modelsPage = 1;
    renderModelsPage();
    $("#model-search")?.focus();
  };

  /**
   * (Models page) Re-fetch the data and re-render only the list — never the
   * whole page. Used after add/edit/delete/activate/bulk so scroll position,
   * focus, the search box, the selection and the collapsed provider groups
   * stay exactly where they were: no "reload" jumping back to the top.
   */
  async function refreshModelsData() {
    if (!location.hash.startsWith("#/models")) return refreshCurrent();
    const body = $("#models-tab-body");
    if (!body) return refreshCurrent(); // page shell not mounted
    try {
      const [list, providers] = await Promise.all([api("/models"), api("/providers").catch(() => [])]);
      modelsCache = list;
      providersCache = providers;
      // Drop selections pointing at models that no longer exist.
      for (const id of [...modelSelection]) if (!list.some((m) => m.id === id)) modelSelection.delete(id);
      modelVisibleCache = filteredModels();
      updateModelsHeadNote();
      if (modelsTab === "models") {
        modelsPage = clampPage(modelsPage, modelVisibleCache.length, modelsPerPage);
        const groups = $("#model-groups"); if (groups) groups.innerHTML = modelGroupsInnerHtml();
        const pg = $("#model-pager"); if (pg) pg.innerHTML = modelsPagerHtml();
        const summary = $("#model-search-summary");
        if (summary) summary.innerHTML = modelSearchSummary();
        renderBulkBar();
      } else if (modelsTab === "benchmark") {
        // Re-evaluates live state / stats (keeps its own paging + filter).
        renderBenchmarkCard();
        updateModelsTabCounts();
      } else {
        if (!benchStatsCache) {
          try {
            const r = await api("/models/benchmark/stats");
            benchStatsCache = r.stats || [];
          } catch (_) { benchStatsCache = []; }
        }
        computeUnresponsive();
        updateModelsTabCounts();
        body.innerHTML = unrespCardHtml();
      }
      updateModelsTabCounts();
    } catch (e) { toast("Error", e.message, "err"); }
  }
  window.refreshModelsData = refreshModelsData;

  /** One collapsible provider card holding its models. */
  function renderProviderGroup(g) {
    const allSelected = g.models.length > 0 && g.models.every((m) => modelSelection.has(m.id));
    const provider = providersCache.find((p) => p.id === g.providerId) || {};
    const inactive = g.models.length - g.active;
    const activePct = g.models.length ? Math.round((g.active / g.models.length) * 100) : 0;
    const caps = [...new Set(g.models.flatMap((m) => Object.entries(m.capabilities || {}).filter(([, on]) => on).map(([k]) => CAP_NAMES[k] || k)))].slice(0, 6);
    const groupId = esc(g.providerId);
    return `<section class="card model-group${modelCollapsedGroups.has(g.providerId) ? " collapsed" : ""}" data-provider="${groupId}">
      <div class="model-group-head">
        <div class="model-group-main" onclick="modelGroupToggle('${groupId}')" title="Collapse / expand this provider">
          <button class="chev-btn" type="button" aria-label="Collapse / expand"><span class="chev">▾</span></button>
          <div class="provider-avatar">${esc((g.name || "?").trim().slice(0, 1).toUpperCase())}</div>
          <div class="model-group-title">
            <strong>${esc(g.name)}</strong>
            <div class="model-group-sub">${esc(provider.type || provider.apiFormat || "provider")} ${provider.baseUrl ? `· ${esc(provider.baseUrl)}` : ""}</div>
          </div>
        </div>
        <div class="model-group-stats">
          <span class="badge badge-muted">${g.models.length} total</span>
          <span class="badge badge-ok">${g.active} active</span>
          ${inactive ? `<span class="badge badge-muted">${inactive} inactive</span>` : ""}
        </div>
        <div class="model-group-actions">
          <label class="model-check model-select-chip" title="Select visible models in this provider">
            <input type="checkbox" ${allSelected ? "checked" : ""} onchange="modelSelectProvider('${groupId}', this.checked)"/> Select
          </label>
          <button class="btn btn-ghost" onclick="openModelGroup('${groupId}')">Details</button>
        </div>
      </div>
      <div class="model-group-body">
        <div class="model-group-meta">
          <div class="model-active-meter" title="${activePct}% active"><span style="width:${activePct}%"></span></div>
          <div class="model-cap-strip">${caps.map((c) => `<span class="badge badge-muted">${esc(c)}</span>`).join(" ") || '<span class="badge badge-muted">no capabilities</span>'}</div>
        </div>
        <div class="model-card-grid">${g.models.map(renderModelCard).join("")}</div>
      </div>
    </section>`;
  }

  function renderModelCard(m) {
    const id = esc(m.id);
    const ctx = Number(m.contextWindow || 0);
    return `<article class="model-card ${modelSelection.has(m.id) ? "row-selected" : ""}" data-model="${id}">
      <div class="model-card-top">
        <label class="model-card-check" title="Select model"><input data-model-check type="checkbox" ${modelSelection.has(m.id) ? "checked" : ""} onchange="modelSelectOne('${id}', this.checked)"/></label>
        <div class="model-card-name">
          <strong>${esc(m.displayName || m.modelId)}</strong>
          <div class="mono model-id" title="${esc(m.modelId)}">${esc(m.modelId)}${tuningBadge(m)}</div>
        </div>
        ${m.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}
        ${m.ownerId ? "" : '<span class="badge badge-muted" title="Shared platform model — every account can see and route to it. Editing it makes it yours.">👥 shared</span>'}
      </div>
      <div class="model-card-facts">
        <span title="Context window">🧠 ${ctx ? ctx.toLocaleString() : "—"}</span>
        <span title="Priority">↕ ${Number(m.priority || 100)}</span>
        <span title="Cost per 1k tokens">${money(Number(m.inputCostPer1k || 0) + Number(m.outputCostPer1k || 0))}/1k</span>
      </div>
      <div class="model-card-caps">${capsBadges(m.capabilities) || '<span class="badge badge-muted">—</span>'}</div>
      <div class="model-card-actions">
        <button class="btn btn-ghost" onclick="openModelChat('${id}')">💬 Test</button>
        <button class="btn btn-ghost" onclick="openModelEdit('${id}')">✏️ Edit</button>
        <button class="btn btn-ghost" onclick="modelToggle('${id}', ${m.active ? "false" : "true"})">${m.active ? "Disable" : "Enable"}</button>
        <button class="btn btn-ghost danger-text" onclick="modelDelete('${id}')">🗑</button>
      </div>
    </article>`;
  }

  window.modelGroupsCollapseAll = () => {
    $$(".model-group").forEach((el) => el.classList.add("collapsed"));
    for (const g of groupModelsByProvider(modelVisibleCache)) modelCollapsedGroups.add(g.providerId);
  };
  window.modelGroupsExpandAll = () => {
    $$(".model-group").forEach((el) => el.classList.remove("collapsed"));
    modelCollapsedGroups.clear();
  };

  /** Small badge showing that a model carries per-model overrides. */
  function tuningBadge(m) {
    const bits = [];
    if (m.omitTemperature) bits.push("no temp");
    else if (typeof m.temperature === "number") bits.push("creativity " + m.temperature);
    if (typeof m.maxTokens === "number") bits.push("max " + m.maxTokens);
    return bits.length ? ` <span class="badge badge-info" title="Per-model overrides">⚙ ${esc(bits.join(" · "))}</span>` : "";
  }

  /* ---- Edit model — every field is editable, including the tuning that some
     provider routes require (e.g. a route that only accepts temperature 1.0). ---- */
  window.openModelEdit = async (id) => {
    let m;
    try { m = await api(`/models/${encodeURIComponent(id)}`); }
    catch (e) { toast("Error", e.message, "err"); return; }
    const providers = providersCache.length ? providersCache : await api("/providers").catch(() => []);
    const caps = m.capabilities || {};
    const capRow = (key, label) => `<label class="cap-toggle"><input type="checkbox" id="e-cap-${key}" ${caps[key] ? "checked" : ""}/> ${label}</label>`;
    openModal(`Edit Model — ${m.displayName || m.modelId}`, `
      <div class="grid-2">
        <div class="field"><label>Provider</label><select class="select" id="e-prov">${providers.map((p) => `<option value="${esc(p.id)}" ${p.id === m.providerId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Display name</label><input class="input" id="e-name" value="${esc(m.displayName || "")}"/></div>
      </div>
      <div class="field"><label>Model ID <span class="select-count">exactly as the provider expects it</span></label><input class="input mono" id="e-mid" value="${esc(m.modelId || "")}"/></div>

      <div class="field"><label>Creativity (temperature) <span class="select-count">0.0 = precise &amp; repeatable · 1.0 = most creative</span></label>
        <div class="temp-row">
          <input type="range" class="temp-slider" id="e-temp-range" min="0" max="1" step="0.05" value="${typeof m.temperature === "number" ? m.temperature : 0.3}" ${typeof m.temperature === "number" ? "" : "disabled"}/>
          <input class="input temp-num" id="e-temp" placeholder="default" value="${typeof m.temperature === "number" ? m.temperature : ""}"/>
        </div>
        <div class="temp-scale"><span>0.0 precise</span><span>0.5 balanced</span><span>1.0 creative</span></div>
        <div class="field-hint" id="e-temp-desc"></div>
        <label class="cap-toggle" style="margin-top:6px"><input type="checkbox" id="e-omit" ${m.omitTemperature ? "checked" : ""}/> Do not send <span class="mono">temperature</span> at all</label>
        <div class="field-hint">Leave the box empty to use the provider default. If the provider says <em>"Supported values are between 1.0 and 1.0"</em>, set it to <strong>1</strong> (or tick the box above).</div>
      </div>
      <div class="field"><label>Max output tokens</label>
        <input class="input" id="e-maxtok" placeholder="provider default" value="${typeof m.maxTokens === "number" ? m.maxTokens : ""}"/>
        <div class="field-hint">Leave empty for the provider default.</div>
      </div>

      <div class="grid-2">
        <div class="field"><label>Context window</label><input class="input" id="e-ctx" value="${Number(m.contextWindow || 0)}"/></div>
        <div class="field"><label>Priority (lower = preferred)</label><input class="input" id="e-prio" value="${Number(m.priority || 100)}"/></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Input cost / 1k</label><input class="input" id="e-cin" value="${Number(m.inputCostPer1k || 0)}"/></div>
        <div class="field"><label>Output cost / 1k</label><input class="input" id="e-cout" value="${Number(m.outputCostPer1k || 0)}"/></div>
      </div>
      <div class="field"><label>Capabilities</label><div class="cap-grid">
        ${capRow("vision", "vision")}${capRow("tools", "tools")}${capRow("structuredOutput", "structured")}
        ${capRow("code", "code")}${capRow("reasoning", "reasoning")}${capRow("streaming", "streaming")}
      </div></div>
      <div class="grid-2">
        <div class="field"><label>Tags <span class="select-count">comma separated</span></label><input class="input" id="e-tags" value="${esc((m.tags || []).join(", "))}"/></div>
        <div class="field"><label>Status</label><select class="select" id="e-active"><option value="true" ${m.active ? "selected" : ""}>active</option><option value="false" ${m.active ? "" : "selected"}>inactive</option></select></div>
      </div>
      <div class="field"><label>Notes</label><textarea class="textarea" id="e-notes" rows="2" placeholder="e.g. this route only accepts temperature 1.0">${esc(m.notes || "")}</textarea></div>
      <div class="flex"><button class="btn" id="e-test">Test with these settings</button><button class="btn btn-primary" id="e-save">Save changes</button><button class="btn" onclick="closeModal()">Cancel</button></div>
      <div id="e-test-result"></div>`);

    // Slider ⇄ number box stay in sync; the label explains what the value does.
    const describeTemp = (v) => {
      if (v === "" || v === null || Number.isNaN(v)) return "Using the provider default creativity.";
      if (v <= 0.1) return `<strong>${v}</strong> — deterministic: same question, same answer. Best for code &amp; extraction.`;
      if (v <= 0.4) return `<strong>${v}</strong> — precise, slight variation. Good default for engineering tasks.`;
      if (v <= 0.7) return `<strong>${v}</strong> — balanced: some creativity, still focused.`;
      if (v < 1) return `<strong>${v}</strong> — creative and varied.`;
      return `<strong>${v}</strong> — maximum creativity (and the value some routes require).`;
    };
    const syncTemp = (from) => {
      const num = $("#e-temp");
      const range = $("#e-temp-range");
      if (from === "range") num.value = String(range.value);
      const raw = num.value.trim();
      const v = raw === "" ? "" : Number(raw);
      range.disabled = raw === "";
      if (raw !== "" && !Number.isNaN(v)) range.value = String(Math.min(1, Math.max(0, v)));
      $("#e-temp-desc").innerHTML = describeTemp(v);
    };
    $("#e-temp-range").addEventListener("input", () => syncTemp("range"));
    $("#e-temp").addEventListener("input", () => syncTemp("num"));
    syncTemp("num");

    // Read the tuning currently typed into the form (empty = clear the override).
    const formTuning = () => {
      const t = $("#e-temp").value.trim();
      const mt = $("#e-maxtok").value.trim();
      return {
        temperature: t === "" ? null : Number(t),
        maxTokens: mt === "" ? null : Number(mt),
        omitTemperature: $("#e-omit").checked,
      };
    };
    $("#e-test").onclick = async () => {
      const el = $("#e-test-result");
      const tune = formTuning();
      el.innerHTML = `<div class="test-result">Sending a test message with these settings…</div>`;
      try {
        const r = await api(`/models/${encodeURIComponent(id)}/test`, { method: "POST", body: {
          message: MODEL_TEST_MSG,
          ...(typeof tune.temperature === "number" && !Number.isNaN(tune.temperature) ? { temperature: tune.temperature } : {}),
          ...(typeof tune.maxTokens === "number" && !Number.isNaN(tune.maxTokens) ? { maxTokens: tune.maxTokens } : {}),
          omitTemperature: tune.omitTemperature,
        }});
        showTestVerdict(r, { modelId: id, title: r.ok ? "✓ Model replied" : "✗ Model test failed" });
      } catch (e) {
        showTestVerdict({ ok: false, message: e.message, hint: e.body?.hint, status: e.status }, { modelId: id, title: "✗ Model test failed" });
      }
    };
    $("#e-save").onclick = async () => {
      const tune = formTuning();
      if (tune.temperature !== null && (Number.isNaN(tune.temperature) || tune.temperature < 0 || tune.temperature > 1)) {
        toast("Invalid creativity", "Temperature must be between 0.0 and 1.0, or leave it empty.", "err"); return;
      }
      if (tune.maxTokens !== null && (Number.isNaN(tune.maxTokens) || tune.maxTokens < 1)) {
        toast("Invalid max tokens", "Use a positive number, or leave it empty.", "err"); return;
      }
      const capsOut = {};
      for (const k of Object.keys(CAP_NAMES)) capsOut[k] = $("#e-cap-" + k).checked;
      try {
        await api(`/models/${encodeURIComponent(id)}`, { method: "PATCH", body: {
          providerId: $("#e-prov").value,
          displayName: $("#e-name").value.trim() || undefined,
          modelId: $("#e-mid").value.trim() || undefined,
          contextWindow: Number($("#e-ctx").value) || 0,
          priority: Number($("#e-prio").value) || 100,
          inputCostPer1k: Number($("#e-cin").value) || 0,
          outputCostPer1k: Number($("#e-cout").value) || 0,
          capabilities: capsOut,
          tags: $("#e-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
          active: $("#e-active").value === "true",
          notes: $("#e-notes").value,
          temperature: tune.temperature,
          maxTokens: tune.maxTokens,
          omitTemperature: tune.omitTemperature,
        }});
        closeModal(); toast("Model updated", $("#e-mid").value.trim(), "ok"); refreshModelsData();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };

  window.modelGroupToggle = (providerId) => {
    const card = document.querySelector(`.model-group[data-provider="${CSS.escape(providerId)}"]`);
    if (!card) return;
    // Remember the collapsed state so in-place data refreshes keep it.
    const collapsed = card.classList.toggle("collapsed");
    if (collapsed) modelCollapsedGroups.add(providerId); else modelCollapsedGroups.delete(providerId);
  };

  /* ---- multi-select ---- */
  window.modelSelectOne = (id, checked) => {
    if (checked) modelSelection.add(id); else modelSelection.delete(id);
    const row = document.querySelector(`[data-model="${CSS.escape(id)}"]`);
    if (row) row.classList.toggle("row-selected", checked);
    syncGroupCheckboxes();
    syncUnrespSelectionUI();
    renderBulkBar();
  };
  window.modelSelectProvider = (providerId, checked) => {
    // Only the models actually displayed on this page (pagination slice).
    const visibleForProvider = modelsPageSlice().filter((x) => (x.providerId || "__none__") === providerId);
    for (const m of visibleForProvider) {
      if (checked) modelSelection.add(m.id); else modelSelection.delete(m.id);
      const box = document.querySelector(`[data-model="${CSS.escape(m.id)}"] input[data-model-check]`);
      if (box) box.checked = checked;
      const row = document.querySelector(`[data-model="${CSS.escape(m.id)}"]`);
      if (row) row.classList.toggle("row-selected", checked);
    }
    renderBulkBar();
  };
  window.modelSelectPage = (checked) => {
    for (const m of modelsPageSlice()) {
      if (checked) modelSelection.add(m.id); else modelSelection.delete(m.id);
    }
    renderModelsPage();
  };
  window.modelSelectAll = (checked) => {
    const target = modelVisibleCache.length || !modelSearchQuery.trim() ? modelVisibleCache : [];
    for (const m of target) {
      if (checked) modelSelection.add(m.id); else modelSelection.delete(m.id);
    }
    renderModelsPage();
  };
  window.modelSelectionClear = () => { modelSelection.clear(); renderModelsPage(); };

  function syncGroupCheckboxes() {
    const slice = modelsPageSlice();
    for (const card of $$(".model-group")) {
      const pid = card.dataset.provider;
      const models = slice.filter((m) => (m.providerId || "__none__") === pid);
      const box = card.querySelector(".model-check input");
      if (!box) continue;
      const selected = models.filter((m) => modelSelection.has(m.id)).length;
      box.checked = models.length > 0 && selected === models.length;
      box.indeterminate = selected > 0 && selected < models.length;
    }
  }

  /** Sticky action bar shown while at least one model is selected. */
  function renderBulkBar() {
    const el = $("#model-bulkbar");
    if (!el) return;
    const n = modelSelection.size;
    if (!n) { el.innerHTML = ""; return; }
    const pageN = modelsPageSlice().length;
    el.innerHTML = `<div class="bulk-bar">
      <span><strong>${n}</strong> model(s) selected</span>
      <div class="flex">
        <button class="btn" onclick="modelSelectPage(true)">Select page (${pageN})</button>
        <button class="btn" onclick="modelSelectAll(true)">Select all filtered (${modelVisibleCache.length})</button>
        <button class="btn" onclick="modelBulk('activate')">✓ Activate</button>
        <button class="btn" onclick="modelBulk('deactivate')">⏸ Deactivate</button>
        <button class="btn btn-danger" onclick="modelBulk('delete')">🗑 Delete selected</button>
        <button class="btn btn-ghost" onclick="modelSelectionClear()">Clear</button>
      </div>
    </div>`;
  }

  window.modelBulk = async (action) => {
    const ids = [...modelSelection];
    if (!ids.length) return;
    if (action === "delete" && !confirm(`Delete ${ids.length} selected model(s) from the system?`)) return;
    try {
      const r = await api("/models/bulk", { method: "POST", body: { action, ids } });
      modelSelection.clear();
      toast(`${r.affected} model(s) ${action === "delete" ? "deleted" : action + "d"}`, "", "ok");
      refreshModelsData();
    } catch (e) { toast("Error", e.message, "err"); }
  };

