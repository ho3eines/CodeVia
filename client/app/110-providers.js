  /* PROVIDERS — dashboard, filters, multi-select bulk actions, per-card control */

  // Page state kept outside the route so re-renders/refreshes preserve it.
  const providerSelection = new Set();
  const providerExpanded = new Set();
  let providersPageCache = [];
  let providersVisibleCache = [];
  let providerSummary = null;
  let providerQuery = "";
  let providerFilter = "all"; // all | active | inactive | ready | attention
  let providerSort = "name";  // name | status | models | type

  const PROVIDER_ICONS = {
    openai: "🟢", anthropic: "🟣", gemini: "🔵", openrouter: "🧭",
    "azure-openai": "☁️", ollama: "🦙", "openai-compatible": "🔗", "custom-http": "🛠", mock: "🧪",
  };
  const providerIcon = (type) => PROVIDER_ICONS[type] || "🔌";

  /**
   * Derive the catalog/chat URL the platform will hit for a provider, so users
   * can see the documented endpoint without having to run a test.
   */
  function providerUrlHints(p) {
    const base = String(p.baseUrl || "").replace(/\/+$/, "");
    const fmt = p.apiFormat;
    if (fmt === "custom") return { catalog: "Not available — add model IDs manually", chat: base || "—" };
    if (fmt === "anthropic") {
      return {
        catalog: base ? (base.endsWith("/v1") ? `${base}/models?limit=50` : `${base}/v1/models?limit=50`) : "—",
        chat: base ? (base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`) : "—",
      };
    }
    if (fmt === "gemini") {
      const b = base ? (base.endsWith("/v1beta") ? base : `${base}/v1beta`) : "";
      return { catalog: b ? `${b}/models` : "—", chat: b ? `${b}/models/<model>:generateContent` : "—" };
    }
    if (fmt === "ollama") {
      const b = base.endsWith("/v1") ? base.slice(0, -3) : base;
      return { catalog: b ? `${b}/api/tags` : "—", chat: b ? `${b}/api/chat` : "—" };
    }
    // openai / openrouter / azure-openai / openai-compatible / custom
    const b = base ? (base.endsWith("/v1") ? base : `${base}/v1`) : "";
    return { catalog: b ? `${b}/models` : "—", chat: b ? `${b}/chat/completions` : "—" };
  }

  /** Health verdict used for the status pill + the "needs attention" filter. */
  function providerHealth(p) {
    const ready = p.readiness?.ready !== false;
    if (!ready) return { key: "attention", label: "Needs a key", cls: "err", icon: "⚠", tip: p.readiness?.reason || "Not ready" };
    if (!p.active) return { key: "inactive", label: "Inactive", cls: "muted", icon: "⏸", tip: "Ready, but not activated yet" };
    if (!p.modelCount) return { key: "empty", label: "No models", cls: "warn", icon: "○", tip: "Active but no models attached — run Sync models" };
    return { key: "ok", label: "Operational", cls: "ok", icon: "●", tip: "Active, configured and serving models" };
  }

  function providerSearchText(p) {
    const u = providerUrlHints(p);
    return [
      p.name, p.type, p.apiFormat, p.authType, p.baseUrl, p.secretRef, p.id,
      p.active ? "active enabled on" : "inactive disabled off",
      p.keyPresent ? "key set ready configured" : "missing key not ready unconfigured",
      providerHealth(p).label, u.catalog, u.chat,
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function filteredProviders() {
    const terms = providerQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let list = providersPageCache.filter((p) => {
      if (providerFilter === "active" && !p.active) return false;
      if (providerFilter === "inactive" && p.active) return false;
      if (providerFilter === "ready" && p.readiness?.ready === false) return false;
      if (providerFilter === "attention" && p.readiness?.ready !== false) return false;
      if (!terms.length) return true;
      const hay = providerSearchText(p);
      return terms.every((t) => hay.includes(t));
    });
    const rank = (p) => (p.readiness?.ready === false ? 0 : p.active ? 2 : 1);
    list = list.slice().sort((a, b) => {
      if (providerSort === "models") return (b.modelCount || 0) - (a.modelCount || 0) || a.name.localeCompare(b.name);
      if (providerSort === "type") return String(a.type).localeCompare(String(b.type)) || a.name.localeCompare(b.name);
      if (providerSort === "status") return rank(a) - rank(b) || a.name.localeCompare(b.name);
      return String(a.name).localeCompare(String(b.name));
    });
    return list;
  }

  on("/providers", async () => {
    const [list, summary] = await Promise.all([api("/providers"), api("/providers/summary").catch(() => null)]);
    providersPageCache = list;
    providerSummary = summary;
    for (const id of [...providerSelection]) if (!list.some((p) => p.id === id)) providerSelection.delete(id);
    renderProvidersPage();
  });

  function renderProvidersPage() {
    const s = providerSummary || {};
    const attention = providersPageCache.filter((p) => p.readiness?.ready === false).length;
    const counts = {
      all: providersPageCache.length,
      active: providersPageCache.filter((p) => p.active).length,
      inactive: providersPageCache.filter((p) => !p.active).length,
      ready: providersPageCache.filter((p) => p.readiness?.ready !== false).length,
      attention,
    };
    const chip = (key, label, n, cls = "") =>
      `<button class="filter-chip ${providerFilter === key ? "active" : ""} ${cls}" onclick="providerSetFilter('${key}')">${esc(label)} <span class="chip-count">${n}</span></button>`;

    $("#content").innerHTML = `<div class="overview">
        <div>
          <h1>Providers</h1>
          <p>Connect any OpenAI-, Anthropic-, Gemini- or Ollama-compatible endpoint. Keys can live in an env var or be stored encrypted here.</p>
          <p class="field-hint">Providers you add are <strong>yours alone</strong> — other accounts never see them, and agent runs only ever use your own models. Rows marked <span class="badge badge-muted">👥 shared</span> are platform defaults: everyone can use them until you edit one, which makes it yours.</p>
        </div>
        <div class="flex">
          <button class="btn" onclick="providerTestAll()" title="Run a connection test against every active provider">🩺 Health check</button>
          <button class="btn btn-primary" onclick="openProvider()">＋ Add Provider</button>
        </div>
      </div>

      <div class="stat-grid provider-stats">
        <div class="card stat"><div class="stat-label">Providers</div><div class="stat-value">${counts.all}</div><div class="stat-sub">${counts.active} active · ${counts.inactive} inactive</div></div>
        <div class="card stat"><div class="stat-label">Ready to use</div><div class="stat-value" style="color:var(--ok)">${counts.ready}</div><div class="stat-sub">key resolved &amp; base URL set</div></div>
        <div class="card stat"><div class="stat-label">Needs attention</div><div class="stat-value" style="color:${attention ? "var(--err)" : "var(--text-muted)"}">${attention}</div><div class="stat-sub">${attention ? "missing or unreadable API key" : "everything is configured"}</div></div>
        <div class="card stat"><div class="stat-label">Models attached</div><div class="stat-value">${s.models ?? providersPageCache.reduce((n, p) => n + (p.modelCount || 0), 0)}</div><div class="stat-sub">${s.activeModels ?? providersPageCache.reduce((n, p) => n + (p.activeModelCount || 0), 0)} active · <a href="#/models">open Models</a></div></div>
      </div>

      ${attention ? `<div class="card card-body provider-alert">
        <div><strong>⚠ ${attention} provider(s) cannot connect yet.</strong> Each one is missing a usable API key — open <em>Edit</em> and either point <span class="mono">Secret Ref</span> at an environment variable or paste the key to store it encrypted.</div>
        <button class="btn" onclick="providerSetFilter('attention')">Show them</button>
      </div>` : ""}

      <div class="card card-body provider-toolbar">
        <div class="provider-toolbar-row">
          <div class="search-box"><span class="search-icon">⌕</span>
            <input class="input" id="provider-search" placeholder="Search by name, type, format, URL, secret or status…" autocomplete="off" value="${esc(providerQuery)}" oninput="providerSearch(this.value)"/>
          </div>
          <select class="select provider-sort" id="provider-sort" onchange="providerSetSort(this.value)" title="Sort providers">
            <option value="name" ${providerSort === "name" ? "selected" : ""}>Sort: Name</option>
            <option value="status" ${providerSort === "status" ? "selected" : ""}>Sort: Status</option>
            <option value="models" ${providerSort === "models" ? "selected" : ""}>Sort: Models</option>
            <option value="type" ${providerSort === "type" ? "selected" : ""}>Sort: Type</option>
          </select>
          <button class="btn btn-ghost" id="provider-search-clear" onclick="providerSearchClear()" ${providerQuery.trim() ? "" : "disabled"}>Clear</button>
        </div>
        <div class="filter-chips">
          ${chip("all", "All", counts.all)}
          ${chip("active", "Active", counts.active)}
          ${chip("inactive", "Inactive", counts.inactive)}
          ${chip("ready", "Ready", counts.ready)}
          ${chip("attention", "Needs attention", counts.attention, counts.attention ? "danger" : "")}
        </div>
        <div class="field-hint" id="provider-summary"></div>
      </div>

      <div id="provider-bulkbar"></div>
      <div class="provider-grid" id="provider-grid"></div>`;
    renderProviderList();
  }

  /** Re-render only the list + bulk bar (used by search / filter / sort). */
  function renderProviderList() {
    providersVisibleCache = filteredProviders();
    const grid = $("#provider-grid");
    if (!grid) return;
    grid.innerHTML = providersVisibleCache.length
      ? providersVisibleCache.map(renderProviderCard).join("")
      : `<div class="card card-body" style="grid-column:1/-1">${
          providersPageCache.length
            ? emptyState("🔎", "No matching providers", "Try a different search term, or switch the filter back to “All”.")
            : emptyState("🔌", "No providers yet", "Add your first provider — pick a preset, paste a key, and CodeVia imports its models for you.")
        }</div>`;
    const summary = $("#provider-summary");
    if (summary) {
      const q = providerQuery.trim();
      summary.textContent = providersPageCache.length
        ? `Showing ${providersVisibleCache.length} of ${providersPageCache.length} provider(s)${q ? ` for “${q}”` : ""}${providerFilter !== "all" ? ` · filter: ${providerFilter}` : ""}.`
        : "No providers configured yet.";
    }
    renderProviderBulkBar();
  }

  function renderProviderCard(p) {
    const id = esc(p.id);
    const u = providerUrlHints(p);
    const h = providerHealth(p);
    const open = providerExpanded.has(p.id);
    const selected = providerSelection.has(p.id);
    const models = Number(p.modelCount || 0);
    const activeModels = Number(p.activeModelCount || 0);
    const keyLabel = p.secretValuePresent
      ? `stored key ${esc(p.secretMasked || "••••")}`
      : p.secretRef
        ? `env ${esc(p.secretRef)}`
        : "no key needed";
    return `<section class="card provider-card ${selected ? "row-selected" : ""} health-${h.cls}" data-provider-card="${id}">
      <div class="provider-card-head">
        <label class="provider-check" title="Select this provider">
          <input type="checkbox" data-provider-check ${selected ? "checked" : ""} onchange="providerSelectOne('${id}', this.checked)"/>
        </label>
        <div class="provider-avatar" title="${esc(p.type)}">${providerIcon(p.type)}</div>
        <div class="provider-head-text">
          <strong title="${esc(p.name)}">${esc(p.name)}</strong>
          <div class="provider-head-sub">${esc(p.type)} · ${esc(p.apiFormat)} API · ${esc(p.authType)} auth</div>
        </div>
        <span class="badge badge-${h.cls} provider-health" title="${esc(h.tip)}">${h.icon} ${esc(h.label)}</span>
        ${p.ownerId ? "" : '<span class="badge badge-muted" title="Shared platform provider — every account can see and use it. Editing it makes it yours (your key stays private); duplicate it to keep a personal copy.">👥 shared</span>'}
      </div>

      <div class="provider-facts">
        <span title="API key source">${p.keyPresent ? "🔑" : "🚫"} ${keyLabel}</span>
        <span title="Models attached to this provider">🧠 ${models} model${models === 1 ? "" : "s"}${models ? ` · ${activeModels} active` : ""}</span>
        <span title="Request timeout">⏱ ${Math.round(Number(p.timeoutMs || 0) / 1000)}s</span>
        <span title="Default max tokens">✎ ${Number(p.maxTokensDefault || 0).toLocaleString()} tok</span>
      </div>

      <div class="provider-url" title="${esc(p.baseUrl || "")}"><span class="lbl">Base URL</span><span class="mono">${esc(p.baseUrl || "—")}</span></div>

      ${p.readiness?.ready === false
        ? `<div class="provider-warn">⚠ ${esc(p.readiness.reason)}${p.readiness.hint ? `<div class="provider-warn-hint">${esc(p.readiness.hint)}</div>` : ""}</div>`
        : ""}

      <div class="provider-toggle-row">
        <label class="switch" title="${p.active ? "Deactivate this provider" : "Activate this provider"}">
          <input type="checkbox" ${p.active ? "checked" : ""} onchange="providerToggle('${id}', this.checked)"/>
          <span class="switch-track"><span class="switch-thumb"></span></span>
          <span class="switch-label">${p.active ? "Active" : "Inactive"}</span>
        </label>
        <button class="chev-btn" type="button" title="Show endpoints and details" onclick="providerToggleDetails('${id}')"><span class="chev" style="${open ? "" : "transform:rotate(-90deg)"}">▾</span></button>
      </div>

      <div class="provider-details" ${open ? "" : "hidden"}>
        <div class="meter-row"><span class="lbl">Catalog</span><span class="val mono provider-endpoint" title="${esc(u.catalog)}">${esc(u.catalog)}</span></div>
        <div class="meter-row"><span class="lbl">Chat</span><span class="val mono provider-endpoint" title="${esc(u.chat)}">${esc(u.chat)}</span></div>
        <div class="meter-row"><span class="lbl">Secret ref</span><span class="val mono">${esc(p.secretRef || "—")} ${p.keyPresent ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-err">missing</span>'}</span></div>
        <div class="meter-row"><span class="lbl">Provider ID</span><span class="val mono">${id}</span></div>
        <div class="flex mt" style="flex-wrap:wrap">
          <button class="btn btn-ghost" onclick="providerDuplicate('${id}')">⧉ Duplicate</button>
          ${p.id === "provider-mock" ? "" : `<button class="btn btn-ghost danger-text" onclick="providerDelete('${id}')">🗑 Delete</button>`}
        </div>
      </div>

      <div class="provider-actions">
        <button class="btn" onclick="providerTest('${id}')" title="Call the provider's catalog endpoint now">🩺 Test</button>
        <button class="btn" onclick="providerSyncModels('${id}')" title="Import any catalog models missing from the Models section">⇅ Sync models</button>
        <button class="btn" onclick="providerViewModels('${id}')" title="Show this provider's models">🧠 Models${models ? ` (${models})` : ""}</button>
        <button class="btn" onclick="openProvider('${id}')">✏️ Edit</button>
      </div>
      <div id="prov-test-${id}"></div>
    </section>`;
  }

  /* ---- toolbar handlers ---- */
  window.providerSearch = (value) => {
    providerQuery = value || "";
    const input = $("#provider-search");
    const start = input?.selectionStart ?? providerQuery.length;
    const end = input?.selectionEnd ?? providerQuery.length;
    renderProviderList();
    const clear = $("#provider-search-clear");
    if (clear) clear.disabled = !providerQuery.trim();
    if (input) { input.focus(); try { input.setSelectionRange(start, end); } catch {} }
  };
  window.providerSearchClear = () => { providerQuery = ""; renderProvidersPage(); $("#provider-search")?.focus(); };
  window.providerSetFilter = (key) => { providerFilter = key; renderProvidersPage(); };
  window.providerSetSort = (value) => { providerSort = value; renderProviderList(); };
  window.providerToggleDetails = (id) => {
    if (providerExpanded.has(id)) providerExpanded.delete(id); else providerExpanded.add(id);
    const card = document.querySelector(`[data-provider-card="${CSS.escape(id)}"]`);
    if (!card) return;
    const body = card.querySelector(".provider-details");
    const chev = card.querySelector(".provider-toggle-row .chev");
    if (body) body.hidden = !providerExpanded.has(id);
    if (chev) chev.style.transform = providerExpanded.has(id) ? "" : "rotate(-90deg)";
  };

  /* ---- multi-select + bulk actions ---- */
  window.providerSelectOne = (id, checked) => {
    if (checked) providerSelection.add(id); else providerSelection.delete(id);
    document.querySelector(`[data-provider-card="${CSS.escape(id)}"]`)?.classList.toggle("row-selected", checked);
    renderProviderBulkBar();
  };
  window.providerSelectVisible = (checked) => {
    for (const p of providersVisibleCache) {
      if (checked) providerSelection.add(p.id); else providerSelection.delete(p.id);
    }
    renderProviderList();
  };
  window.providerSelectionClear = () => { providerSelection.clear(); renderProviderList(); };

  function renderProviderBulkBar() {
    const el = $("#provider-bulkbar");
    if (!el) return;
    const n = providerSelection.size;
    if (!n) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="bulk-bar">
      <span><strong>${n}</strong> provider(s) selected</span>
      <div class="flex" style="flex-wrap:wrap">
        <button class="btn" onclick="providerSelectVisible(true)">Select visible (${providersVisibleCache.length})</button>
        <button class="btn" onclick="providerBulk('activate')">✓ Activate</button>
        <button class="btn" onclick="providerBulk('deactivate')">⏸ Deactivate</button>
        <button class="btn" onclick="providerBulk('test')">🩺 Test</button>
        <button class="btn btn-danger" onclick="providerBulk('delete')">🗑 Delete</button>
        <button class="btn btn-ghost" onclick="providerSelectionClear()">Clear</button>
      </div>
    </div>`;
  }

  window.providerBulk = async (action, force = false) => {
    const ids = [...providerSelection];
    if (!ids.length) return;
    if (action === "delete" && !confirm(`Delete ${ids.length} provider(s) and all of their models? This cannot be undone.`)) return;
    try {
      const r = await api("/providers/bulk", { method: "POST", body: { action, ids, force, cascade: action === "delete" } });
      if (action === "test") {
        const okCount = r.results.filter((x) => x.ok).length;
        openModal("🩺 Connection test results", `<div class="group-modal">
          ${r.results.map((x) => `<div class="group-row">
            <div><strong>${esc(x.name)}</strong><div class="field-hint">${esc(x.message)}</div></div>
            <span class="badge badge-${x.ok ? "ok" : "err"}">${x.ok ? "OK" : "failed"}</span>
          </div>`).join("") || emptyState("🩺", "Nothing tested", "")}
          <div class="flex mt" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">Close</button></div>
        </div>`);
        toast(`${okCount}/${r.results.length} provider(s) reachable`, "", okCount === r.results.length ? "ok" : "warn");
        return;
      }
      // Some activations can be refused because the provider has no usable key.
      if (action === "activate" && r.skipped?.length && !force) {
        const names = r.skipped.map((sk) => providersPageCache.find((p) => p.id === sk.id)?.name || sk.id).join(", ");
        if (confirm(`${r.skipped.length} provider(s) are not ready (${names}).\n\nActivate them anyway? They will fail until a key is set.`)) {
          providerSelection.clear();
          for (const sk of r.skipped) providerSelection.add(sk.id);
          return window.providerBulk("activate", true);
        }
      }
      providerSelection.clear();
      const extra = r.skipped?.length ? ` · ${r.skipped.length} skipped` : "";
      toast(`${r.affected} provider(s) ${action === "delete" ? "deleted" : action + "d"}`, extra.trim(), "ok");
      refreshCurrent();
    } catch (e) { toast("Error", e.message, "err"); }
  };

  /* ---- per-provider actions ---- */
  window.providerToggle = async (id, active, force = false) => {
    try {
      await api(`/providers/${id}/${active ? "activate" : "deactivate"}${force ? "?force=true" : ""}`, { method: "POST" });
      toast(active ? "Provider activated" : "Provider deactivated", "", "ok"); refreshCurrent();
    } catch (e) {
      if (active && e.status === 422) {
        const hint = e.body?.hint ? "\n\n" + e.body.hint : "";
        if (confirm(`Cannot activate: ${e.message}${hint}\n\nActivate anyway (it will fail until the key is set)?`)) return window.providerToggle(id, true, true);
        refreshCurrent();
        return;
      }
      toast("Error", e.message, "err");
      refreshCurrent();
    }
  };
  window.providerTest = async (id) => {
    showTestPending("Testing provider", "Checking credentials and reaching the API…");
    try {
      const r = await api(`/providers/${id}/test`, { method: "POST" });
      showTestVerdict(r, { title: r.ok ? "✓ Provider reachable" : "✗ Provider test failed", retry: `providerTest('${id}')` });
    } catch (e) {
      showTestVerdict({ ok: false, message: e.message, hint: e.body?.hint, status: e.status }, { title: "✗ Provider test failed", retry: `providerTest('${id}')` });
    }
  };
  /** Import catalog models that are missing from the Models section. */
  window.providerSyncModels = async (id) => {
    const el = document.getElementById("prov-test-" + id);
    if (el) el.innerHTML = `<div class="test-result">Fetching the provider catalog and importing new models…</div>`;
    try {
      const r = await api(`/providers/${id}/sync-models`, { method: "POST" });
      if (el) el.innerHTML = `<div class="test-result ${r.added ? "ok" : ""}">${r.added ? "✓" : "•"} ${esc(r.message || "")}</div>`;
      toast(r.added ? `${r.added} model(s) imported` : "Nothing new to import", r.message || "", r.added ? "ok" : "");
      refreshCurrent();
    } catch (e) { if (el) el.innerHTML = `<div class="test-result err">✗ ${esc(e.message)}</div>`; toast("Error", e.message, "err"); }
  };
  /** Jump to the Models page pre-filtered to this provider's models. */
  window.providerViewModels = (id) => {
    const p = providersPageCache.find((x) => x.id === id);
    if (p && !p.modelCount) {
      if (confirm(`“${p.name}” has no models yet.\n\nImport them from the provider catalog now?`)) return window.providerSyncModels(id);
      return;
    }
    modelSearchQuery = p ? p.name : "";
    location.hash = "#/models";
  };
  window.providerDuplicate = async (id) => {
    try {
      const p = await api(`/providers/${id}/duplicate`, { method: "POST", body: {} });
      toast("Provider duplicated", `${p.name} — created inactive, review and activate it`, "ok");
      refreshCurrent();
    } catch (e) { toast("Error", e.message, "err"); }
  };
  window.providerDelete = async (id) => {
    const p = providersPageCache.find((x) => x.id === id);
    const models = Number(p?.modelCount || 0);
    if (!confirm(`Delete “${p?.name || id}”?${models ? `\n\nIts ${models} model(s) will be deleted too.` : ""}\n\nThis cannot be undone.`)) return;
    try { await api(`/providers/${id}?cascade=true`, { method: "DELETE" }); toast("Provider deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  /** Test every provider at once and show the results in a modal. */
  window.providerTestAll = async () => {
    const ids = providersPageCache.map((p) => p.id);
    if (!ids.length) { toast("Nothing to test", "Add a provider first", ""); return; }
    toast("Health check running…", `Testing ${ids.length} provider(s)`, "");
    try {
      const r = await api("/providers/bulk", { method: "POST", body: { action: "test", ids } });
      const okCount = r.results.filter((x) => x.ok).length;
      openModal("🩺 Provider health check", `<div class="group-modal">
        <div class="field-hint">${okCount} of ${r.results.length} provider(s) answered successfully.</div>
        ${r.results.map((x) => `<div class="group-row">
          <div><strong>${esc(x.name)}</strong><div class="field-hint">${esc(x.message)}</div></div>
          <span class="badge badge-${x.ok ? "ok" : "err"}">${x.ok ? "OK" : "failed"}</span>
        </div>`).join("")}
        <div class="flex mt" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">Close</button></div>
      </div>`);
      toast(`${okCount}/${r.results.length} provider(s) reachable`, "", okCount === r.results.length ? "ok" : "warn");
    } catch (e) { toast("Error", e.message, "err"); }
  };

  /* ---- Add / Edit provider form ---- */
  window.openProvider = async (editId) => {
    const [meta, existing] = await Promise.all([
      api("/providers/presets").catch(() => ({ types: [], presets: {}, authTypes: ["bearer", "api-key", "none"], apiFormats: ["openai", "anthropic", "gemini", "ollama", "custom"] })),
      editId ? api("/providers/" + editId) : Promise.resolve(null),
    ]);
    const types = meta.types?.length ? meta.types : ["openai", "anthropic", "gemini", "openrouter", "azure-openai", "ollama", "openai-compatible", "custom-http", "mock"];
    const cur = existing || { type: "openai", ...(meta.presets?.openai || {}), name: "" };

    // Step 1 of the form is a visual preset picker — most users only need to
    // click their provider, type a name and paste a key.
    const presetTiles = types.map((t) => {
      const pr = meta.presets?.[t] || {};
      return `<button type="button" class="preset-tile ${t === cur.type ? "active" : ""}" data-preset="${esc(t)}" onclick="providerPickType('${esc(t)}')">
        <span class="preset-icon">${providerIcon(t)}</span>
        <span class="preset-name">${esc(pr.label || t)}</span>
        <span class="preset-sub mono">${esc((pr.baseUrl || "").replace(/^https?:\/\//, "") || "custom endpoint")}</span>
      </button>`;
    }).join("");

    openModal(editId ? `Edit Provider — ${cur.name}` : "Add Provider", `
      <div class="provider-form">
        <div class="form-section">
          <div class="form-section-title">1 · Which provider?</div>
          <div class="preset-grid" id="pv-presets">${presetTiles}</div>
          <select class="select" id="pv-type" hidden>${types.map((t) => `<option value="${esc(t)}" ${t === cur.type ? "selected" : ""}>${esc(meta.presets?.[t]?.label || t)}</option>`).join("")}</select>
        </div>

        <div class="form-section">
          <div class="form-section-title">2 · Name &amp; endpoint</div>
          <div class="field"><label>Display name</label><input class="input" id="pv-name" value="${esc(cur.name || "")}" placeholder="OpenAI (production)"/><div class="field-hint">Only used in the UI — pick something you will recognise, e.g. “OpenRouter (personal key)”.</div></div>
          <div class="field"><label>Base URL</label><input class="input mono" id="pv-base" value="${esc(cur.baseUrl || "")}" placeholder="https://api.openai.com/v1"/><div class="field-hint" id="pv-base-hint"></div></div>
        </div>

        <div class="form-section">
          <div class="form-section-title">3 · Authentication</div>
          <div class="seg" id="pv-key-mode">
            <button type="button" class="seg-btn active" id="pv-mode-env">🔐 Environment variable</button>
            <button type="button" class="seg-btn" id="pv-mode-paste">📋 Paste the key</button>
          </div>
          <div class="field mt" id="pv-env-field">
            <label>Secret Ref <span class="select-count">the NAME of the env var holding the key</span></label>
            <input class="input mono" id="pv-secret" value="${esc(cur.secretRef || "")}" placeholder="OPENAI_API_KEY"/>
            <div class="field-hint" id="pv-secret-hint"></div>
          </div>
          <div class="field mt" id="pv-paste-field" hidden>
            <label>API key <span class="select-count">stored encrypted at rest — survives restarts</span></label>
            <div class="key-input"><input class="input mono" id="pv-value" type="password" placeholder="sk-…" value=""/><button type="button" class="btn btn-ghost key-eye" id="pv-eye" title="Show / hide">👁</button></div>
            <div class="field-hint">${cur.secretValuePresent ? `A key is already stored (${esc(cur.secretMasked || "••••")}). Leave this empty to keep it.` : "The key never leaves this server and is never shown again after saving."}</div>
          </div>
        </div>

        <details class="form-advanced" ${editId ? "" : ""}>
          <summary>Advanced settings</summary>
          <div class="grid-2 mt">
            <div class="field"><label>Auth header style</label><select class="select" id="pv-auth">${(meta.authTypes || ["bearer", "api-key", "none"]).map((a) => `<option ${a === cur.authType ? "selected" : ""}>${a}</option>`).join("")}</select></div>
            <div class="field"><label>API format</label><select class="select" id="pv-format">${(meta.apiFormats || ["openai", "anthropic", "gemini", "ollama", "custom"]).map((a) => `<option ${a === cur.apiFormat ? "selected" : ""}>${a}</option>`).join("")}</select></div>
          </div>
          <div class="grid-2">
            <div class="field"><label>Timeout (ms)</label><input class="input" id="pv-timeout" value="${cur.timeoutMs || 60000}"/></div>
            <div class="field"><label>Max tokens default</label><input class="input" id="pv-maxtok" value="${cur.maxTokensDefault || 4096}"/></div>
          </div>
        </details>

        <div class="field endpoint-preview">
          <label>Endpoints CodeVia will call</label>
          <div class="field-hint mono" id="pv-urls"></div>
        </div>

        <div class="modal-actions">
          <button class="btn" id="pv-test">🩺 Test connection</button>
          <div class="flex">
            <button class="btn" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" id="pv-go">${editId ? "Save changes" : "Create provider"}</button>
          </div>
        </div>
      </div>`);

    // Preset picker keeps the (hidden) select in sync and re-applies defaults.
    window.providerPickType = (t) => {
      $("#pv-type").value = t;
      $$("#pv-presets .preset-tile").forEach((el) => el.classList.toggle("active", el.dataset.preset === t));
      applyPreset();
    };

    const computeUrls = () => providerUrlHints({ baseUrl: $("#pv-base").value, apiFormat: $("#pv-format").value });
    const renderUrls = () => {
      const u = computeUrls();
      $("#pv-urls").innerHTML = `📚 <strong>catalog</strong>: ${esc(u.catalog)}<br>💬 <strong>chat</strong>: ${esc(u.chat)}`;
      const bh = $("#pv-base-hint");
      const v = $("#pv-base").value.trim();
      if (bh) {
        if (!v && $("#pv-type").value !== "mock") { bh.className = "field-hint err"; bh.textContent = "A base URL is required for this provider type."; }
        else if (v && !/^https?:\/\//i.test(v)) { bh.className = "field-hint err"; bh.textContent = "The URL should start with http:// or https://"; }
        else { bh.className = "field-hint"; bh.textContent = "CodeVia adds the documented path suffix for you (/v1, /v1beta, /api/tags …)."; }
      }
    };
    ["#pv-base", "#pv-format", "#pv-type"].forEach((sel) => {
      const el = $(sel); if (!el) return;
      el.addEventListener("input", renderUrls);
      el.addEventListener("change", renderUrls);
    });

    const applyPreset = () => {
      const pr = meta.presets?.[$("#pv-type").value]; if (!pr) return;
      if (!editId) {
        $("#pv-base").value = pr.baseUrl || "";
        $("#pv-secret").value = pr.secretRef || "";
        if (!$("#pv-name").value) $("#pv-name").placeholder = pr.label;
      }
      $("#pv-auth").value = pr.authType; $("#pv-format").value = pr.apiFormat;
      renderUrls();
    };
    $("#pv-type").addEventListener("change", applyPreset);

    // Key mode: env var vs pasted key. Edit mode opens on whichever is in use.
    const setKeyMode = (mode) => {
      const paste = mode === "paste";
      $("#pv-mode-env").classList.toggle("active", !paste);
      $("#pv-mode-paste").classList.toggle("active", paste);
      $("#pv-env-field").hidden = paste;
      $("#pv-paste-field").hidden = !paste;
    };
    $("#pv-mode-env").onclick = () => setKeyMode("env");
    $("#pv-mode-paste").onclick = () => setKeyMode("paste");
    setKeyMode(cur.secretValuePresent && !cur.secretRef ? "paste" : "env");
    $("#pv-eye").onclick = () => {
      const f = $("#pv-value");
      f.type = f.type === "password" ? "text" : "password";
    };

    $("#pv-secret").addEventListener("input", () => {
      const v = $("#pv-secret").value.trim();
      const h = $("#pv-secret-hint");
      if (/^sk-|^[a-z0-9]{24,}$/i.test(v) && !/^[A-Z][A-Z0-9_]*$/.test(v)) {
        h.className = "field-hint err";
        h.textContent = "That looks like the key itself — switch to “Paste the key” to store it securely.";
      } else if (v && !/^[A-Z][A-Z0-9_]*$/i.test(v)) {
        h.className = "field-hint err";
        h.textContent = "This must be an environment variable NAME like OPENAI_API_KEY (not the key value).";
      } else { h.className = "field-hint"; h.textContent = v ? `The server reads process.env.${v}` : "Leave empty if this provider needs no key (e.g. local Ollama)."; }
    });
    renderUrls();
    $("#pv-secret").dispatchEvent(new Event("input"));

    const readForm = () => ({
      name: $("#pv-name").value.trim(),
      type: $("#pv-type").value,
      baseUrl: $("#pv-base").value.trim(),
      secretRef: $("#pv-env-field").hidden ? "" : $("#pv-secret").value.trim(),
      secretValue: $("#pv-value").value.trim(),
      authType: $("#pv-auth").value,
      apiFormat: $("#pv-format").value,
      timeoutMs: Number($("#pv-timeout").value) || 60000,
      maxTokensDefault: Number($("#pv-maxtok").value) || 4096,
    });

    // Test the values currently in the form (draft), never the stored config.
    $("#pv-test").onclick = async () => {
      // Stacks over the form; closing the verdict returns to the filled form.
      showTestPending("Testing connection", "Using the values currently in the form…");
      try {
        const r = await api("/providers/test", { method: "POST", body: { ...readForm(), ...(editId ? { providerId: editId } : {}) } });
        showTestVerdict(r, { title: r.ok ? "✓ Connection OK" : "✗ Connection failed" });
      } catch (e) {
        showTestVerdict({ ok: false, message: e.message, hint: e.body?.hint, status: e.status }, { title: "✗ Connection failed" });
      }
    };
    $("#pv-go").onclick = async () => {
      const body = readForm();
      if (!body.name) { toast("Name required", "Give the provider a display name", "err"); $("#pv-name").focus(); return; }
      if (body.type !== "mock" && !body.baseUrl) { toast("Base URL required", "Enter the provider's API base URL", "err"); $("#pv-base").focus(); return; }
      const btn = $("#pv-go");
      btn.disabled = true; btn.textContent = editId ? "Saving…" : "Creating…";
      try {
        const p = editId ? await api("/providers/" + editId, { method: "PATCH", body }) : await api("/providers", { method: "POST", body });
        closeModal();
        if (p.readiness && p.readiness.ready === false) toast("Provider saved (inactive)", p.readiness.reason + (p.readiness.hint ? " — " + p.readiness.hint : ""), "warn");
        else {
          let detail = p.name + (p.active ? " · active" : "");
          if (typeof p.discoveredModels === "number" && p.discoveredModels > 0) detail += ` · ${p.discoveredModels} model(s) added to Models`;
          toast(editId ? "Provider updated" : "Provider created", detail, "ok");
        }
        refreshCurrent();
      } catch (e) {
        btn.disabled = false; btn.textContent = editId ? "Save changes" : "Create provider";
        toast("Error", e.message, "err");
      }
    };
  };

