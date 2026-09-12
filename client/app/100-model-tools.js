  /* ---------- Unresponsive models — cleanup list ---------- */
  // Models whose benchmark error rate is at/above the threshold (or that never
  // answered once). Tick rows and delete/deactivate them in bulk.
  function computeUnresponsive() {
    const stats = new Map((benchStatsCache || []).map((s) => [s.modelId, s]));
    const rows = [];
    for (const m of modelsCache) {
      const s = stats.get(m.id);
      if (!s) {
        if (unrespIncludeUntested) rows.push({ model: m, stat: null, reason: "never-tested" });
        continue;
      }
      if (s.errorRate >= unrespThreshold || (s.totalAttempts > 0 && s.successAttempts === 0)) {
        rows.push({ model: m, stat: s, reason: s.successAttempts === 0 ? "never-answered" : "high-error" });
      }
    }
    rows.sort((a, b) => ((b.stat?.errorRate || 0) - (a.stat?.errorRate || 0))
      || String(a.model.displayName || "").localeCompare(String(b.model.displayName || "")));
    unrespCache = rows;
    return rows;
  }

  function unrespPageSlice() {
    const rows = unrespCache || [];
    const start = (unrespPage - 1) * unrespPerPage;
    return rows.slice(start, start + unrespPerPage);
  }

  async function renderUnresponsiveTab() {
    const body = $("#models-tab-body");
    if (!body) return;
    body.innerHTML = `<div class="card card-body"><div class="repo-empty">Loading unresponsive models…</div></div>`;
    try {
      const [list, providers, bench] = await Promise.all([
        api("/models"),
        api("/providers").catch(() => []),
        api("/models/benchmark/stats").catch(() => ({ stats: [] })),
      ]);
      modelsCache = list;
      providersCache = providers;
      benchStatsCache = bench.stats || [];
      for (const id of [...modelSelection]) if (!list.some((m) => m.id === id)) modelSelection.delete(id);
      modelVisibleCache = filteredModels();
      updateModelsHeadNote();
    } catch (e) {
      if (modelsTab !== "unresponsive") return;
      body.innerHTML = `<div class="card card-body"><div class="error-state"><h4>Could not load models</h4><pre>${esc(e.message)}</pre><div class="flex mt"><button class="btn btn-primary" onclick="refreshUnresponsive()">Retry</button></div></div></div>`;
      return;
    }
    if (modelsTab !== "unresponsive" || !$("#models-tab-body")) return; // user switched tabs mid-fetch
    computeUnresponsive();
    unrespPage = clampPage(unrespPage, unrespCache.length, unrespPerPage);
    updateModelsTabCounts();
    $("#models-tab-body").innerHTML = unrespCardHtml();
  }

  function unrespReasonBadge(reason) {
    if (reason === "never-answered") return `<span class="badge badge-err">never answered</span>`;
    if (reason === "never-tested") return `<span class="badge badge-muted">never tested</span>`;
    return `<span class="badge badge-warn">high error rate</span>`;
  }

  function unrespCardHtml() {
    const rows = unrespCache || [];
    const pageRows = unrespPageSlice();
    const selectedHere = rows.filter((r) => modelSelection.has(r.model.id)).length;
    const pageSelected = pageRows.length > 0 && pageRows.every((r) => modelSelection.has(r.model.id));
    const thresholds = [[0.2, "≥ 20% errors"], [0.5, "≥ 50% errors"], [0.8, "≥ 80% errors"], [1, "100% errors"]];
    return `<div class="card card-body">
      <div class="card-title">⚠️ Unresponsive models <span class="sub">${rows.length} of ${modelsCache.length} model(s)</span></div>
      <p style="color:var(--text-muted);font-size:12px">Models whose benchmark error rate is at/above the threshold — timeouts, rate limits, HTTP errors or empty replies. Tick the rows and delete or deactivate them in bulk. Run a benchmark first if the list is empty.</p>
      <div class="unresp-controls">
        <label class="unresp-field"><span>Error threshold</span>
          <select class="select" onchange="unrespThresholdSet(Number(this.value))">${thresholds.map(([v, l]) => `<option value="${v}" ${v === unrespThreshold ? "selected" : ""}>${l}</option>`).join("")}</select>
        </label>
        <label class="check" style="margin:0"><input type="checkbox" ${unrespIncludeUntested ? "checked" : ""} onchange="unrespUntestedSet(this.checked)"/> Include never-tested models</label>
        <span class="spacer"></span>
        <button class="btn" onclick="refreshUnresponsive()">↻ Refresh</button>
        <button class="btn" onclick="runModelBenchmark()">🧪 Run benchmark</button>
      </div>
      ${rows.length ? `
      <div class="unresp-bulk">
        <span id="unresp-sel-count"><strong>${selectedHere}</strong> selected</span>
        <div class="flex">
          <button class="btn" onclick="unrespSelectPage(true)">Select page (${pageRows.length})</button>
          <button class="btn" onclick="unrespSelectAll()">Select all (${rows.length})</button>
          <button class="btn" onclick="unrespBulk('deactivate')">⏸ Deactivate selected</button>
          <button class="btn btn-danger" onclick="unrespBulk('delete')">🗑 Delete selected</button>
          <button class="btn btn-ghost" onclick="unrespClearSelection()">Clear</button>
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th style="width:34px"><input type="checkbox" id="unresp-check-all" ${pageSelected ? "checked" : ""} onchange="unrespSelectPage(this.checked)" title="Select this page"/></th><th>Model</th><th>Reason</th><th>Error rate</th><th>Accuracy</th><th>Attempts</th><th>Score</th><th>Last error</th><th>Last tested</th><th></th></tr></thead>
        <tbody>${pageRows.map(({ model: m, stat: s, reason }) => {
          const id = esc(m.id);
          const sel = modelSelection.has(m.id);
          return `<tr data-model="${id}" class="${sel ? "row-selected" : ""}">
            <td><input type="checkbox" data-model-check ${sel ? "checked" : ""} onchange="modelSelectOne('${id}', this.checked)"/></td>
            <td><strong>${esc(m.displayName || m.modelId)}</strong><div class="mono sub">${esc(m.modelId)}</div><div class="sub">${esc(providerNameOf(m.providerId))} · ${m.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}</div></td>
            <td>${unrespReasonBadge(reason)}</td>
            <td>${s ? `<span class="badge badge-${s.errorRate >= 0.8 ? "err" : "warn"}">${(s.errorRate * 100).toFixed(0)}%</span>` : '<span class="badge badge-muted">—</span>'}</td>
            <td>${s && s.accuracy ? `${(s.accuracy * 100).toFixed(0)}%` : "—"}</td>
            <td class="mono">${s ? `${s.successAttempts}/${s.totalAttempts}` : "—"}</td>
            <td class="mono">${s ? s.score.toFixed(3) : "—"}</td>
            <td><span class="unresp-err mono" title="${esc(s?.lastError || "")}">${esc(s?.lastError ? (s.lastError.length > 80 ? s.lastError.slice(0, 80) + "…" : s.lastError) : "—")}</span></td>
            <td class="sub">${s?.lastTestedAt ? timeAgo(s.lastTestedAt) : "—"}</td>
            <td style="white-space:nowrap"><button class="btn btn-ghost" onclick="openModelChat('${id}')">💬 Test</button><button class="btn btn-ghost danger-text" onclick="modelDelete('${id}')">🗑</button></td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
      ${pagerHtml({ total: rows.length, page: unrespPage, perPage: unrespPerPage, pageFn: "unrespPager", perFn: "unrespPerPageSet", perOptions: [10, 15, 25, 50] })}`
      : emptyState("✅", "No unresponsive models", unrespIncludeUntested ? "Every model is below the error threshold." : "Every tested model is below the error threshold. Tick “Include never-tested models” to also list models without benchmark data.")}
    </div>`;
  }

  /** Sync the Unresponsive tab's header checkbox + selected count after a single toggle. */
  function syncUnrespSelectionUI() {
    const rows = unrespCache || [];
    if (!rows.length || modelsTab !== "unresponsive") return;
    const count = $("#unresp-sel-count");
    if (count) count.innerHTML = `<strong>${rows.filter((r) => modelSelection.has(r.model.id)).length}</strong> selected`;
    const all = $("#unresp-check-all");
    if (all) {
      const pageRows = unrespPageSlice();
      const n = pageRows.filter((r) => modelSelection.has(r.model.id)).length;
      all.checked = pageRows.length > 0 && n === pageRows.length;
      all.indeterminate = n > 0 && n < pageRows.length;
    }
  }

  function rerenderUnrespCard() {
    const body = $("#models-tab-body");
    if (body && modelsTab === "unresponsive") body.innerHTML = unrespCardHtml();
  }

  window.unrespThresholdSet = (v) => {
    unrespThreshold = [0.2, 0.5, 0.8, 1].includes(v) ? v : 0.5;
    unrespPage = 1;
    computeUnresponsive();
    updateModelsTabCounts();
    rerenderUnrespCard();
  };
  window.unrespUntestedSet = (checked) => {
    unrespIncludeUntested = !!checked;
    unrespPage = 1;
    computeUnresponsive();
    updateModelsTabCounts();
    rerenderUnrespCard();
  };
  window.unrespPager = (p) => {
    unrespPage = clampPage(p, (unrespCache || []).length, unrespPerPage);
    rerenderUnrespCard();
    $("#models-tab-body")?.scrollIntoView?.({ block: "start" });
  };
  window.unrespPerPageSet = (n) => {
    unrespPerPage = [10, 15, 25, 50].includes(n) ? n : 15;
    unrespPage = 1;
    rerenderUnrespCard();
  };
  window.unrespSelectPage = (checked) => {
    for (const r of unrespPageSlice()) {
      if (checked) modelSelection.add(r.model.id); else modelSelection.delete(r.model.id);
    }
    rerenderUnrespCard();
  };
  window.unrespSelectAll = () => {
    for (const r of (unrespCache || [])) modelSelection.add(r.model.id);
    rerenderUnrespCard();
  };
  window.unrespClearSelection = () => {
    for (const r of (unrespCache || [])) modelSelection.delete(r.model.id);
    rerenderUnrespCard();
  };
  window.refreshUnresponsive = () => {
    if (modelsTab !== "unresponsive") { modelsTab = "unresponsive"; renderModelsPage(); return; }
    renderUnresponsiveTab();
  };
  /** Bulk delete/deactivate scoped to the *selected unresponsive* rows (intersection with the shared selection). */
  window.unrespBulk = async (action) => {
    const ids = (unrespCache || []).map((r) => r.model.id).filter((id) => modelSelection.has(id));
    if (!ids.length) { toast("Nothing selected", "Tick at least one unresponsive model first.", "warn"); return; }
    if (action === "delete" && !confirm(`Delete ${ids.length} unresponsive model(s) from the system? Their benchmark history is removed too.`)) return;
    try {
      const r = await api("/models/bulk", { method: "POST", body: { action, ids } });
      for (const id of ids) modelSelection.delete(id);
      toast(`${r.affected} model(s) ${action === "delete" ? "deleted" : action + "d"}`, "", "ok");
      renderUnresponsiveTab(); // refetch + recompute (stats change after deletes)
    } catch (e) { toast("Error", e.message, "err"); }
  };

  /* ---- Groups modal ---- */
  /**
   * Group modal for ONE provider — opened by clicking the provider name on the
   * Models page. Lists that provider's models with per-row selection and the
   * bulk actions scoped to the group.
   */
  window.openModelGroup = (providerId) => {
    const g = groupModelsByProvider(modelsCache).find((x) => x.providerId === providerId);
    if (!g) { toast("Group not found", "", "err"); return; }
    openModal(`🗂 ${g.name}`, `<div class="group-modal">
      <div class="group-row">
        <div>
          <div class="field-hint mono">${esc(g.providerId)}</div>
          <div style="margin-top:4px"><span class="badge badge-muted">${g.models.length} model(s)</span> <span class="badge badge-${g.active ? "ok" : "muted"}">${g.active} active</span></div>
        </div>
        <div class="flex">
          <button class="btn btn-ghost" onclick="modelGroupSelect('${esc(g.providerId)}')">Select all</button>
          <button class="btn btn-ghost" onclick="modelGroupJump('${esc(g.providerId)}')">Go to group</button>
          <button class="btn btn-ghost" onclick="openModelGroups()">All groups</button>
        </div>
      </div>
      <div class="table-wrap" style="max-height:46vh;overflow:auto"><table><thead><tr>
        <th style="width:34px"></th><th>Model</th><th>Caps</th><th>Active</th><th></th>
      </tr></thead><tbody>
      ${g.models.map((m) => `<tr>
        <td><input type="checkbox" ${modelSelection.has(m.id) ? "checked" : ""} onchange="modelSelectOne('${esc(m.id)}', this.checked)"/></td>
        <td><strong>${esc(m.displayName)}</strong><div class="mono field-hint">${esc(m.modelId)}${tuningBadge(m)}</div></td>
        <td>${capsBadges(m.capabilities) || '<span class="badge badge-muted">—</span>'}</td>
        <td>${m.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn btn-ghost" onclick="openModelChat('${esc(m.id)}')">💬</button>
          <button class="btn btn-ghost" onclick="openModelEdit('${esc(m.id)}')">✏️</button>
        </td></tr>`).join("") || `<tr><td colspan="5">${emptyState("🧠", "No models", "This provider has no models yet.")}</td></tr>`}
      </tbody></table></div>
      <div class="flex mt" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">Close</button></div>
    </div>`);
  };

  window.openModelGroups = () => {
    const groups = groupModelsByProvider(modelsCache);
    openModal("Model Groups by Provider", `<div class="group-modal">
      ${groups.map((g) => `<div class="group-row">
        <div>
          <button class="linkish" onclick="openModelGroup('${esc(g.providerId)}')"><strong>${esc(g.name)}</strong></button>
          <div class="field-hint mono">${esc(g.providerId)}</div>
        </div>
        <div class="flex">
          <span class="badge badge-muted">${g.models.length} model(s)</span>
          <span class="badge badge-${g.active ? "ok" : "muted"}">${g.active} active</span>
          <button class="btn btn-ghost" onclick="modelGroupSelect('${esc(g.providerId)}')">Select all</button>
          <button class="btn btn-ghost" onclick="modelGroupJump('${esc(g.providerId)}')">Go to group</button>
        </div>
      </div>`).join("") || emptyState("🗂", "No groups", "Add a provider and its models first.")}
      <div class="flex mt" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">Close</button></div>
    </div>`);
  };
  window.modelGroupSelect = (providerId) => {
    modelSelection.clear();
    for (const m of modelsCache.filter((x) => (x.providerId || "__none__") === providerId)) modelSelection.add(m.id);
    closeModal();
    refreshCurrent();
  };
  window.modelGroupJump = (providerId) => {
    closeModal();
    if (modelsTab !== "models") { modelsTab = "models"; renderModelsPage(); }
    // The group may live on another page — jump to the page holding its first model.
    const idx = modelVisibleCache.findIndex((m) => (m.providerId || "__none__") === providerId);
    if (idx >= 0) {
      const targetPage = Math.floor(idx / modelsPerPage) + 1;
      if (targetPage !== modelsPage) {
        modelsPage = targetPage;
        const g = $("#model-groups"); if (g) g.innerHTML = modelGroupsInnerHtml();
        const pg = $("#model-pager"); if (pg) pg.innerHTML = modelsPagerHtml();
        const s = $("#model-search-summary"); if (s) s.innerHTML = modelSearchSummary();
      }
    }
    const card = document.querySelector(`.model-group[data-provider="${CSS.escape(providerId)}"]`);
    if (card) {
      card.classList.remove("collapsed");
      modelCollapsedGroups.delete(providerId);
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1200);
    } else if (idx < 0) {
      toast("Group not in this view", "The provider has no models matching the current search.", "warn");
    }
  };

  /* ---- Add model (catalog dropdown OR manual model id) ---- */
  window.openModel = async () => {
    const providers = await api("/providers").catch(() => []);
    openModal("Add Model", `
      <div class="field"><label>Provider</label><select class="select" id="m-prov">${providers.map((p) => `<option value="${esc(p.id)}" ${p.active ? "" : "disabled"}>${esc(p.name)}${p.active ? "" : " (inactive)"}</option>`).join("")}</select></div>
      <div class="field">
        <label>Model source</label>
        <div class="seg">
          <button type="button" class="seg-btn active" id="m-mode-catalog">📚 From catalog</button>
          <button type="button" class="seg-btn" id="m-mode-manual">✍️ Manual Model ID</button>
        </div>
        <div class="field-hint">Some free / preview models are not listed by the provider — use <strong>Manual Model ID</strong> to type any model id by hand.</div>
      </div>
      <div class="field" id="m-catalog-field"><label>Model <span class="select-count">pick from the provider's live catalog — capabilities are detected automatically</span></label>
        <div style="display:flex;gap:6px;align-items:center">
          <select class="select" id="m-id" style="flex:1"></select>
          <button class="btn" id="m-refresh" type="button" title="Re-fetch the catalog from the provider">↻</button>
        </div>
        <div class="field-hint" id="m-catalog-hint">Loading catalog…</div>
      </div>
      <div class="field" id="m-manual-field" hidden><label>Model ID <span class="select-count">exactly as the provider expects it</span></label>
        <input class="input mono" id="m-id-manual" placeholder="e.g. meta-llama/llama-3.3-70b-instruct:free"/>
        <div class="field-hint">Not validated against the catalog — anything you type is saved as-is (a leading <span class="mono">models/</span> is stripped).</div>
      </div>
      <div class="field"><label>Display name <span class="select-count">optional — auto-filled from the model</span></label><input class="input" id="m-name" placeholder=""/></div>
      <div class="grid-2"><div class="field"><label>Context window</label><input class="input" id="m-ctx" value="128000"/></div><div class="field"><label>Priority (lower = preferred)</label><input class="input" id="m-prio" value="100"/></div></div>
      <div id="m-caps-preview" class="field-hint" style="margin-top:-4px">Capabilities (vision / tools / reasoning / structured output / code / streaming) are detected automatically from the model id. Use <strong>Test</strong> to verify the model &amp; see the exact endpoint.</div>
      <div class="flex"><button class="btn" id="m-test">Test model</button><button class="btn btn-primary" id="m-go">Save</button><button class="btn" onclick="closeModal()">Cancel</button></div>
`);

    let mode = "catalog";
    let lastCatalog = [];
    let lastInfo = null;
    // Read the model id from whichever input is active.
    const currentModelId = () => {
      const el = mode === "manual" ? document.getElementById("m-id-manual") : document.getElementById("m-id");
      return (el?.value || "").trim().replace(/^models\//, "");
    };
    const setMode = (next) => {
      mode = next;
      $("#m-mode-catalog").classList.toggle("active", next === "catalog");
      $("#m-mode-manual").classList.toggle("active", next === "manual");
      $("#m-catalog-field").hidden = next !== "catalog";
      $("#m-manual-field").hidden = next !== "manual";
      renderCapsPreview();
    };
    const renderCapsPreview = () => {
      const el = document.getElementById("m-caps-preview");
      const id = currentModelId();
      if (!id) { el.innerHTML = "Pick or type a model id to see its auto-detected capabilities."; return; }
      const detected = lastInfo && lastInfo.id === id ? lastInfo.capabilities : null;
      el.innerHTML = detected ? `Detected capabilities: ${capsBadges(detected)}` : "Capabilities will be auto-detected when the model is saved.";
    };
    // Fetch metadata (context window + capabilities) for the currently typed/picked id.
    let detectTimer = null;
    const detectSelected = () => {
      const id = currentModelId();
      if (!id) { renderCapsPreview(); return; }
      clearTimeout(detectTimer);
      detectTimer = setTimeout(() => {
        api("/models/test", { method: "POST", body: { providerId: $("#m-prov").value, modelId: id } })
          .then((r) => {
            lastInfo = { id, contextWindow: r.contextWindow || 128000, capabilities: r.detectedCapabilities || r.capabilities };
            $("#m-ctx").value = lastInfo.contextWindow;
            if (!$("#m-name").value.trim()) $("#m-name").placeholder = id;
            renderCapsPreview();
          })
          .catch(() => renderCapsPreview());
      }, 350);
    };
    // Turn the catalog <select> into a free-text input when no catalog is available.
    const fallbackToManual = (reason) => {
      setMode("manual");
      $("#m-catalog-hint").innerHTML = reason;
    };
    const loadCatalog = async (providerId) => {
      const hint = $("#m-catalog-hint");
      const sel = $("#m-id");
      if (!sel) return;
      sel.innerHTML = `<option value="">Loading…</option>`;
      hint.textContent = "Loading catalog from provider…";
      try {
        const r = await api(`/providers/${encodeURIComponent(providerId)}/models`);
        lastCatalog = r.models || [];
        if (!r.ok || !lastCatalog.length) {
          sel.innerHTML = `<option value="">— catalog unavailable —</option>`;
          fallbackToManual(`⚠ ${esc(r.message || "The provider returned no models")} — switched to manual entry.`);
          return;
        }
        sel.innerHTML = lastCatalog.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("");
        const first = lastCatalog[0];
        sel.value = first;
        lastInfo = (r.modelInfos || []).find((m) => m.id === first) || null;
        $("#m-ctx").value = lastInfo?.contextWindow || 128000;
        if (!$("#m-name").value.trim()) $("#m-name").placeholder = first;
        hint.innerHTML = `${r.modelInfos?.length ?? lastCatalog.length} model(s) from <span class="mono">${esc(r.catalogUrl || "")}</span> · chat: <span class="mono">${esc(r.chatUrl || "")}</span>`;
        renderCapsPreview();
      } catch (e) {
        sel.innerHTML = `<option value="">— error —</option>`;
        fallbackToManual(`⚠ ${esc(e.message)} — switched to manual entry.`);
      }
    };

    $("#m-mode-catalog").onclick = () => setMode("catalog");
    $("#m-mode-manual").onclick = () => setMode("manual");
    $("#m-id-manual").addEventListener("input", detectSelected);
    $("#m-id").addEventListener("change", detectSelected);
    $("#m-refresh").onclick = () => loadCatalog($("#m-prov").value);
    $("#m-prov").addEventListener("change", () => { if (mode === "catalog") loadCatalog($("#m-prov").value); });

    const initial = providers.find((p) => p.active) || providers[0];
    if (initial) {
      $("#m-prov").value = initial.id;
      await loadCatalog(initial.id);
    } else {
      fallbackToManual("No provider available yet — add a provider first.");
    }

    $("#m-test").onclick = async () => {
      const modelId = currentModelId();
      const providerId = $("#m-prov").value;
      if (!modelId) { toast("Model required", "Pick a model or type a Model ID", "err"); return; }
      if (!providerId) { toast("Provider required", "", "err"); return; }
      // The verdict replaces this dialog, so remember the form to restore it.
      await runModelTest(providerId, modelId);
    };
    $("#m-go").onclick = async () => {
      const modelId = currentModelId();
      if (!modelId) { toast("Model required", "Pick a model or type a Model ID", "err"); return; }
      try {
        const saved = await api("/models", { method: "POST", body: {
          providerId: $("#m-prov").value, modelId, displayName: $("#m-name").value.trim() || modelId,
          contextWindow: Number($("#m-ctx").value) || 128000, priority: Number($("#m-prio").value) || 100,
          // capabilities omitted => auto-detected by the server
        }});
        closeModal();
        if (saved && saved.duplicate) toast("Already registered", saved.message || modelId, "warn");
        else toast("Model added", modelId, "ok");
        refreshModelsData();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };

  window.modelToggle = async (id, active) => {
    try { await api(`/models/${id}/${active ? "activate" : "deactivate"}`, { method: "POST" }); toast(active ? "Model activated" : "Model deactivated", "", "ok"); refreshModelsData(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  window.modelDelete = async (id) => {
    if (!confirm("Delete this model?")) return;
    try { await api(`/models/${id}`, { method: "DELETE" }); modelSelection.delete(id); toast("Model deleted", "", "ok"); refreshModelsData(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  // Default test message (mirrors the server default) — short, cheap, verifiable.
  const MODEL_TEST_MSG = "This is a connectivity test from CodeVia. Reply with exactly: OK";

  /* ---- Streaming chat modal (ChatGPT-style) ---- */
  // Conversation history per model id, so reopening the modal keeps the thread.
  const modelChats = new Map();
  let chatAbort = null;

  window.openModelChat = (id) => {
    const m = modelsCache.find((x) => x.id === id) || {};
    const history = modelChats.get(id) || [];
    const box = $("#chat-modal-backdrop");
    $("#chat-modal-title").textContent = `💬 ${m.displayName || m.modelId || "Model"}`;
    $("#chat-modal-sub").textContent = `${providerNameOf(m.providerId)} · ${m.modelId || ""}`;
    $("#chat-modal-body").innerHTML = `
      <div class="chat-thread" id="chat-thread"></div>
      <div class="chat-meta" id="chat-meta"></div>
      <div class="chat-composer">
        <div class="chat-composer-bar">
          <textarea class="chat-input" id="chat-input" rows="1" dir="auto" placeholder="پیام خود را بنویسید… / Send a natural message…"></textarea>
          <button class="chat-send-btn" id="chat-send" aria-label="Send" title="Send">➤</button>
        </div>
        <div class="chat-composer-actions">
          <span class="field-hint">Replies stream in token by token.</span>
          <div class="flex">
            <button class="btn btn-ghost" id="chat-clear">Clear</button>
            <button class="btn" id="chat-stop" hidden>■ Stop</button>
          </div>
        </div>
      </div>`;
    box.hidden = false;
    box.dataset.modelId = id;
    renderChatThread(history);
    $("#chat-send").onclick = () => sendChatMessage(id);
    $("#chat-clear").onclick = () => { modelChats.set(id, []); renderChatThread([]); $("#chat-meta").textContent = ""; };
    $("#chat-stop").onclick = () => { if (chatAbort) chatAbort.abort(); };
    const input = $("#chat-input");
    input.addEventListener("input", () => applyTextDirection(input, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(id); }
    });
    setTimeout(() => input.focus(), 30);
  };
  window.closeModelChat = () => {
    if (chatAbort) chatAbort.abort();
    const box = $("#chat-modal-backdrop");
    if (box) box.hidden = true;
  };

  function renderChatThread(history) {
    const thread = $("#chat-thread");
    if (!thread) return;
    thread.innerHTML = history.length
      ? history.map((m) => chatBubble(m.role, m.content)).join("")
      : `<div class="chat-empty">Ask this model anything — the answer streams in like a normal chat.</div>`;
    thread.scrollTop = thread.scrollHeight;
  }
  function applyTextDirection(el, text) {
    if (!el) return;
    const dir = dirForText(text);
    el.setAttribute("dir", dir);
    el.classList.toggle("rtl", dir === "rtl");
    el.classList.toggle("ltr", dir !== "rtl");
  }
  function chatBubble(role, content, id = "") {
    const dir = dirForText(content);
    return `<div class="chat-msg ${role} ${dir}" dir="${dir}"${id ? ` id="${id}"` : ""}><div class="chat-role">${role === "user" ? "شما" : "مدل"}</div><div class="chat-text" dir="${dir}">${esc(content)}</div></div>`;
  }

  /**
   * POST the conversation to /models/:id/stream and consume the SSE frames,
   * appending each `delta` to the assistant bubble as it arrives.
   */
  async function sendChatMessage(id) {
    const input = $("#chat-input");
    const text = (input?.value || "").trim();
    if (!text) { toast("Empty message", "Type something to send.", "err"); return; }
    const history = modelChats.get(id) || [];
    history.push({ role: "user", content: text });
    modelChats.set(id, history);
    input.value = "";
    applyTextDirection(input, "");
    renderChatThread(history);

    const thread = $("#chat-thread");
    const bubbleId = "chat-live-" + Date.now();
    thread.insertAdjacentHTML("beforeend", chatBubble("assistant", "", bubbleId));
    const liveEl = document.getElementById(bubbleId);
    const textEl = liveEl.querySelector(".chat-text");
    applyTextDirection(liveEl, "");
    applyTextDirection(textEl, "");
    textEl.innerHTML = `<span class="chat-cursor">▍</span>`;
    thread.scrollTop = thread.scrollHeight;

    $("#chat-send").disabled = true;
    $("#chat-stop").hidden = false;
    chatAbort = new AbortController();
    let acc = "";
    try {
      const res = await fetch(`/models/${encodeURIComponent(id)}/stream`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ messages: history }),
        signal: chatAbort.signal,
      });
      if (!res.ok || !res.body) {
        let msg = res.statusText;
        try { const b = await res.json(); msg = b.message || b.error || msg; } catch (_) {}
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          if (ev.type === "meta") {
            $("#chat-meta").innerHTML = `→ <span class="mono">${esc(ev.url)}</span>`;
          } else if (ev.type === "delta") {
            acc += ev.text;
            applyTextDirection(liveEl, acc);
            applyTextDirection(textEl, acc);
            textEl.innerHTML = `${esc(acc)}<span class="chat-cursor">▍</span>`;
            thread.scrollTop = thread.scrollHeight;
          } else if (ev.type === "done") {
            acc = ev.text || acc;
            applyTextDirection(liveEl, acc);
            applyTextDirection(textEl, acc);
            textEl.textContent = acc || "(empty reply)";
            $("#chat-meta").innerHTML += ` · ${ev.latencyMs}ms${ev.status ? " · HTTP " + ev.status : ""}`;
          } else if (ev.type === "error") {
            const msg = ev.message + (ev.hint ? "\n" + ev.hint : "");
            liveEl.classList.add("err");
            applyTextDirection(liveEl, msg);
            applyTextDirection(textEl, msg);
            textEl.textContent = msg;
            acc = "";
          }
        }
      }
    } catch (e) {
      if (e.name === "AbortError") {
        const msg = acc ? acc + " …(stopped)" : "(stopped)";
        applyTextDirection(liveEl, msg);
        applyTextDirection(textEl, msg);
        textEl.textContent = msg;
      } else {
        const msg = "✗ " + e.message;
        liveEl.classList.add("err");
        applyTextDirection(liveEl, msg);
        applyTextDirection(textEl, msg);
        textEl.textContent = msg;
        acc = "";
      }
    } finally {
      $("#chat-send").disabled = false;
      $("#chat-stop").hidden = true;
      chatAbort = null;
      // Persist a successful reply into the thread history for multi-turn context.
      if (acc) {
        history.push({ role: "assistant", content: acc });
        modelChats.set(id, history);
      }
      const cursor = textEl.querySelector(".chat-cursor");
      if (cursor) cursor.remove();
    }
  }

