  /* MODELS — grouped by provider, multi-select, streaming chat modal */
  // Selected model ids (survives re-renders of the Models page).
  const modelSelection = new Set();
  // Full model/provider caches for the Models page.
  let modelsCache = [];
  let providersCache = [];
  // Client-side search state. Kept outside the route so refreshes preserve the query.
  let modelSearchQuery = "";
  let modelVisibleCache = [];
  // Which provider groups are collapsed — kept across data refreshes so an
  // add/edit/delete no longer re-expands everything and loses your place.
  const modelCollapsedGroups = new Set();
  // Models page tabs + pagination. The page used to render everything (search,
  // the full benchmark table and every provider group) in one endless scroll;
  // it is now three focused tabs, each with its own pager.
  let modelsTab = "models"; // 'models' | 'benchmark' | 'unresponsive'
  let modelsPage = 1;
  let modelsPerPage = 24;
  let benchPage = 1;
  let benchPerPage = 15;
  let benchQuery = "";
  let unrespPage = 1;
  let unrespPerPage = 15;
  let unrespThreshold = 0.5; // errorRate >= threshold counts as unresponsive
  let unrespIncludeUntested = false;
  let unrespCache = null; // last computed unresponsive rows

  function providerNameOf(id) {
    return providersCache.find((p) => p.id === id)?.name || id || "Unknown provider";
  }
  // Group the flat model list into { providerId, name, models[] }, provider name ASC.
  function groupModelsByProvider(list) {
    const byProvider = new Map();
    for (const m of list) {
      const key = m.providerId || "__none__";
      if (!byProvider.has(key)) byProvider.set(key, []);
      byProvider.get(key).push(m);
    }
    return [...byProvider.entries()]
      .map(([providerId, models]) => ({
        providerId,
        name: providerNameOf(providerId),
        models: models.slice().sort((a, b) => String(a.modelId).localeCompare(String(b.modelId))),
        active: models.filter((m) => m.active).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  on("/models", async () => {
    const [list, providers] = await Promise.all([api("/models"), api("/providers").catch(() => [])]);
    modelsCache = list;
    providersCache = providers;
    // Drop selections pointing at models that no longer exist.
    for (const id of [...modelSelection]) if (!list.some((m) => m.id === id)) modelSelection.delete(id);
    renderModelsPage();
  });

  function searchableModelText(m) {
    const caps = Object.entries(m.capabilities || {}).filter(([, enabled]) => enabled).map(([key]) => key).join(" ");
    const tags = Array.isArray(m.tags) ? m.tags.join(" ") : "";
    return [
      m.displayName, m.modelId, m.id, providerNameOf(m.providerId),
      m.active ? "active enabled" : "inactive disabled", caps, tags, m.notes,
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function filteredModels() {
    const terms = modelSearchQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return modelsCache;
    return modelsCache.filter((m) => {
      const haystack = searchableModelText(m);
      return terms.every((term) => haystack.includes(term));
    });
  }

  /* ---------- Models page: shared pager + tabs ---------- */
  function clampPage(page, total, perPage) {
    const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, perPage)));
    return Math.min(Math.max(1, page), totalPages);
  }

  /** Shared pager: "Showing X–Y of Z" + per-page select + prev/next + numbered buttons. */
  function pagerHtml(opts) {
    const total = Math.max(0, opts.total || 0);
    const perPage = Math.max(1, opts.perPage || 15);
    const page = clampPage(opts.page || 1, total, perPage);
    const options = opts.perOptions || [10, 15, 25, 50];
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const from = total ? (page - 1) * perPage + 1 : 0;
    const to = Math.min(total, page * perPage);
    // Windowed page numbers: 1 … window … last.
    const nums = [];
    const push = (p) => { if (!nums.includes(p)) nums.push(p); };
    push(1);
    for (let p = page - 2; p <= page + 2; p++) if (p > 1 && p < totalPages) push(p);
    if (totalPages > 1) push(totalPages);
    nums.sort((a, b) => a - b);
    let btns = "";
    let prev = 0;
    for (const p of nums) {
      if (p - prev > 1) btns += `<span class="pager-gap">…</span>`;
      btns += `<button class="btn btn-ghost pager-btn ${p === page ? "active" : ""}" ${p === page ? "disabled" : ""} onclick="${opts.pageFn}(${p})">${p}</button>`;
      prev = p;
    }
    return `<div class="pager">
      <span class="pager-info">Showing <strong>${from}–${to}</strong> of <strong>${total}</strong></span>
      <div class="pager-btns">
        <button class="btn btn-ghost pager-btn" ${page <= 1 ? "disabled" : ""} onclick="${opts.pageFn}(${page - 1})">‹ Prev</button>
        ${btns}
        <button class="btn btn-ghost pager-btn" ${page >= totalPages ? "disabled" : ""} onclick="${opts.pageFn}(${page + 1})">Next ›</button>
      </div>
      <label class="pager-per">per page <select class="select" onchange="${opts.perFn}(Number(this.value))">${options.map((o) => `<option value="${o}" ${o === perPage ? "selected" : ""}>${o}</option>`).join("")}</select></label>
    </div>`;
  }

  function modelsTabsHtml() {
    const benchCount = benchStatsCache ? benchStatsCache.length : null;
    const unrespCount = unrespCache ? unrespCache.length : null;
    const runningDot = benchWatchRunId ? ` <span class="tab-dot" title="Benchmark running">●</span>` : "";
    const tab = (id, icon, label, count, extra = "") => `<button class="tab ${modelsTab === id ? "active" : ""}" onclick="modelsSwitchTab('${id}')">${icon} ${label}${count != null ? `<span class="tab-badge">${count}</span>` : ""}${extra}</button>`;
    return `<div class="tabs models-tabs" role="tablist">${tab("models", "🧠", "Models", modelsCache.length)}${tab("benchmark", "🧪", "Benchmark", benchCount, runningDot)}${tab("unresponsive", "⚠️", "Unresponsive", unrespCount)}</div>`;
  }
  window.modelsSwitchTab = (tab) => {
    if (!["models", "benchmark", "unresponsive"].includes(tab)) return;
    modelsTab = tab;
    renderModelsPage();
  };

  /** Re-render the tab strip in place (counts / running dot) without touching the body. */
  function updateModelsTabCounts() {
    const t = $(".models-tabs");
    if (t) t.outerHTML = modelsTabsHtml();
  }
  function updateModelsHeadNote() {
    const allGroups = groupModelsByProvider(modelsCache);
    const note = $("#models-head-note");
    if (note) note.textContent = `Model Registry — grouped by provider · ${modelsCache.length} model(s) in ${allGroups.length} group(s)`;
  }

  /** The current page slice of the filtered models (grouped for display). */
  function modelsPageSlice() {
    const start = (modelsPage - 1) * modelsPerPage;
    return modelVisibleCache.slice(start, start + modelsPerPage);
  }
  function modelsPagerHtml() {
    if (!modelVisibleCache.length) return "";
    return pagerHtml({ total: modelVisibleCache.length, page: modelsPage, perPage: modelsPerPage, pageFn: "modelsPager", perFn: "modelsPerPageSet", perOptions: [12, 24, 48, 96] });
  }
  window.modelsPager = (p) => {
    modelsPage = clampPage(p, modelVisibleCache.length, modelsPerPage);
    const g = $("#model-groups"); if (g) g.innerHTML = modelGroupsInnerHtml();
    const pg = $("#model-pager"); if (pg) pg.innerHTML = modelsPagerHtml();
    const s = $("#model-search-summary"); if (s) s.innerHTML = modelSearchSummary();
    renderBulkBar();
    $("#models-tab-body")?.scrollIntoView?.({ block: "start" });
  };
  window.modelsPerPageSet = (n) => {
    modelsPerPage = [12, 24, 48, 96].includes(n) ? n : 24;
    modelsPage = 1;
    const g = $("#model-groups"); if (g) g.innerHTML = modelGroupsInnerHtml();
    const pg = $("#model-pager"); if (pg) pg.innerHTML = modelsPagerHtml();
    const s = $("#model-search-summary"); if (s) s.innerHTML = modelSearchSummary();
    renderBulkBar();
  };

  /** The groups list HTML — only the current page slice, shared by full render, search and in-place refresh. */
  function modelGroupsInnerHtml() {
    const groups = groupModelsByProvider(modelsPageSlice());
    const hasModels = modelsCache.length > 0;
    return groups.map(renderProviderGroup).join("") || `<div class="card card-body">${emptyState(hasModels ? "🔎" : "🧠", hasModels ? "No matching models" : "No models", hasModels ? "Try a different search term or clear the filter." : "Add a model and attach it to a provider.")}</div>`;
  }

  function renderModelsPage() {
    modelVisibleCache = filteredModels();
    modelsPage = clampPage(modelsPage, modelVisibleCache.length, modelsPerPage);
    const headActions = modelsTab === "models"
      ? `<button class="btn" onclick="modelGroupsCollapseAll()">Collapse all</button>
         <button class="btn" onclick="modelGroupsExpandAll()">Expand all</button>
         <button class="btn" onclick="openModelGroups()">🗂 Groups</button>
         <button class="btn btn-primary" onclick="openModel()">＋ Add Model</button>`
      : modelsTab === "benchmark"
        ? `<button class="btn btn-primary" onclick="runModelBenchmark()">🧪 Benchmark all models</button>
           <button class="btn" onclick="openModel()">＋ Add Model</button>`
        : `<button class="btn" onclick="refreshUnresponsive()">↻ Refresh list</button>
           <button class="btn" onclick="runModelBenchmark()">🧪 Benchmark all models</button>
           <button class="btn btn-primary" onclick="openModel()">＋ Add Model</button>`;
    $("#content").innerHTML = `<div class="overview">
        <div><h1>Models</h1><p id="models-head-note"></p></div>
        <div class="flex">${headActions}</div>
      </div>
      ${modelsTabsHtml()}
      <div id="models-tab-body"></div>`;
    updateModelsHeadNote();
    if (modelsTab === "models") renderModelsListTab();
    else if (modelsTab === "benchmark") renderBenchmarkTab();
    else renderUnresponsiveTab();
  }

  function renderModelsListTab() {
    const body = $("#models-tab-body");
    if (!body) return;
    const hasQuery = modelSearchQuery.trim().length > 0;
    body.innerHTML = `
      <div class="card card-body model-search-card">
        <div class="model-search-row">
          <div class="model-search-box">
            <span class="model-search-icon">⌕</span>
            <input class="input" id="model-search" placeholder="Search models by name, ID, provider, capability, tag or status…" value="${esc(modelSearchQuery)}" autocomplete="off" oninput="modelSearch(this.value)"/>
          </div>
          <button class="btn btn-ghost" id="model-search-clear" onclick="modelSearchClear()" ${hasQuery ? "" : "disabled"}>Clear</button>
        </div>
        <div class="field-hint" id="model-search-summary">${modelSearchSummary()}</div>
      </div>
      <div id="model-bulkbar"></div>
      <div id="model-groups">${modelGroupsInnerHtml()}</div>
      <div id="model-pager">${modelsPagerHtml()}</div>`;
    renderBulkBar();
  }

  function renderBenchmarkTab() {
    const body = $("#models-tab-body");
    if (!body) return;
    body.innerHTML = `<div id="model-bench-card"><div class="card card-body"><div class="repo-empty">Loading benchmark…</div></div></div>`;
    renderBenchmarkCard();
  }

